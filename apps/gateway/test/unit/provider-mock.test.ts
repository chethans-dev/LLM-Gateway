import { describe, expect, it, vi } from "vitest";
import { MockProvider, parseBehaviour } from "../../src/providers/mock.js";
import type { ChatChunk, ChatRequest } from "../../src/providers/types.js";
import { rejection } from "../helpers/expect-error.js";
import { neverAbortedOptions } from "../helpers/fake-fetch.js";

function request(model: string, content = "Explain Redis Pub/Sub"): ChatRequest {
  return { model, messages: [{ role: "user", content }] };
}

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("parseBehaviour", () => {
  it("reads the behaviour from the model suffix", () => {
    expect(parseBehaviour("mock/rate-limited")).toBe("rate-limited");
    expect(parseBehaviour("mock/timeout")).toBe("timeout");
  });

  it("defaults to success for a plain or unrecognised model name", () => {
    // `mock/llama3` is an ordinary model name, not a typo to reject.
    expect(parseBehaviour("mock")).toBe("success");
    expect(parseBehaviour("mock/llama3")).toBe("success");
  });
});

describe("MockProvider success paths", () => {
  it("returns a completion with plausible usage", async () => {
    const response = await new MockProvider().chat(request("mock"), neverAbortedOptions());

    expect(response.provider).toBe("mock");
    expect(response.model).toBe("mock");
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.finishReason).toBe("stop");
    expect(response.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("echoes the last user message in echo mode", async () => {
    // Makes end-to-end assertions readable: the expected output is the input.
    const response = await new MockProvider().chat(
      { model: "mock/echo", messages: [{ role: "user", content: "ping" }] },
      neverAbortedOptions(),
    );

    expect(response.content).toBe("ping");
  });

  it("ignores system messages when choosing the echoed turn", async () => {
    const response = await new MockProvider().chat(
      {
        model: "mock/echo",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "ping" },
        ],
      },
      neverAbortedOptions(),
    );

    expect(response.content).toBe("ping");
  });
});

describe("MockProvider failure behaviours", () => {
  const cases = [
    { model: "mock/rate-limited", code: "RATE_LIMITED", retryable: true },
    { model: "mock/server-error", code: "PROVIDER_ERROR", retryable: true },
    { model: "mock/unavailable", code: "UNAVAILABLE", retryable: true },
    { model: "mock/invalid", code: "INVALID_REQUEST", retryable: false },
    { model: "mock/auth-error", code: "AUTHENTICATION_ERROR", retryable: false },
    { model: "mock/model-not-found", code: "MODEL_NOT_FOUND", retryable: false },
  ] as const;

  for (const { model, code, retryable } of cases) {
    it(`${model} produces a ${code} that is ${retryable ? "" : "not "}retryable`, async () => {
      const error = await rejection(new MockProvider().chat(request(model), neverAbortedOptions()));

      expect(error.code).toBe(code);
      // This is what the router reads to decide whether to fail over (spec §8).
      expect(error.retryable).toBe(retryable);
      expect(error.provider).toBe("mock");
    });
  }

  it("fails before yielding any chunk when streaming", async () => {
    // Real providers report a 429 as a response status, not mid-stream.
    await expect(
      collect(new MockProvider().stream(request("mock/rate-limited"), neverAbortedOptions())),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("hangs until aborted for mock/timeout", async () => {
    const error = await rejection(
      new MockProvider().chat(request("mock/timeout"), { signal: AbortSignal.timeout(25) }),
    );

    expect(error.code).toBe("TIMEOUT");
  });

  it("injects random failures at the configured rate", async () => {
    // Deterministic: the RNG is injected, so this is not a flaky test.
    const alwaysFails = new MockProvider({ failureRate: 0.5, random: () => 0.1 });
    const neverFails = new MockProvider({ failureRate: 0.5, random: () => 0.9 });

    await expect(alwaysFails.chat(request("mock"), neverAbortedOptions())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    await expect(neverFails.chat(request("mock"), neverAbortedOptions())).resolves.toBeDefined();
  });
});

describe("MockProvider streaming", () => {
  it("yields start, then deltas, then finish", async () => {
    const chunks = await collect(
      new MockProvider({ responseText: "hello there world" }).stream(
        request("mock"),
        neverAbortedOptions(),
      ),
    );

    expect(chunks[0]?.type).toBe("start");
    expect(chunks[chunks.length - 1]?.type).toBe("finish");
    expect(chunks.filter((c) => c.type === "delta").length).toBeGreaterThan(1);
  });

  it("reassembles to exactly the full completion", async () => {
    const chunks = await collect(
      new MockProvider({ responseText: "hello there world" }).stream(
        request("mock"),
        neverAbortedOptions(),
      ),
    );

    const text = chunks
      .filter((chunk): chunk is Extract<ChatChunk, { type: "delta" }> => chunk.type === "delta")
      .map((chunk) => chunk.content)
      .join("");

    expect(text).toBe("hello there world");
  });

  it("reports usage on the finish chunk", async () => {
    const chunks = await collect(new MockProvider().stream(request("mock"), neverAbortedOptions()));
    const finish = chunks[chunks.length - 1];

    expect(finish?.type).toBe("finish");
    if (finish?.type === "finish") expect(finish.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("stops mid-stream when aborted", async () => {
    const provider = new MockProvider();
    const controller = new AbortController();

    await expect(async () => {
      for await (const chunk of provider.stream(request("mock"), { signal: controller.signal })) {
        if (chunk.type === "delta") controller.abort();
      }
    }).rejects.toThrow();
  });
});

describe("MockProvider latency", () => {
  it("applies the configured latency through the injected clock", async () => {
    // Injected so the suite stays fast; spec §17 requires configurable latency.
    const sleep = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(async () => {});
    const provider = new MockProvider({ latencyMs: 500, sleep });

    await provider.chat(request("mock"), neverAbortedOptions());

    expect(sleep).toHaveBeenCalledWith(500, expect.anything());
  });
});
