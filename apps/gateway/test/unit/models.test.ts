import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createChatService } from "../../src/chat/chat-service.js";
import { buildServer } from "../../src/http/server.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createTestConfig, fakeLifecycle, silentLogger } from "../helpers/build-test-server.js";

/**
 * `GET /v1/models` (OpenAI compatibility).
 *
 * The endpoint exists because "OpenAI-compatible" is a promise clients hold us
 * to beyond the chat route: LangChain, Open WebUI and `client.models.list()` all
 * call this to populate a model picker, and a 404 breaks the integration before
 * a single completion is attempted.
 */
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(routes: Record<string, string[]> = { fast: ["mock/echo"] }) {
  const config = createTestConfig({
    routing: {
      configFile: undefined,
      routes: Object.entries(routes).map(([name, models]) => ({
        name,
        strategy: "fallback" as const,
        models,
      })),
    },
  });
  const registry = createProviderRegistry(config, silentLogger);

  return buildServer({
    config,
    logger: silentLogger,
    lifecycle: fakeLifecycle("ready"),
    checks: [],
    version: "0.1.0-test",
    chatService: createChatService({ registry, config }),
    registry,
  });
}

function list(instance: FastifyInstance) {
  return instance.inject({ method: "GET", url: "/v1/models" });
}

describe("GET /v1/models", () => {
  it("returns OpenAI's list envelope", async () => {
    // Shape drift here breaks clients silently: they parse `data`, not a body
    // we found more elegant.
    app = await build();

    const response = await list(app);
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toMatchObject({ object: "model" });
    expect(body.data[0]).toHaveProperty("id");
    expect(body.data[0]).toHaveProperty("created");
    expect(body.data[0]).toHaveProperty("owned_by");
  });

  it("lists configured aliases", async () => {
    app = await build({ fast: ["mock/echo"], balanced: ["mock"] });

    const ids = list(app).then((r) => r.json().data.map((m: { id: string }) => m.id));

    expect(await ids).toEqual(expect.arrayContaining(["fast", "balanced"]));
  });

  it("lists the concrete models an alias resolves to", async () => {
    // Both are valid values for `model`, so a picker should offer both.
    app = await build({ fast: ["mock/echo"] });

    const ids = (await list(app)).json().data.map((m: { id: string }) => m.id);

    expect(ids).toContain("fast");
    expect(ids).toContain("mock/echo");
  });

  it("attributes an alias to the gateway and a real model to its provider", async () => {
    // An alias is the gateway's own name for a routing policy; the provider has
    // never heard of it.
    app = await build({ fast: ["mock/echo"] });

    const data = (await list(app)).json().data as { id: string; owned_by: string }[];

    expect(data.find((m) => m.id === "fast")?.owned_by).toBe("openllm");
    expect(data.find((m) => m.id === "mock/echo")?.owned_by).toBe("mock");
  });

  it("never advertises a model whose provider has no credential", async () => {
    // The failure this prevents: a picker full of options that all 401. Only
    // the mock provider is configured in tests, so an OpenAI target must not
    // appear even though it is named in config.
    app = await build({ mixed: ["mock", "gpt-4.1-mini"] });

    const ids = (await list(app)).json().data.map((m: { id: string }) => m.id);

    expect(ids).toContain("mock");
    expect(ids).not.toContain("gpt-4.1-mini");
  });

  it("returns each id once", async () => {
    // Two aliases pointing at the same model must not double-list it.
    app = await build({ fast: ["mock/echo"], quick: ["mock/echo"] });

    const ids = (await list(app)).json().data.map((m: { id: string }) => m.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts stably, so a picker does not reshuffle between calls", async () => {
    app = await build({ zebra: ["mock"], alpha: ["mock/echo"] });

    const ids = (await list(app)).json().data.map((m: { id: string }) => m.id);

    expect([...ids].sort()).toEqual(ids);
  });

  it("exposes no credential or provider URL", async () => {
    app = await build();

    const payload = (await list(app)).payload;

    expect(payload).not.toMatch(/api[_-]?key/i);
    expect(payload).not.toContain("http");
  });
});

describe("GET /v1/models/:id", () => {
  it("retrieves a single model", async () => {
    app = await build({ fast: ["mock/echo"] });

    const response = await app.inject({ method: "GET", url: "/v1/models/fast" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "fast", object: "model" });
  });

  it("handles an id containing a slash", async () => {
    // `mock/echo` and `ollama/qwen3` are ordinary model names here, and a plain
    // `:param` route would match only the first segment.
    app = await build({ fast: ["mock/echo"] });

    const response = await app.inject({ method: "GET", url: "/v1/models/mock/echo" });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe("mock/echo");
  });

  it("404s for something it does not serve", async () => {
    app = await build();

    const response = await app.inject({ method: "GET", url: "/v1/models/no-such-model" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.type).toBe("invalid_request_error");
  });
});
