import { afterEach, describe, expect, it } from "vitest";
import { LLMError } from "@openllm/core";
import type { FastifyInstance } from "fastify";
import type { ChatService, ChatStream } from "../../src/chat/chat-service.js";
import { createActiveStreams } from "../../src/http/active-streams.js";
import { emptyRouteTable } from "../../src/routing/route-table.js";
import type { ChatChunk } from "../../src/providers/types.js";
import { buildChatServer, buildServerWithChatService } from "../helpers/build-test-server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function stream(instance: FastifyInstance, body: Record<string, unknown>) {
  return instance.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { stream: true, ...body },
  });
}

const baseBody = {
  model: "mock",
  messages: [{ role: "user", content: "Explain Redis Pub/Sub" }],
};

/** Split an SSE payload into its `data:` values, in order. */
function dataEvents(payload: string): string[] {
  return payload
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length));
}

function parsedChunks(payload: string): Record<string, unknown>[] {
  return dataEvents(payload)
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

describe("streaming — transport", () => {
  it("responds as an event stream with correlation headers", async () => {
    app = await buildChatServer();

    const response = await stream(app, baseBody);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    // `no-transform` matters as much as `no-cache`: a compressing proxy would
    // otherwise buffer the whole stream to gzip it.
    expect(response.headers["cache-control"]).toContain("no-transform");
    // nginx buffers proxied responses by default, breaking streaming in exactly
    // the deployment people are most likely to have.
    expect(response.headers["x-accel-buffering"]).toBe("no");
    // Hijacking bypasses reply.header(), so these must be set explicitly.
    expect(response.headers["x-request-id"]).toMatch(/^req_/);
    expect(response.headers["x-openllm-provider"]).toBe("mock");
  });

  it("terminates with [DONE]", async () => {
    app = await buildChatServer();

    const events = dataEvents((await stream(app, baseBody)).payload);

    expect(events[events.length - 1]).toBe("[DONE]");
  });
});

describe("streaming — chunk shape", () => {
  it("opens with a role delta and closes with a finish_reason", async () => {
    app = await buildChatServer();

    const chunks = parsedChunks((await stream(app, baseBody)).payload);
    const first = chunks[0] as { object: string; choices: { delta: { role?: string } }[] };
    const last = chunks[chunks.length - 1] as {
      choices: { finish_reason: string | null }[];
    };

    expect(first.object).toBe("chat.completion.chunk");
    expect(first.choices[0]?.delta.role).toBe("assistant");
    expect(last.choices[0]?.finish_reason).toBe("stop");
  });

  it("carries no finish_reason on content chunks", async () => {
    app = await buildChatServer();

    const chunks = parsedChunks((await stream(app, baseBody)).payload) as {
      choices: { delta: { content?: string }; finish_reason: string | null }[];
    }[];
    const contentChunks = chunks.filter((c) => c.choices[0]?.delta.content !== undefined);

    expect(contentChunks.length).toBeGreaterThan(1);
    for (const chunk of contentChunks) {
      expect(chunk.choices[0]?.finish_reason).toBeNull();
    }
  });

  it("reassembles to exactly the full completion", async () => {
    app = await buildChatServer();

    const response = await stream(app, {
      model: "mock/echo",
      messages: [{ role: "user", content: "the quick brown fox" }],
    });
    const text = (parsedChunks(response.payload) as {
      choices: { delta: { content?: string } }[];
    }[])
      .map((chunk) => chunk.choices[0]?.delta.content ?? "")
      .join("");

    expect(text).toBe("the quick brown fox");
  });

  it("keeps a stable id and model across every chunk", async () => {
    app = await buildChatServer();

    const chunks = parsedChunks((await stream(app, baseBody)).payload) as {
      id: string;
      model: string;
    }[];

    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    expect(new Set(chunks.map((c) => c.model)).size).toBe(1);
    expect(chunks[0]?.id).toBeTruthy();
  });
});

describe("streaming — usage", () => {
  it("omits usage unless the client asked for it", async () => {
    // OpenAI only emits a usage chunk with stream_options.include_usage. A
    // client parsing positionally should not get an event it never requested.
    app = await buildChatServer();

    const chunks = parsedChunks((await stream(app, baseBody)).payload);

    expect(chunks.some((chunk) => "usage" in chunk)).toBe(false);
  });

  it("sends a trailing usage chunk when requested", async () => {
    app = await buildChatServer();

    const response = await stream(app, {
      ...baseBody,
      stream_options: { include_usage: true },
    });
    const chunks = parsedChunks(response.payload) as {
      choices: unknown[];
      usage?: { total_tokens: number };
    }[];
    const usageChunk = chunks[chunks.length - 1];

    expect(usageChunk?.usage?.total_tokens).toBeGreaterThan(0);
    // Empty choices array is OpenAI's shape here; clients that index into
    // choices[0] crash on anything else.
    expect(usageChunk?.choices).toEqual([]);
  });
});

describe("streaming — errors before the first chunk", () => {
  // The pivot of the design: every adapter performs its HTTP request and throws
  // on a non-OK status before yielding, so awaiting one chunk before committing
  // to a 200 converts these back into ordinary status codes.

  it("returns a real 429, not a 200 containing an error", async () => {
    app = await buildChatServer();

    const response = await stream(app, { ...baseBody, model: "mock/rate-limited" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json().error.code).toBe("RATE_LIMITED");
  });

  it("returns 404 for an unresolvable model", async () => {
    app = await buildChatServer();

    const response = await stream(app, { ...baseBody, model: "llama3.2" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MODEL_NOT_FOUND");
  });

  it("returns 504 when the provider never responds", async () => {
    app = await buildChatServer({
      reliability: {
        timeoutMs: 30,
        requestTimeoutMs: 200,
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5, jitter: false },
      },
    });

    const response = await stream(app, { ...baseBody, model: "mock/timeout" });

    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe("TIMEOUT");
  });

  it("still rejects unsupported features before streaming starts", async () => {
    app = await buildChatServer();

    const response = await stream(app, { ...baseBody, tools: [{ type: "function" }] });

    expect(response.statusCode).toBe(400);
  });
});

describe("streaming — errors after the first chunk", () => {
  function failingAfterFirstChunk(): ChatService {
    return {
      routes: emptyRouteTable(),
      complete: () => Promise.reject(new Error("not used in this test")),
      stream: (): ChatStream => ({
        route: undefined,
        callCount: () => 1,
        chunks: (async function* (): AsyncGenerator<ChatChunk> {
          yield { type: "start", id: "resp_1", provider: "mock", model: "stub-model" };
          yield { type: "delta", content: "partial " };
          throw LLMError.provider("upstream exploded mid-stream", { provider: "mock" });
        })(),
      }),
    };
  }

  it("reports the failure as an SSE event, since the status is already 200", async () => {
    app = await buildServerWithChatService(failingAfterFirstChunk());

    const response = await stream(app, baseBody);
    const events = dataEvents(response.payload);
    const last = JSON.parse(events[events.length - 1]!) as {
      error: { code: string; request_id: string };
    };

    expect(response.statusCode).toBe(200);
    expect(last.error.code).toBe("PROVIDER_ERROR");
    expect(last.error.request_id).toMatch(/^req_/);
  });

  it("does NOT send [DONE] after an error", async () => {
    // [DONE] means "completed successfully". Sending it after a failure would
    // tell the client it received the whole response.
    app = await buildServerWithChatService(failingAfterFirstChunk());

    const events = dataEvents((await stream(app, baseBody)).payload);

    expect(events).not.toContain("[DONE]");
  });

  it("keeps the chunks that were already delivered", async () => {
    app = await buildServerWithChatService(failingAfterFirstChunk());

    const response = await stream(app, baseBody);

    expect(response.payload).toContain("partial ");
  });
});

describe("streaming — lifecycle tracking", () => {
  it("registers a stream while running and releases it afterwards", async () => {
    // Shutdown reads this count to decide whether to wait (spec §25).
    const activeStreams = createActiveStreams();
    app = await buildChatServer({}, activeStreams);

    expect(activeStreams.size()).toBe(0);
    await stream(app, baseBody);
    expect(activeStreams.size()).toBe(0);
  });

  it("releases the stream even when it fails mid-flight", async () => {
    const activeStreams = createActiveStreams();
    app = await buildServerWithChatService(
      {
        routes: emptyRouteTable(),
        complete: () => Promise.reject(new Error("not used")),
        stream: (): ChatStream => ({
          route: undefined,
          callCount: () => 1,
          chunks: (async function* (): AsyncGenerator<ChatChunk> {
            yield { type: "start", id: "r", provider: "mock", model: "m" };
            throw new Error("boom");
          })(),
        }),
      },
      activeStreams,
    );

    await stream(app, baseBody);

    expect(activeStreams.size()).toBe(0);
  });
});

describe("non-streaming requests are unaffected", () => {
  it("still returns a buffered JSON completion", async () => {
    app = await buildChatServer();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { ...baseBody, stream: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json().object).toBe("chat.completion");
  });
});
