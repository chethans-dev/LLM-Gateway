import { describe, expect, it } from "vitest";
import { LLMError } from "@openllm/core";
import type { LLMProvider } from "../../src/providers/provider.js";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ProviderCallOptions,
  ProviderCapabilities,
} from "../../src/providers/types.js";
import { createTokenUsage } from "../../src/providers/usage.js";

/**
 * Exercises the LLMProvider contract without shipping a provider.
 *
 * Phase 2 is mostly types, and types alone prove nothing at runtime. This stub
 * lives in test scope so the "no provider implementations in Phase 2" boundary
 * holds, while still proving the interface is actually implementable and that
 * its streaming and cancellation semantics behave as documented. The real
 * MockProvider lands in Phase 3.
 */
class StubProvider implements LLMProvider {
  readonly id = "mock" as const;
  /** Set by the stream generator's `finally`, to prove cleanup runs. */
  cleanedUp = false;

  getCapabilities(): ProviderCapabilities {
    return {
      provider: "mock",
      streaming: true,
      systemPrompt: true,
      maxOutputTokens: 4096,
      usageReporting: { nonStreaming: true, streaming: true },
    };
  }

  async chat(request: ChatRequest, options: ProviderCallOptions): Promise<ChatResponse> {
    options.signal.throwIfAborted();
    return {
      id: "resp_stub",
      provider: this.id,
      model: request.model,
      content: "hello world",
      finishReason: "stop",
      usage: createTokenUsage(9, 2),
      createdAt: 1_700_000_000,
    };
  }

  async *stream(request: ChatRequest, options: ProviderCallOptions): AsyncIterable<ChatChunk> {
    try {
      yield { type: "start", id: "resp_stub", provider: this.id, model: request.model };

      for (const word of ["hello", " ", "world"]) {
        options.signal.throwIfAborted();
        yield { type: "delta", content: word };
      }

      yield { type: "finish", finishReason: "stop", usage: createTokenUsage(9, 2) };
    } finally {
      this.cleanedUp = true;
    }
  }
}

const request: ChatRequest = {
  model: "stub-model",
  messages: [{ role: "user", content: "hi" }],
};

function neverAborted(): ProviderCallOptions {
  return { signal: new AbortController().signal };
}

/**
 * Compile-time exhaustiveness guard.
 *
 * The `never` assignment fails the build if a ChatChunk variant is ever added
 * without every consumer being updated — which is precisely the bug that would
 * otherwise surface as chunks silently vanishing from a stream in Phase 5.
 */
function renderChunk(chunk: ChatChunk): string {
  switch (chunk.type) {
    case "start":
      return `start:${chunk.model}`;
    case "delta":
      return chunk.content;
    case "finish":
      return `finish:${chunk.finishReason}`;
    default: {
      const unhandled: never = chunk;
      return unhandled;
    }
  }
}

describe("LLMProvider contract", () => {
  it("is implementable and returns a normalized response", async () => {
    const provider = new StubProvider();

    const response = await provider.chat(request, neverAborted());

    expect(response.provider).toBe("mock");
    expect(response.model).toBe("stub-model");
    expect(response.content).toBe("hello world");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 9, outputTokens: 2, totalTokens: 11 });
  });

  it("describes its capabilities without any network call", () => {
    // getCapabilities is read on hot paths, so it must stay synchronous.
    const capabilities = new StubProvider().getCapabilities();

    expect(capabilities.streaming).toBe(true);
    expect(capabilities.usageReporting.streaming).toBe(true);
  });

  it("streams start, then deltas, then finish", async () => {
    const provider = new StubProvider();
    const chunks: ChatChunk[] = [];

    for await (const chunk of provider.stream(request, neverAborted())) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.type)).toEqual(["start", "delta", "delta", "delta", "finish"]);
    expect(chunks.map(renderChunk).join("")).toBe("start:stub-modelhello worldfinish:stop");
  });

  it("carries the serving model on the start chunk", async () => {
    // Under fallback the caller cannot predict which model answered, and the
    // streamed response has no other place to report it.
    const provider = new StubProvider();

    const [first] = [...(await collect(provider.stream(request, neverAborted())))];

    expect(first).toEqual({
      type: "start",
      id: "resp_stub",
      provider: "mock",
      model: "stub-model",
    });
  });

  it("stops when the call is aborted mid-stream", async () => {
    // This is the timeout and client-disconnect path: the signal must actually
    // stop the provider, not merely abandon a promise while it keeps generating.
    const provider = new StubProvider();
    const controller = new AbortController();
    const received: ChatChunk[] = [];

    await expect(async () => {
      for await (const chunk of provider.stream(request, { signal: controller.signal })) {
        received.push(chunk);
        if (chunk.type === "delta") controller.abort();
      }
    }).rejects.toThrow();

    expect(received.map((c) => c.type)).toEqual(["start", "delta"]);
  });

  it("runs cleanup when the consumer breaks out early", async () => {
    // A client that disconnects mid-response must not leak the upstream
    // connection. `for await` calls the generator's return(), running `finally`.
    const provider = new StubProvider();

    for await (const chunk of provider.stream(request, neverAborted())) {
      if (chunk.type === "delta") break;
    }

    expect(provider.cleanedUp).toBe(true);
  });

  it("rejects an aborted call before doing any work", async () => {
    const provider = new StubProvider();
    const controller = new AbortController();
    controller.abort();

    await expect(provider.chat(request, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("provider error normalization", () => {
  it("routes fallback decisions from the error code, never from provider text", () => {
    // A provider that leaks a raw fetch TypeError makes itself unroutable: the
    // router has nothing to decide retryability from.
    const rateLimited = LLMError.rateLimited("429 from upstream", { provider: "mock" });
    const badRequest = LLMError.invalidRequest("unknown parameter", { provider: "mock" });

    expect(rateLimited.retryable).toBe(true);
    expect(badRequest.retryable).toBe(false);
    expect(rateLimited.provider).toBe("mock");
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
