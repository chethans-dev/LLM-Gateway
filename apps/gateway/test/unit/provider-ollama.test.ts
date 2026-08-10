import { describe, expect, it } from "vitest";
import { OllamaProvider } from "../../src/providers/ollama.js";
import type { ChatChunk, ChatRequest } from "../../src/providers/types.js";
import {
  errorResponse,
  fakeFetch,
  jsonResponse,
  ndjsonResponse,
  neverAbortedOptions,
} from "../helpers/fake-fetch.js";

const baseUrl = "http://localhost:11434";

function provider(http: ReturnType<typeof fakeFetch>) {
  return new OllamaProvider({ baseUrl, fetch: http.fetch });
}

const request: ChatRequest = {
  model: "qwen3",
  messages: [
    { role: "system", content: "Be terse." },
    { role: "user", content: "Explain Redis Pub/Sub" },
  ],
};

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("OllamaProvider request translation", () => {
  it("posts to /api/chat with no credentials", async () => {
    // Ollama binds to localhost and has no key — which is also why it is enabled
    // only when OLLAMA_BASE_URL is explicitly set.
    const http = fakeFetch(jsonResponse({ message: { content: "" } }));

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().url).toBe(`${baseUrl}/api/chat`);
    expect(http.lastCall().headers).not.toHaveProperty("authorization");
  });

  it("passes system messages through, since Ollama handles the role natively", async () => {
    const http = fakeFetch(jsonResponse({ message: { content: "" } }));

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().body["messages"]).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Explain Redis Pub/Sub" },
    ]);
  });

  it("nests sampling parameters under options with Ollama's names", async () => {
    const http = fakeFetch(jsonResponse({ message: { content: "" } }));

    await provider(http).chat(
      { ...request, temperature: 0.3, maxOutputTokens: 128, stop: ["END"] },
      neverAbortedOptions(),
    );

    expect(http.lastCall().body["options"]).toEqual({
      temperature: 0.3,
      num_predict: 128,
      stop: ["END"],
    });
  });

  it("omits options entirely when nothing was set", async () => {
    const http = fakeFetch(jsonResponse({ message: { content: "" } }));

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().body).not.toHaveProperty("options");
  });
});

describe("OllamaProvider response translation", () => {
  it("maps the message, finish reason and token counts", async () => {
    const http = fakeFetch(
      jsonResponse({
        model: "qwen3",
        created_at: "2026-08-01T10:00:00Z",
        message: { role: "assistant", content: "Redis Pub/Sub is..." },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 30,
        eval_count: 9,
      }),
    );

    const response = await provider(http).chat(request, neverAbortedOptions());

    expect(response.content).toBe("Redis Pub/Sub is...");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 30, outputTokens: 9, totalTokens: 39 });
    expect(response.createdAt).toBe(Math.floor(Date.parse("2026-08-01T10:00:00Z") / 1000));
  });

  it("leaves the response id empty rather than inventing one", async () => {
    // Ollama issues no response identifier; a fabricated one would be worse
    // than an absent one when cross-referencing logs.
    const http = fakeFetch(jsonResponse({ message: { content: "hi" } }));

    expect((await provider(http).chat(request, neverAbortedOptions())).id).toBe("");
  });
});

describe("OllamaProvider streaming", () => {
  it("parses newline-delimited JSON rather than SSE", async () => {
    const http = fakeFetch(
      ndjsonResponse([
        { model: "qwen3", message: { content: "Redis " }, done: false },
        { model: "qwen3", message: { content: "Pub/Sub" }, done: false },
        {
          model: "qwen3",
          message: { content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 30,
          eval_count: 9,
        },
      ]),
    );

    const chunks = await collect(provider(http).stream(request, neverAbortedOptions()));

    expect(chunks[0]).toEqual({ type: "start", id: "", provider: "ollama", model: "qwen3" });
    expect(
      chunks
        .filter((c): c is Extract<ChatChunk, { type: "delta" }> => c.type === "delta")
        .map((c) => c.content)
        .join(""),
    ).toBe("Redis Pub/Sub");
    expect(chunks[chunks.length - 1]).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 30, outputTokens: 9, totalTokens: 39 },
    });
  });
});

describe("OllamaProvider errors", () => {
  it("normalizes an unreachable daemon to a retryable UNAVAILABLE", async () => {
    // The common local failure: Ollama simply is not running.
    const http = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(provider(http).chat(request, neverAbortedOptions())).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      provider: "ollama",
    });
  });

  it("normalizes a missing model", async () => {
    const http = fakeFetch(errorResponse({ error: 'model "qwen3" not found' }, 404));

    await expect(provider(http).chat(request, neverAbortedOptions())).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
      message: 'model "qwen3" not found',
    });
  });
});
