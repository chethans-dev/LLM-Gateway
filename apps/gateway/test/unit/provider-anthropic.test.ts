import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import type { ChatChunk, ChatRequest } from "../../src/providers/types.js";
import {
  errorResponse,
  fakeFetch,
  jsonResponse,
  namedSseResponse,
  neverAbortedOptions,
} from "../helpers/fake-fetch.js";

const baseUrl = "https://api.anthropic.test/v1";

function provider(http: ReturnType<typeof fakeFetch>) {
  return new AnthropicProvider({
    apiKey: "sk-ant-test",
    baseUrl,
    version: "2023-06-01",
    fetch: http.fetch,
  });
}

const request: ChatRequest = {
  model: "claude-sonnet-4",
  messages: [
    { role: "system", content: "Be terse." },
    { role: "user", content: "Explain Redis Pub/Sub" },
  ],
};

const emptyResponse = () => jsonResponse({ content: [] });

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("AnthropicProvider request translation", () => {
  it("authenticates with x-api-key and a pinned API version", async () => {
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().url).toBe(`${baseUrl}/messages`);
    expect(http.lastCall().headers["x-api-key"]).toBe("sk-ant-test");
    expect(http.lastCall().headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("hoists the system prompt out of the message array", async () => {
    // Anthropic takes `system` as a top-level field, not a message role.
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().body["system"]).toBe("Be terse.");
    expect(http.lastCall().body["messages"]).toEqual([
      { role: "user", content: "Explain Redis Pub/Sub" },
    ]);
  });

  it("always sends max_tokens, which the API requires", async () => {
    // Defaulting rather than erroring keeps an OpenAI-shaped request — where
    // the field is optional — working unchanged.
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(request, neverAbortedOptions());

    expect(http.lastCall().body["max_tokens"]).toBe(4096);
  });

  it("prefers an explicit max output token count", async () => {
    const http = fakeFetch(emptyResponse());

    await provider(http).chat({ ...request, maxOutputTokens: 100 }, neverAbortedOptions());

    expect(http.lastCall().body["max_tokens"]).toBe(100);
  });

  it("merges consecutive same-role messages", async () => {
    // OpenAI accepts [user, user]; Anthropic expects alternating turns. Rejecting
    // input OpenAI would have accepted, purely because of which provider served
    // it, would break the compatibility promise.
    const http = fakeFetch(emptyResponse());

    await provider(http).chat(
      {
        model: "claude-sonnet-4",
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      },
      neverAbortedOptions(),
    );

    expect(http.lastCall().body["messages"]).toEqual([
      { role: "user", content: "first\n\nsecond" },
    ]);
  });

  it("renames stop sequences to Anthropic's field", async () => {
    const http = fakeFetch(emptyResponse());

    await provider(http).chat({ ...request, stop: ["END"] }, neverAbortedOptions());

    expect(http.lastCall().body["stop_sequences"]).toEqual(["END"]);
  });
});

describe("AnthropicProvider response translation", () => {
  it("joins text blocks and maps usage", async () => {
    const http = fakeFetch(
      jsonResponse({
        id: "msg_123",
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Redis " },
          { type: "text", text: "Pub/Sub" },
        ],
        usage: { input_tokens: 120, output_tokens: 30 },
      }),
    );

    const response = await provider(http).chat(request, neverAbortedOptions());

    expect(response.content).toBe("Redis Pub/Sub");
    expect(response.model).toBe("claude-sonnet-4-20250514");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
  });

  it("ignores non-text content blocks", async () => {
    const http = fakeFetch(
      jsonResponse({ content: [{ type: "thinking", text: "hmm" }, { type: "text", text: "hi" }] }),
    );

    expect((await provider(http).chat(request, neverAbortedOptions())).content).toBe("hi");
  });

  it("maps max_tokens to a length finish", async () => {
    const http = fakeFetch(jsonResponse({ stop_reason: "max_tokens", content: [] }));

    expect((await provider(http).chat(request, neverAbortedOptions())).finishReason).toBe("length");
  });
});

describe("AnthropicProvider streaming", () => {
  it("assembles usage split across message_start and message_delta", async () => {
    // Anthropic reports input tokens at the start and output tokens at the end;
    // neither event alone is enough to cost the request.
    const http = fakeFetch(
      namedSseResponse([
        {
          event: "message_start",
          data: JSON.stringify({
            type: "message_start",
            message: { id: "msg_1", model: "claude-sonnet-4", usage: { input_tokens: 120 } },
          }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Redis " },
          }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Pub/Sub" },
          }),
        },
        {
          event: "message_delta",
          data: JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 30 },
          }),
        },
        { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
      ]),
    );

    const chunks = await collect(provider(http).stream(request, neverAbortedOptions()));

    expect(chunks[0]).toEqual({
      type: "start",
      id: "msg_1",
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(chunks[chunks.length - 1]).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
  });

  it("maps a mid-stream overloaded error to a retryable failure", async () => {
    // Anthropic signals capacity problems inside the stream. Treating that as a
    // malformed response would stop the router failing over when it should.
    const http = fakeFetch(
      namedSseResponse([
        {
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          }),
        },
      ]),
    );

    await expect(
      collect(provider(http).stream(request, neverAbortedOptions())),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
});

describe("AnthropicProvider errors", () => {
  it("normalizes a 429", async () => {
    const http = fakeFetch(
      errorResponse({ error: { type: "rate_limit_error", message: "slow down" } }, 429),
    );

    await expect(provider(http).chat(request, neverAbortedOptions())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      provider: "anthropic",
    });
  });
});
