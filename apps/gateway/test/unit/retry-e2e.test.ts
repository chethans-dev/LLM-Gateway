import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createChatService } from "../../src/chat/chat-service.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { buildServer } from "../../src/http/server.js";
import type { AppConfig } from "../../src/config/index.js";
import type { RouteDefinition } from "../../src/routing/route-table.js";
import { createTestConfig, fakeLifecycle, silentLogger } from "../helpers/build-test-server.js";

/**
 * Retry and fallback composed over the real HTTP path.
 *
 * `sleep` is injected, so a three-attempt backoff schedule is asserted exactly
 * without the suite spending 750ms per case.
 */
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Harness {
  readonly app: FastifyInstance;
  readonly waits: number[];
}

async function buildRetryServer(options: {
  routes?: readonly RouteDefinition[];
  maxAttempts?: number;
  requestTimeoutMs?: number;
}): Promise<Harness> {
  const waits: number[] = [];

  const config: AppConfig = createTestConfig({
    reliability: {
      timeoutMs: 1_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      retry: {
        maxAttempts: options.maxAttempts ?? 3,
        baseDelayMs: 250,
        maxDelayMs: 5_000,
        jitter: false,
      },
    },
    routing: { routes: options.routes ?? [], configFile: undefined },
  });

  const registry = createProviderRegistry(config, silentLogger);
  const instance = await buildServer({
    config,
    logger: silentLogger,
    lifecycle: fakeLifecycle("ready"),
    checks: [],
    version: "0.1.0-test",
    chatService: createChatService({
      registry,
      config,
      retryDeps: {
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      },
    }),
  });

  return { app: instance, waits };
}

function post(instance: FastifyInstance, body: Record<string, unknown>) {
  return instance.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
}

const messages = [{ role: "user", content: "hi" }];

describe("retry on a single target", () => {
  it("retries a retryable failure with the documented backoff", async () => {
    const harness = await buildRetryServer({});
    app = harness.app;

    const response = await post(app, { model: "mock/rate-limited", messages });

    expect(response.statusCode).toBe(429);
    // Three attempts, two waits — never a pointless sleep after the last one.
    // 250 comes from the provider's Retry-After hint, not our exponential curve.
    expect(harness.waits).toEqual([1_000, 1_000]);
    expect(response.json().error.code).toBe("RATE_LIMITED");
  });

  it("does NOT retry a client error", async () => {
    // Spec §9. A malformed request fails identically on the second attempt.
    const harness = await buildRetryServer({});
    app = harness.app;

    const response = await post(app, { model: "mock/invalid", messages });

    expect(response.statusCode).toBe(400);
    expect(harness.waits).toEqual([]);
  });

  it("uses our exponential curve when the provider gives no hint", async () => {
    const harness = await buildRetryServer({});
    app = harness.app;

    await post(app, { model: "mock/server-error", messages });

    expect(harness.waits).toEqual([250, 500]);
  });

  it("makes a single call when retries are disabled", async () => {
    const harness = await buildRetryServer({ maxAttempts: 1 });
    app = harness.app;

    await post(app, { model: "mock/server-error", messages });

    expect(harness.waits).toEqual([]);
  });

  it("reports total provider calls in the response header", async () => {
    const harness = await buildRetryServer({
      routes: [{ name: "flaky", models: ["mock/server-error", "mock"] }],
    });
    app = harness.app;

    const response = await post(app, { model: "flaky", messages });

    expect(response.statusCode).toBe(200);
    // 3 retried calls on the first target, then 1 successful call on the second.
    expect(response.headers["x-openllm-attempts"]).toBe("4");
  });
});

describe("retry composed with fallback", () => {
  it("exhausts retries on a target BEFORE moving to the next", async () => {
    // A multi-target route must not skip past a provider that was one retry
    // away from succeeding; a single-target route still needs recovery.
    const harness = await buildRetryServer({
      routes: [{ name: "fast", models: ["mock/server-error", "mock/echo"] }],
    });
    app = harness.app;

    const response = await post(app, {
      model: "fast",
      messages: [{ role: "user", content: "served after retries" }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("served after retries");
    expect(harness.waits).toEqual([250, 500]);
  });

  it("does not retry a non-retryable error but still falls over", async () => {
    // MODEL_NOT_FOUND: retrying the same provider is pointless, trying another
    // is not. The two axes acting independently, in one request.
    const harness = await buildRetryServer({
      routes: [{ name: "fast", models: ["mock/model-not-found", "mock/echo"] }],
    });
    app = harness.app;

    const response = await post(app, {
      model: "fast",
      messages: [{ role: "user", content: "second target" }],
    });

    expect(response.statusCode).toBe(200);
    expect(harness.waits).toEqual([]);
    expect(response.headers["x-openllm-attempts"]).toBe("2");
  });

  it("retries on every target before giving up", async () => {
    const harness = await buildRetryServer({
      routes: [{ name: "doomed", models: ["mock/server-error", "mock/unavailable"] }],
    });
    app = harness.app;

    const response = await post(app, { model: "doomed", messages });

    expect(response.statusCode).toBe(503);
    // Two targets x two waits each.
    expect(harness.waits).toEqual([250, 500, 250, 500]);
    expect(response.json().error.message).toContain("All 2 providers failed");
  });

  it("stops retrying when the request budget cannot fit another backoff", async () => {
    // The whole point of a separate REQUEST_TIMEOUT_MS: reliability features
    // must not multiply latency for a caller who has already given up.
    const harness = await buildRetryServer({
      routes: [{ name: "fast", models: ["mock/server-error", "mock/echo"] }],
      requestTimeoutMs: 100,
    });
    app = harness.app;

    const response = await post(app, {
      model: "fast",
      messages: [{ role: "user", content: "no time to retry" }],
    });

    // Fell over to the healthy target immediately instead of burning the budget.
    expect(response.statusCode).toBe(200);
    expect(harness.waits).toEqual([]);
  });
});

describe("retry while streaming", () => {
  it("retries opening the stream, then streams normally", async () => {
    const harness = await buildRetryServer({
      routes: [{ name: "fast", models: ["mock/server-error", "mock/echo"] }],
    });
    app = harness.app;

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fast",
        stream: true,
        messages: [{ role: "user", content: "streamed after retries" }],
      },
    });

    const text = response.payload
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
      .map((block) => JSON.parse(block.slice(6)) as { choices: { delta: { content?: string } }[] })
      .map((chunk) => chunk.choices[0]?.delta.content ?? "")
      .join("");

    expect(response.statusCode).toBe(200);
    expect(text).toBe("streamed after retries");
    expect(harness.waits).toEqual([250, 500]);
  });
});

describe("retry logging", () => {
  it("warns on each retry with the delay and whether it was the provider's hint", async () => {
    const warn = vi.fn();
    const config = createTestConfig({
      reliability: {
        timeoutMs: 1_000,
        requestTimeoutMs: 60_000,
        retry: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 5_000, jitter: false },
      },
    });
    const registry = createProviderRegistry(config, silentLogger);
    const service = createChatService({
      registry,
      config,
      logger: { ...silentLogger, warn } as unknown as typeof silentLogger,
      retryDeps: { sleep: async () => {} },
    });

    await service
      .complete(
        { model: "mock/rate-limited", messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      )
      .catch(() => undefined);

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      provider: "mock",
      attempt: 1,
      maxAttempts: 2,
      code: "RATE_LIMITED",
      honouredRetryAfter: true,
    });
  });
});
