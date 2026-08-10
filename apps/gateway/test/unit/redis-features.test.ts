import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { createRedisKeys, KEY_SCHEMA_VERSION } from "../../src/redis/keys.js";
import { createRateLimiter } from "../../src/redis/rate-limiter.js";
import { cacheKeyFor, createResponseCache } from "../../src/redis/response-cache.js";
import { createCircuitBreaker } from "../../src/redis/circuit-breaker.js";
import type { ChatRequest, ChatResponse } from "../../src/providers/types.js";
import { silentLogger } from "../helpers/build-test-server.js";

const request: ChatRequest = {
  model: "gpt-4.1-mini",
  messages: [{ role: "user", content: "hello" }],
};

describe("redis key strategy", () => {
  const keys = createRedisKeys("openllm");

  it("namespaces and versions every key", () => {
    // The version is what stops a rolling deploy's new code from reading old
    // values in a changed format and silently misbehaving for the rollout.
    expect(keys.rateLimit("key", "abc")).toBe(`openllm:${KEY_SCHEMA_VERSION}:rl:key:abc`);
    expect(keys.cache("9c81")).toBe(`openllm:${KEY_SCHEMA_VERSION}:cache:9c81`);
    expect(keys.providerHealth("openai")).toBe(`openllm:${KEY_SCHEMA_VERSION}:health:openai`);
  });

  it("keeps separate prefixes apart, so gateways can share one Redis", () => {
    const staging = createRedisKeys("staging");

    expect(staging.rateLimit("key", "abc")).not.toBe(keys.rateLimit("key", "abc"));
  });
});

describe("rate limiter", () => {
  function fakeRedis(result: [number, number, number] | Error) {
    const openllmTokenBucket = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    return {
      defineCommand: vi.fn(),
      openllmTokenBucket,
    } as unknown as Redis & { openllmTokenBucket: typeof openllmTokenBucket };
  }

  it("registers the Lua script once, up front", () => {
    // Read-modify-write across a network is a race; the whole decision has to
    // happen inside Redis as one atomic script.
    const redis = fakeRedis([1, 59, 0]);

    createRateLimiter({
      redis,
      keys: createRedisKeys("t"),
      policy: { requestsPerMinute: 60, burst: 60 },
    });

    expect(redis.defineCommand).toHaveBeenCalledWith(
      "openllmTokenBucket",
      expect.objectContaining({ numberOfKeys: 1 }),
    );
  });

  it("passes the refill rate in tokens per second", async () => {
    const redis = fakeRedis([1, 59, 0]);
    const limiter = createRateLimiter({
      redis,
      keys: createRedisKeys("t"),
      policy: { requestsPerMinute: 120, burst: 30 },
    });

    await limiter.consume("key", "abc");

    // 120/min = 2/s, burst 30, cost 1.
    expect(redis.openllmTokenBucket).toHaveBeenCalledWith(
      expect.stringContaining(":rl:key:abc"),
      "30",
      "2",
      "1",
      expect.any(String),
    );
  });

  it("supports a per-request cost, which is how tokens/minute will work", async () => {
    // Spec §12's evolution: same bucket, cost = LLM tokens instead of 1.
    const redis = fakeRedis([1, 10, 0]);
    const limiter = createRateLimiter({
      redis,
      keys: createRedisKeys("t"),
      policy: { requestsPerMinute: 60, burst: 60 },
    });

    await limiter.consume("key", "abc", 250);

    expect(redis.openllmTokenBucket).toHaveBeenCalledWith(
      expect.any(String),
      "60",
      "1",
      "250",
      expect.any(String),
    );
  });

  it("reports a denial with the wait time", async () => {
    const limiter = createRateLimiter({
      redis: fakeRedis([0, 0, 2_500]),
      keys: createRedisKeys("t"),
      policy: { requestsPerMinute: 60, burst: 60 },
    });

    expect(await limiter.consume("key", "abc")).toMatchObject({
      allowed: false,
      retryAfterMs: 2_500,
      degraded: false,
    });
  });

  it("FAILS OPEN when Redis is unreachable", async () => {
    // A limiter that rejects everything during a Redis blip converts a
    // dependency wobble into a total outage — the limiter, not the load, takes
    // the gateway down.
    const limiter = createRateLimiter({
      redis: fakeRedis(new Error("ECONNREFUSED")),
      keys: createRedisKeys("t"),
      policy: { requestsPerMinute: 60, burst: 60 },
      logger: silentLogger,
    });

    const decision = await limiter.consume("key", "abc");

    expect(decision.allowed).toBe(true);
    // Degraded, not silent: an unlimited gateway is how a bill arrives.
    expect(decision.degraded).toBe(true);
  });

  it("can be told to fail closed instead", async () => {
    const limiter = createRateLimiter({
      redis: fakeRedis(new Error("ECONNREFUSED")),
      keys: createRedisKeys("t"),
      policy: { requestsPerMinute: 60, burst: 60 },
      logger: silentLogger,
      failOpen: false,
    });

    expect(await limiter.consume("key", "abc")).toMatchObject({
      allowed: false,
      degraded: true,
    });
  });
});

describe("response cache key", () => {
  it("is stable for identical requests", () => {
    expect(cacheKeyFor(request, undefined, "global")).toBe(
      cacheKeyFor({ ...request }, undefined, "global"),
    );
  });

  it("changes with anything that changes the output", () => {
    // Anything omitted from the key is a correctness bug: two different
    // requests would collide and one would get the other's answer.
    const base = cacheKeyFor(request, undefined, "global");

    expect(cacheKeyFor({ ...request, model: "other" }, undefined, "global")).not.toBe(base);
    expect(cacheKeyFor({ ...request, temperature: 0.5 }, undefined, "global")).not.toBe(base);
    expect(cacheKeyFor({ ...request, topP: 0.9 }, undefined, "global")).not.toBe(base);
    expect(cacheKeyFor({ ...request, maxOutputTokens: 10 }, undefined, "global")).not.toBe(base);
    expect(cacheKeyFor({ ...request, stop: ["x"] }, undefined, "global")).not.toBe(base);
    expect(
      cacheKeyFor(
        { ...request, messages: [{ role: "user", content: "different" }] },
        undefined,
        "global",
      ),
    ).not.toBe(base);
  });

  it("ignores the caller in global scope and honours it in api-key scope", () => {
    expect(cacheKeyFor(request, "key-a", "global")).toBe(cacheKeyFor(request, "key-b", "global"));
    expect(cacheKeyFor(request, "key-a", "api-key")).not.toBe(
      cacheKeyFor(request, "key-b", "api-key"),
    );
  });

  it("never contains the prompt itself", () => {
    // Prompts must not be recoverable from Redis keys.
    const key = cacheKeyFor(request, undefined, "global");

    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("hello");
  });
});

describe("response cache", () => {
  const response: ChatResponse = {
    id: "resp_1",
    provider: "mock",
    model: "mock",
    content: "hi",
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    createdAt: 1_700_000_000,
  };

  function fakeRedis(overrides: Partial<Record<"get" | "set", unknown>> = {}) {
    return {
      get: overrides.get ?? vi.fn(async () => null),
      set: overrides.set ?? vi.fn(async () => "OK"),
    } as unknown as Redis;
  }

  it("returns undefined on a miss", async () => {
    const cache = createResponseCache({
      redis: fakeRedis(),
      keys: createRedisKeys("t"),
      ttlSeconds: 300,
      scope: "global",
    });

    expect(await cache.get(request, undefined)).toBeUndefined();
  });

  it("round-trips a stored response", async () => {
    const stored = JSON.stringify({ response, cachedAt: 123 });
    const cache = createResponseCache({
      redis: fakeRedis({ get: vi.fn(async () => stored) }),
      keys: createRedisKeys("t"),
      ttlSeconds: 300,
      scope: "global",
    });

    expect((await cache.get(request, undefined))?.response.content).toBe("hi");
  });

  it("writes with the configured TTL", async () => {
    const set = vi.fn(async () => "OK");
    const cache = createResponseCache({
      redis: fakeRedis({ set }),
      keys: createRedisKeys("t"),
      ttlSeconds: 120,
      scope: "global",
    });

    await cache.set(request, undefined, response);

    expect(set).toHaveBeenCalledWith(expect.any(String), expect.any(String), "EX", 120);
  });

  it("degrades to a miss when Redis fails", async () => {
    // A cache is an optimisation; it must never turn into a failed request.
    const cache = createResponseCache({
      redis: fakeRedis({
        get: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      }),
      keys: createRedisKeys("t"),
      ttlSeconds: 300,
      scope: "global",
      logger: silentLogger,
    });

    expect(await cache.get(request, undefined)).toBeUndefined();
  });

  it("degrades to a miss on an unparseable entry", async () => {
    // An entry written by an older version must not break reads.
    const cache = createResponseCache({
      redis: fakeRedis({ get: vi.fn(async () => "{not json") }),
      keys: createRedisKeys("t"),
      ttlSeconds: 300,
      scope: "global",
      logger: silentLogger,
    });

    expect(await cache.get(request, undefined)).toBeUndefined();
  });
});

describe("circuit breaker", () => {
  function fakeRedis(counts: Record<string, string | null>, failing = false) {
    return {
      get: vi.fn(async (key: string) => {
        if (failing) throw new Error("ECONNREFUSED");
        return counts[key] ?? null;
      }),
      del: vi.fn(async () => 1),
      multi: vi.fn(() => ({
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn(async () => [[null, 1]]),
      })),
    } as unknown as Redis;
  }

  const keys = createRedisKeys("t");

  it("stays closed below the threshold", async () => {
    const breaker = createCircuitBreaker({
      redis: fakeRedis({ [keys.providerHealth("openai")]: "3" }),
      keys,
      failureThreshold: 5,
      cooldownSeconds: 30,
    });

    expect(await breaker.isOpen("openai")).toBe(false);
  });

  it("opens at the threshold", async () => {
    const breaker = createCircuitBreaker({
      redis: fakeRedis({ [keys.providerHealth("openai")]: "5" }),
      keys,
      failureThreshold: 5,
      cooldownSeconds: 30,
    });

    expect(await breaker.isOpen("openai")).toBe(true);
  });

  it("treats a Redis failure as CLOSED", async () => {
    // The breaker exists to save time, not to gate traffic. A monitoring
    // dependency must never be able to block requests on its own.
    const breaker = createCircuitBreaker({
      redis: fakeRedis({}, true),
      keys,
      failureThreshold: 5,
      cooldownSeconds: 30,
      logger: silentLogger,
    });

    expect(await breaker.isOpen("openai")).toBe(false);
    expect(await breaker.openProviders(["openai", "gemini"])).toEqual([]);
  });

  it("clears the count outright on success", async () => {
    // Half-open comes free: after the cooldown the key has expired, the next
    // request goes through, and a success makes the provider healthy again.
    const redis = fakeRedis({});
    const breaker = createCircuitBreaker({
      redis,
      keys,
      failureThreshold: 5,
      cooldownSeconds: 30,
    });

    breaker.recordSuccess("openai");

    expect(redis.del).toHaveBeenCalledWith(keys.providerHealth("openai"));
  });

  it("lists only the providers that are open", async () => {
    const breaker = createCircuitBreaker({
      redis: fakeRedis({
        [keys.providerHealth("openai")]: "7",
        [keys.providerHealth("gemini")]: "1",
      }),
      keys,
      failureThreshold: 5,
      cooldownSeconds: 30,
    });

    expect(await breaker.openProviders(["openai", "gemini", "mock"])).toEqual(["openai"]);
  });
});
