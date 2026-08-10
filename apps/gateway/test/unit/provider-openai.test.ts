import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/providers/openai.js";
import type { ChatChunk, ChatRequest } from "../../src/providers/types.js";
import {
  errorResponse,
  fakeFetch,
  jsonResponse,
  neverAbortedOptions,
  sseResponse,
} from "../helpers/fake-fetch.js";

const baseUrl = "https://api.openai.test/v1";

function provider(fetch: ReturnType<typeof fakeFetch>) {
  return new OpenAIProvider({ apiKey: "sk-test", baseUrl, fetch: fetch.fetch });
}

const request: ChatRequest = {
  model: "gpt-4.1-mini",
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

describe("OpenAIProvider request translation", () => {
  it("posts to the configured base URL with bearer auth", async () => {
    // Base URL is configuration so this adapter also serves any
    // OpenAI-compatible endpoint (vLLM, LM Studio, an internal proxy).
    const http = fakeFetch(jsonResponse({ choices: [{ message: { content: "" } }] }));

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().url).toBe(`${baseUrl}/chat/completions`);
    expect(http.lastCall().headers["authorization"]).toBe("Bearer sk-test");
  });

  it("passes system messages through in the array", async () => {
    // OpenAI is the one provider that does NOT need the system prompt hoisted.
    const http = fakeFetch(jsonResponse({ choices: [{ message: { content: "" } }] }));

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().body["messages"]).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Explain Redis Pub/Sub" },
    ]);
  });

  it("uses max_completion_tokens rather than the legacy max_tokens", async () => {
    // OpenAI rejects max_tokens outright on reasoning models.
    const http = fakeFetch(jsonResponse({ choices: [{ message: { content: "" } }] }));

    await provider(http).chat({ ...request, maxOutputTokens: 256 }, neverAbortedOptions());

    expect(http.lastCall().body["max_completion_tokens"]).toBe(256);
    expect(http.lastCall().body).not.toHaveProperty("max_tokens");
  });

  it("omits sampling parameters that were not set", async () => {
    // Sending explicit nulls overrides provider defaults with worse ones.
    const http = fakeFetch(jsonResponse({ choices: [{ message: { content: "" } }] }));

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().body).not.toHaveProperty("temperature");
    expect(http.lastCall().body).not.toHaveProperty("top_p");
  });

  it("requests usage on streamed responses", async () => {
    // Without stream_options.include_usage, OpenAI reports no tokens at all and
    // every streamed request becomes uncosted.
    const http = fakeFetch(sseResponse(["[DONE]"]));

    await collect(provider(http).stream(request, neverAbortedOptions()));

    expect(http.lastCall().body["stream"]).toBe(true);
    expect(http.lastCall().body["stream_options"]).toEqual({ include_usage: true });
  });
});

describe("OpenAIProvider response translation", () => {
  it("maps a completion, its finish reason and its usage", async () => {
    const http = fakeFetch(
      jsonResponse({
        id: "chatcmpl-123",
        model: "gpt-4.1-mini-2025-04-14",
        created: 1_700_000_000,
        choices: [{ message: { content: "Redis Pub/Sub is..." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 824, completion_tokens: 214 },
      }),
    );

    const response = await provider(http).chat(request, neverAbortedOptions());

    expect(response.id).toBe("chatcmpl-123");
    // The model that actually served it, not what was asked for.
    expect(response.model).toBe("gpt-4.1-mini-2025-04-14");
    expect(response.content).toBe("Redis Pub/Sub is...");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 824, outputTokens: 214, totalTokens: 1038 });
  });

  it("maps a truncated response to length", async () => {
    const http = fakeFetch(
      jsonResponse({ choices: [{ message: { content: "..." }, finish_reason: "length" }] }),
    );

    expect((await provider(http).chat(request, neverAbortedOptions())).finishReason).toBe("length");
  });

  it("reports usage as unknown rather than zero when absent", async () => {
    const http = fakeFetch(jsonResponse({ choices: [{ message: { content: "hi" } }] }));

    expect((await provider(http).chat(request, neverAbortedOptions())).usage).toBeUndefined();
  });

  it("errors when the provider returns no choices", async () => {
    const http = fakeFetch(jsonResponse({ choices: [] }));

    await expect(provider(http).chat(request, neverAbortedOptions())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });
});

describe("OpenAIProvider errors", () => {
  it("normalizes a 429 into a retryable rate limit", async () => {
    const http = fakeFetch(
      errorResponse({ error: { message: "Rate limit reached" } }, 429, { "retry-after": "2" }),
    );

    await expect(provider(http).chat(request, neverAbortedOptions())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      provider: "openai",
    });
  });

  it("normalizes a 401 into a non-retryable auth error", async () => {
    const http = fakeFetch(errorResponse({ error: { message: "Invalid API key" } }, 401));

    await expect(provider(http).chat(request, neverAbortedOptions())).rejects.toMatchObject({
      code: "AUTHENTICATION_ERROR",
      retryable: false,
    });
  });
});

describe("OpenAIProvider streaming", () => {
  it("emits start, deltas and finish, and stops at [DONE]", async () => {
    const http = fakeFetch(
      sseResponse([
        JSON.stringify({ id: "chatcmpl-1", model: "gpt-4.1-mini", choices: [{ delta: {} }] }),
        JSON.stringify({ choices: [{ delta: { content: "Redis " } }] }),
        JSON.stringify({ choices: [{ delta: { content: "Pub/Sub" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
        "[DONE]",
      ]),
    );

    const chunks = await collect(provider(http).stream(request, neverAbortedOptions()));

    expect(chunks[0]).toEqual({
      type: "start",
      id: "chatcmpl-1",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect(
      chunks
        .filter((c): c is Extract<ChatChunk, { type: "delta" }> => c.type === "delta")
        .map((c) => c.content)
        .join(""),
    ).toBe("Redis Pub/Sub");
    expect(chunks[chunks.length - 1]).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
  });

  it("still emits start and finish when the stream is empty", async () => {
    // Contract: exactly one start and one finish, whatever the provider sent.
    const http = fakeFetch(sseResponse(["[DONE]"]));

    const chunks = await collect(provider(http).stream(request, neverAbortedOptions()));

    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
  });

  it("normalizes a malformed stream event", async () => {
    const http = fakeFetch(sseResponse(["{not json"]));

    await expect(collect(provider(http).stream(request, neverAbortedOptions()))).rejects.toMatchObject(
      { code: "PROVIDER_ERROR" },
    );
  });

  it("surfaces a pre-stream error status as a normalized error", async () => {
    const http = fakeFetch(errorResponse({ error: { message: "overloaded" } }, 503));

    await expect(
      collect(provider(http).stream(request, neverAbortedOptions())),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
});
