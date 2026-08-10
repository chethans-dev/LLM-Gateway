import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../../src/providers/gemini.js";
import type { ChatChunk, ChatRequest } from "../../src/providers/types.js";
import {
  errorResponse,
  fakeFetch,
  jsonResponse,
  neverAbortedOptions,
  sseResponse,
} from "../helpers/fake-fetch.js";

const baseUrl = "https://generativelanguage.test/v1beta";

function provider(http: ReturnType<typeof fakeFetch>) {
  return new GeminiProvider({ apiKey: "gemini-key", baseUrl, fetch: http.fetch });
}

const request: ChatRequest = {
  model: "gemini-2.5-flash",
  messages: [
    { role: "system", content: "Be terse." },
    { role: "user", content: "Explain Redis Pub/Sub" },
  ],
};

const emptyResponse = () => jsonResponse({ candidates: [] });

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("GeminiProvider request translation", () => {
  it("puts the model in the URL path and the key in a header", async () => {
    // Header rather than the `?key=` query parameter Google's quickstarts use:
    // a key in a URL leaks into access logs, proxy logs and error messages.
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().url).toBe(`${baseUrl}/models/gemini-2.5-flash:generateContent`);
    expect(http.lastCall().headers["x-goog-api-key"]).toBe("gemini-key");
    expect(http.lastCall().url).not.toContain("key=");
  });

  it("uses the SSE streaming endpoint", async () => {
    const http = fakeFetch(sseResponse([]));

    await collect(provider(http).stream(request, neverAbortedOptions()));

    expect(http.lastCall().url).toBe(
      `${baseUrl}/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
    );
  });

  it("tolerates a models/ prefix on the model name", async () => {
    const http = fakeFetch(emptyResponse());

    await provider(http).chat({ ...request, model: "models/gemini-2.5-flash" }, neverAbortedOptions());

    expect(http.lastCall().url).toBe(`${baseUrl}/models/gemini-2.5-flash:generateContent`);
  });

  it("renames the assistant role to model and wraps content in parts", async () => {
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(
      {
        model: "gemini-2.5-flash",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "again" },
        ],
      },
      neverAbortedOptions(),
    );

    expect(http.lastCall().body["contents"]).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: "again" }] },
    ]);
  });

  it("lifts the system prompt into systemInstruction", async () => {
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().body["systemInstruction"]).toEqual({ parts: [{ text: "Be terse." }] });
  });

  it("nests sampling parameters under generationConfig", async () => {
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(
      { ...request, temperature: 0.2, maxOutputTokens: 512, stop: ["END"] },
      neverAbortedOptions(),
    );

    expect(http.lastCall().body["generationConfig"]).toEqual({
      temperature: 0.2,
      maxOutputTokens: 512,
      stopSequences: ["END"],
    });
  });

  it("omits generationConfig entirely when nothing was set", async () => {
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().body).not.toHaveProperty("generationConfig");
  });
});

describe("GeminiProvider response translation", () => {
  it("joins parts and maps usage metadata", async () => {
    const http = fakeFetch(
      jsonResponse({
        responseId: "resp_1",
        modelVersion: "gemini-2.5-flash-002",
        candidates: [
          { content: { parts: [{ text: "Redis " }, { text: "Pub/Sub" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12 },
      }),
    );

    const response = await provider(http).chat(request, neverAbortedOptions());

    expect(response.content).toBe("Redis Pub/Sub");
    expect(response.model).toBe("gemini-2.5-flash-002");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 40, outputTokens: 12, totalTokens: 52 });
  });

  it("maps a safety block to content_filter with empty content", async () => {
    // `parts` is absent when generation was blocked — a legitimate empty
    // completion, not a malformed response.
    const http = fakeFetch(jsonResponse({ candidates: [{ finishReason: "SAFETY" }] }));

    const response = await provider(http).chat(request, neverAbortedOptions());

    expect(response.finishReason).toBe("content_filter");
    expect(response.content).toBe("");
  });

  it("maps MAX_TOKENS to length", async () => {
    const http = fakeFetch(jsonResponse({ candidates: [{ finishReason: "MAX_TOKENS" }] }));

    expect((await provider(http).chat(request, neverAbortedOptions())).finishReason).toBe("length");
  });
});

describe("GeminiProvider streaming", () => {
  it("emits deltas and keeps the last cumulative usage", async () => {
    const http = fakeFetch(
      sseResponse([
        JSON.stringify({
          responseId: "resp_1",
          modelVersion: "gemini-2.5-flash",
          candidates: [{ content: { parts: [{ text: "Redis " }] } }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 2 },
        }),
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Pub/Sub" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12 },
        }),
      ]),
    );

    const chunks = await collect(provider(http).stream(request, neverAbortedOptions()));

    expect(chunks[0]).toMatchObject({ type: "start", provider: "gemini", id: "resp_1" });
    expect(
      chunks
        .filter((c): c is Extract<ChatChunk, { type: "delta" }> => c.type === "delta")
        .map((c) => c.content)
        .join(""),
    ).toBe("Redis Pub/Sub");
    expect(chunks[chunks.length - 1]).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
    });
  });
});

describe("GeminiProvider errors", () => {
  it("normalizes a 429", async () => {
    const http = fakeFetch(
      errorResponse({ error: { code: 429, message: "Quota exceeded" } }, 429),
    );

    await expect(provider(http).chat(request, neverAbortedOptions())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      provider: "gemini",
    });
  });

  it("normalizes an unknown model to MODEL_NOT_FOUND", async () => {
    const http = fakeFetch(errorResponse({ error: { message: "model not found" } }, 404));

    await expect(provider(http).chat(request, neverAbortedOptions())).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
    });
  });
});
