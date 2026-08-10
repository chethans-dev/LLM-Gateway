import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildChatServer } from "../helpers/build-test-server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function post(instance: FastifyInstance, body: unknown) {
  return instance.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: body as Record<string, unknown>,
  });
}

const baseBody = {
  model: "mock",
  messages: [{ role: "user", content: "Explain Redis Pub/Sub" }],
};

describe("POST /v1/chat/completions — success", () => {
  it("returns an OpenAI-shaped completion", async () => {
    app = await buildChatServer();

    const response = await post(app, baseBody);
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.object).toBe("chat.completion");
    expect(body.id).toBeTruthy();
    expect(body.model).toBe("mock");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]).toMatchObject({
      index: 0,
      message: { role: "assistant" },
      finish_reason: "stop",
    });
    expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    expect(body.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
  });

  it("reports the serving provider and model in headers, not the body", async () => {
    // The body must stay exactly OpenAI-shaped for strict clients, but an
    // operator still needs to know who actually answered.
    app = await buildChatServer();

    const response = await post(app, baseBody);

    expect(response.headers["x-openllm-provider"]).toBe("mock");
    expect(response.headers["x-openllm-model"]).toBe("mock");
    expect(response.headers["x-request-id"]).toMatch(/^req_/);
    expect(response.json()).not.toHaveProperty("x_openllm");
  });

  it("strips the provider prefix before calling the provider", async () => {
    // `mock/echo` must reach the adapter as `echo`.
    app = await buildChatServer();

    const response = await post(app, {
      model: "mock/echo",
      messages: [{ role: "user", content: "ping" }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("ping");
  });

  it("accepts the array form of content", async () => {
    // A client sending text as parts is not doing anything wrong.
    app = await buildChatServer();

    const response = await post(app, {
      model: "mock/echo",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("ping");
  });

  it("accepts the developer role as an alias for system", async () => {
    app = await buildChatServer();

    const response = await post(app, {
      model: "mock/echo",
      messages: [
        { role: "developer", content: "Be terse." },
        { role: "user", content: "ping" },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("ping");
  });

  it("ignores unknown fields that real OpenAI SDKs send", async () => {
    // Rejecting these would break "change only your baseURL" for clients doing
    // nothing wrong.
    app = await buildChatServer();

    const response = await post(app, {
      ...baseBody,
      user: "user-123",
      seed: 42,
      presence_penalty: 0.5,
      frequency_penalty: 0.1,
    });

    expect(response.statusCode).toBe(200);
  });

  it("accepts both max_tokens and max_completion_tokens", async () => {
    app = await buildChatServer();

    expect((await post(app, { ...baseBody, max_tokens: 50 })).statusCode).toBe(200);
    expect((await post(app, { ...baseBody, max_completion_tokens: 50 })).statusCode).toBe(200);
  });
});

describe("POST /v1/chat/completions — validation", () => {
  it("names the offending field", async () => {
    // "Invalid request" costs the caller a debugging session that a field name
    // would have prevented.
    app = await buildChatServer();

    const response = await post(app, { model: "mock" });
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("messages");
  });

  it("rejects an empty messages array", async () => {
    app = await buildChatServer();

    expect((await post(app, { model: "mock", messages: [] })).statusCode).toBe(400);
  });

  it("rejects an out-of-range temperature", async () => {
    app = await buildChatServer();

    expect((await post(app, { ...baseBody, temperature: 3 })).statusCode).toBe(400);
  });

  it("rejects malformed JSON with a normalized 400", async () => {
    app = await buildChatServer();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("invalid_request_error");
  });

  it("wraps Fastify's own errors in the same envelope", async () => {
    // An unparseable media type never reaches our handler, but the client must
    // still get one consistent error shape — that is what makes the
    // compatibility promise hold for error handling, not just success paths.
    app = await buildChatServer();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/xml" },
      payload: "<nonsense/>",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    expect(response.json().error.type).toBe("invalid_request_error");
  });
});

describe("POST /v1/chat/completions — unsupported features refused loudly", () => {
  it("refuses tool calling rather than dropping it", async () => {
    // Silently discarding tools returns a confidently wrong answer.
    app = await buildChatServer();

    const response = await post(app, { ...baseBody, tools: [{ type: "function" }] });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("Tool and function calling");
  });

  it("refuses response_format rather than ignoring it", async () => {
    app = await buildChatServer();

    const response = await post(app, { ...baseBody, response_format: { type: "json_object" } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("response_format");
  });

  it("refuses n > 1", async () => {
    app = await buildChatServer();

    expect((await post(app, { ...baseBody, n: 2 })).statusCode).toBe(400);
    expect((await post(app, { ...baseBody, n: 1 })).statusCode).toBe(200);
  });

  it("refuses tool-role messages", async () => {
    app = await buildChatServer();

    const response = await post(app, {
      model: "mock",
      messages: [{ role: "tool", content: "result" }],
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /v1/chat/completions — routing errors", () => {
  it("returns 404 for a model with no resolvable provider", async () => {
    app = await buildChatServer();

    const response = await post(app, { ...baseBody, model: "llama3.2" });
    const body = response.json();

    expect(response.statusCode).toBe(404);
    expect(body.error.code).toBe("MODEL_NOT_FOUND");
    expect(body.error.message).toContain("ollama/llama3.2");
  });

  it("returns 404 naming the missing setting when the provider is not configured", async () => {
    // The test config has no OpenAI key.
    app = await buildChatServer();

    const response = await post(app, { ...baseBody, model: "gpt-4.1-mini" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("OPENAI_API_KEY");
  });
});

describe("POST /v1/chat/completions — provider failures", () => {
  it("maps a provider rate limit to 429", async () => {
    app = await buildChatServer();

    const response = await post(app, { ...baseBody, model: "mock/rate-limited" });
    const body = response.json();

    expect(response.statusCode).toBe(429);
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("maps a provider outage to 503", async () => {
    app = await buildChatServer();

    expect((await post(app, { ...baseBody, model: "mock/unavailable" })).statusCode).toBe(503);
  });

  it("maps a provider server error to 502", async () => {
    app = await buildChatServer();

    expect((await post(app, { ...baseBody, model: "mock/server-error" })).statusCode).toBe(502);
  });

  it("maps a provider client error to 400", async () => {
    app = await buildChatServer();

    expect((await post(app, { ...baseBody, model: "mock/invalid" })).statusCode).toBe(400);
  });

  it("times out a hanging provider instead of hanging the request", async () => {
    // Spec §10: every provider request is bounded. Without this the caller's
    // socket, a connection and a pool slot stay open indefinitely.
    app = await buildChatServer({
      reliability: {
        timeoutMs: 30,
        requestTimeoutMs: 200,
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5, jitter: false },
      },
    });

    const response = await post(app, { ...baseBody, model: "mock/timeout" });

    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe("TIMEOUT");
  });

  it("includes the request id in every error, for log correlation", async () => {
    app = await buildChatServer();

    const response = await post(app, { ...baseBody, model: "mock/server-error" });

    expect(response.json().error.request_id).toMatch(/^req_/);
  });
});
