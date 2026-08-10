import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createChatService } from "../../src/chat/chat-service.js";
import { buildServer } from "../../src/http/server.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import type { CachedResponse, ResponseCache } from "../../src/redis/response-cache.js";
import type { CircuitBreaker } from "../../src/redis/circuit-breaker.js";
import type { RateLimitDecision, RateLimiter } from "../../src/redis/rate-limiter.js";
import { createTestConfig, fakeLifecycle, silentLogger } from "../helpers/build-test-server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function fakeLimiter(decisions: RateLimitDecision[]): RateLimiter & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    consume: async (scope, identifier) => {
      calls.push(`${scope}:${identifier}`);
      return decisions[Math.min(index++, decisions.length - 1)]!;
    },
  };
}

const allow: RateLimitDecision = {
  allowed: true,
  limit: 60,
  remaining: 59,
  retryAfterMs: 0,
  degraded: false,
};
const deny: RateLimitDecision = {
  allowed: false,
  limit: 60,
  remaining: 0,
  retryAfterMs: 2_500,
  degraded: false,
};

async function build(options: {
  limiter?: RateLimiter;
  cache?: ResponseCache;
  breaker?: CircuitBreaker;
}): Promise<FastifyInstance> {
  const config = createTestConfig();
  const registry = createProviderRegistry(config, silentLogger);

  return buildServer({
    config,
    logger: silentLogger,
    lifecycle: fakeLifecycle("ready"),
    checks: [],
    version: "0.1.0-test",
    chatService: createChatService({
      registry,
      config,
      ...(options.cache !== undefined ? { cache: options.cache } : {}),
      ...(options.breaker !== undefined ? { breaker: options.breaker } : {}),
    }),
    ...(options.limiter !== undefined ? { rateLimiter: options.limiter } : {}),
  });
}

const body = { model: "mock", messages: [{ role: "user", content: "hi" }] };

function chat(instance: FastifyInstance) {
  return instance.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
}

describe("rate limiting over HTTP", () => {
  it("advertises the limit using OpenAI's header names", async () => {
    // So a client's existing back-off handling works unchanged — the same
    // reasoning as matching the response body shape.
    app = await build({ limiter: fakeLimiter([allow]) });

    const response = await chat(app);

    expect(response.headers["x-ratelimit-limit-requests"]).toBe("60");
    expect(response.headers["x-ratelimit-remaining-requests"]).toBe("59");
  });

  it("returns 429 with retry-after when denied", async () => {
    app = await build({ limiter: fakeLimiter([deny]) });

    const response = await chat(app);

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("3");
    expect(response.json().error.code).toBe("RATE_LIMITED");
  });

  it("marks its own 429 as neither retryable nor failoverable", async () => {
    // Ours, not a provider's. Failing over would not help, and whether to retry
    // is the caller's decision rather than the router's.
    app = await build({ limiter: fakeLimiter([deny]) });

    const response = await chat(app);

    expect(response.json().error.type).toBe("rate_limit_error");
    expect(response.headers["x-openllm-attempts"]).toBeUndefined();
  });

  it("never limits the probe endpoints", async () => {
    // An orchestrator polling /health must not be able to exhaust a budget and
    // get the instance killed.
    const limiter = fakeLimiter([deny]);
    app = await build({ limiter });

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    expect(limiter.calls).toEqual([]);
  });

  it("keys the limit by caller identity", async () => {
    const limiter = fakeLimiter([allow]);
    app = await build({ limiter });

    await chat(app);

    // Auth is off in the test config, so the IP is the only identity available.
    expect(limiter.calls[0]).toMatch(/^ip:/);
  });

  it("flags a degraded limiter to the caller and lets the request through", async () => {
    app = await build({
      limiter: fakeLimiter([{ ...allow, degraded: true }]),
    });

    const response = await chat(app);

    expect(response.statusCode).toBe(200);
    // Silence here is how an unexpected bill arrives.
    expect(response.headers["x-openllm-ratelimit-degraded"]).toBe("true");
  });
});

describe("response cache over HTTP", () => {
  function fakeCache(initial?: CachedResponse) {
    let stored = initial;
    const cache: ResponseCache = {
      get: async () => stored,
      set: async (_request, _apiKeyId, response) => {
        stored = { response, cachedAt: Date.now() };
      },
    };
    return { cache, read: () => stored };
  }

  it("reports a miss and then populates the cache", async () => {
    const { cache, read } = fakeCache();
    app = await build({ cache });

    const response = await chat(app);

    expect(response.headers["x-openllm-cache"]).toBe("miss");
    // set() is fire-and-forget, so give the microtask queue a turn.
    await new Promise((resolve) => setImmediate(resolve));
    expect(read()).toBeDefined();
  });

  it("serves a hit without calling a provider", async () => {
    const { cache } = fakeCache({
      response: {
        id: "resp_cached",
        provider: "mock",
        model: "mock",
        content: "from the cache",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        createdAt: 1_700_000_000,
      },
      cachedAt: Date.now(),
    });
    app = await build({ cache });

    const response = await chat(app);

    expect(response.headers["x-openllm-cache"]).toBe("hit");
    expect(response.json().choices[0].message.content).toBe("from the cache");
    // No provider call, which is the entire point.
    expect(response.headers["x-openllm-attempts"]).toBeUndefined();
  });

  it("says 'miss' explicitly when caching is switched off", async () => {
    // "No header" would be ambiguous between a miss and the feature being off.
    app = await build({});

    expect((await chat(app)).headers["x-openllm-cache"]).toBe("miss");
  });
});

describe("circuit breaker over HTTP", () => {
  function fakeBreaker(open: string[]): CircuitBreaker & { failures: string[] } {
    const failures: string[] = [];
    return {
      failures,
      isOpen: async (provider) => open.includes(provider),
      openProviders: async (providers) => providers.filter((p) => open.includes(p)),
      recordSuccess: vi.fn(),
      recordFailure: (provider) => failures.push(provider),
    };
  }

  it("does not count a client error against provider health", async () => {
    // One malformed request must not be able to open circuits on every
    // provider — it would fail identically anywhere.
    const breaker = fakeBreaker([]);
    app = await build({ breaker });

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mock/invalid", messages: [{ role: "user", content: "hi" }] },
    });

    expect(breaker.failures).toEqual([]);
  });

  it("counts a provider-side failure", async () => {
    const breaker = fakeBreaker([]);
    app = await build({ breaker });

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mock/server-error", messages: [{ role: "user", content: "hi" }] },
    });

    expect(breaker.failures).toContain("mock");
  });

  it("still attempts when every target's circuit is open", async () => {
    // A guaranteed failure is worse than a probably-failing attempt, and it is
    // how the circuit gets a chance to close again.
    app = await build({ breaker: fakeBreaker(["mock"]) });

    expect((await chat(app)).statusCode).toBe(200);
  });
});
