import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildChatServer } from "../helpers/build-test-server.js";

/**
 * Routing through the real HTTP path: route → chat service → route table →
 * fallback executor → mock provider.
 *
 * Mock behaviours are addressed by model name (`mock/rate-limited`), which keeps
 * each scenario visible in the route definition instead of buried in setup.
 */
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function post(instance: FastifyInstance, body: Record<string, unknown>) {
  return instance.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
}

const messages = [{ role: "user", content: "hi" }];

describe("aliases", () => {
  it("routes an alias to its single model", async () => {
    app = await buildChatServer({
      routing: { routes: [{ name: "cheap", models: ["mock"] }], configFile: undefined },
    });

    const response = await post(app, { model: "cheap", messages });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-openllm-provider"]).toBe("mock");
  });

  it("an alias wins over model-name inference", async () => {
    app = await buildChatServer({
      routing: { routes: [{ name: "cheap", models: ["mock/echo"] }], configFile: undefined },
    });

    const response = await post(app, {
      model: "cheap",
      messages: [{ role: "user", content: "routed via alias" }],
    });

    expect(response.json().choices[0].message.content).toBe("routed via alias");
  });

  it("explicit models still work when routes are configured", async () => {
    app = await buildChatServer({
      routing: { routes: [{ name: "cheap", models: ["mock"] }], configFile: undefined },
    });

    expect((await post(app, { model: "mock", messages })).statusCode).toBe(200);
  });
});

describe("fallback", () => {
  it("fails over to the next provider on a retryable error", async () => {
    app = await buildChatServer({
      routing: {
        routes: [{ name: "fast", models: ["mock/rate-limited", "mock/echo"] }],
        configFile: undefined,
      },
    });

    const response = await post(app, {
      model: "fast",
      messages: [{ role: "user", content: "served by the second target" }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("served by the second target");
    // Surfaced so an operator can see a fallback happened without reading logs.
    expect(response.headers["x-openllm-attempts"]).toBe("2");
  });

  it("does NOT fall over on a non-retryable client error", async () => {
    // Spec §8: a malformed request fails identically everywhere. Replaying it
    // across the route would mean paying for the same 400 several times.
    app = await buildChatServer({
      routing: {
        routes: [{ name: "fast", models: ["mock/invalid", "mock"] }],
        configFile: undefined,
      },
    });

    const response = await post(app, { model: "fast", messages });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    expect(response.headers["x-openllm-attempts"]).toBeUndefined();
  });

  it("walks the whole chain and reports every attempt when all fail", async () => {
    app = await buildChatServer({
      routing: {
        routes: [
          { name: "doomed", models: ["mock/rate-limited", "mock/unavailable", "mock/server-error"] },
        ],
        configFile: undefined,
      },
    });

    const response = await post(app, { model: "doomed", messages });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("All 3 providers failed");
  });

  it("skips an unconfigured provider and serves from the next", async () => {
    // openai has no key in the test config, so requiring it throws a
    // failoverable MODEL_NOT_FOUND that costs one cheap, network-free attempt.
    app = await buildChatServer({
      routing: {
        routes: [{ name: "fast", models: ["gpt-4.1-mini", "mock"] }],
        configFile: undefined,
      },
    });

    const response = await post(app, { model: "fast", messages });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-openllm-provider"]).toBe("mock");
  });
});

describe("streaming fallback", () => {
  function dataEvents(payload: string): string[] {
    return payload
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.startsWith("data: "))
      .map((block) => block.slice("data: ".length));
  }

  it("swaps providers before the first chunk, invisibly to the client", async () => {
    // Only possible because the route pulls one chunk before committing to 200.
    app = await buildChatServer({
      routing: {
        routes: [{ name: "fast", models: ["mock/rate-limited", "mock/echo"] }],
        configFile: undefined,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fast",
        stream: true,
        messages: [{ role: "user", content: "streamed from the fallback" }],
      },
    });

    const text = dataEvents(response.payload)
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as { choices: { delta: { content?: string } }[] })
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-openllm-provider"]).toBe("mock");
    expect(text).toBe("streamed from the fallback");
  });

  it("returns a real status code when every target fails before streaming", async () => {
    app = await buildChatServer({
      routing: {
        routes: [{ name: "doomed", models: ["mock/rate-limited", "mock/rate-limited"] }],
        configFile: undefined,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "doomed", stream: true, messages },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["content-type"]).toContain("application/json");
  });
});

describe("boot-time route validation", () => {
  it("refuses to start with an unroutable model in a route", async () => {
    await expect(
      buildChatServer({
        routing: {
          routes: [{ name: "fast", models: ["no-such-vendor-model"] }],
          configFile: undefined,
        },
      }),
    ).rejects.toThrow(/Invalid routing configuration/);
  });
});
