import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createRedisKeys } from "../../src/redis/keys.js";
import { createRateLimiter, type RateLimiter } from "../../src/redis/rate-limiter.js";
import { createCircuitBreaker } from "../../src/redis/circuit-breaker.js";
import { createResponseCache } from "../../src/redis/response-cache.js";
import type { ChatRequest, ChatResponse } from "../../src/providers/types.js";
import { silentLogger } from "../helpers/build-test-server.js";

/**
 * Redis features against a real Redis.
 *
 *   docker compose up -d redis
 *   INTEGRATION_TESTS=1 pnpm test:integration
 *
 * The concurrency test here is the one that matters: it is the only way to
 * demonstrate the atomicity spec §12 requires. A fake Redis cannot exhibit the
 * read-modify-write race the Lua script exists to prevent.
 */
const enabled = process.env["INTEGRATION_TESTS"] === "1";

describe.skipIf(!enabled)("rate limiting against real Redis", () => {
  let redis: Redis;
  const keys = createRedisKeys("openllm-test");

  beforeAll(() => {
    redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
    });
  });

  beforeEach(async () => {
    const existing = await redis.keys(`${keys.namespace}:*`);
    if (existing.length > 0) await redis.del(...existing);
  });

  afterAll(async () => {
    const existing = await redis.keys(`${keys.namespace}:*`);
    if (existing.length > 0) await redis.del(...existing);
    await redis.quit();
  });

  function limiter(requestsPerMinute: number, burst: number): RateLimiter {
    return createRateLimiter({
      redis,
      keys,
      policy: { requestsPerMinute, burst },
      logger: silentLogger,
    });
  }

  it("allows up to the burst, then denies", async () => {
    const limit = limiter(60, 5);
    const results: boolean[] = [];

    for (let i = 0; i < 7; i += 1) {
      results.push((await limit.consume("key", "sequential")).allowed);
    }

    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  it("is ATOMIC under concurrency", async () => {
    // The point of the Lua script. Twenty simultaneous requests against a
    // bucket of five must produce exactly five successes — a read-modify-write
    // in application code would let several requests each observe "1 token
    // left" and all proceed.
    const limit = limiter(60, 5);

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => limit.consume("key", "concurrent")),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions.every((decision) => !decision.degraded)).toBe(true);
  });

  it("stays atomic across separate limiter instances", async () => {
    // Two gateway replicas sharing one Redis. If the bucket were per-process,
    // the effective limit would be N times the configured one.
    const a = limiter(60, 4);
    const b = limiter(60, 4);

    const decisions = await Promise.all([
      ...Array.from({ length: 10 }, () => a.consume("key", "replicas")),
      ...Array.from({ length: 10 }, () => b.consume("key", "replicas")),
    ]);

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(4);
  });

  it("keeps separate callers in separate buckets", async () => {
    const limit = limiter(60, 2);

    await limit.consume("key", "alice");
    await limit.consume("key", "alice");

    expect((await limit.consume("key", "alice")).allowed).toBe(false);
    expect((await limit.consume("key", "bob")).allowed).toBe(true);
  });

  it("refills over time", async () => {
    // 600/min = 10/s, so ~200ms is worth two tokens.
    const limit = limiter(600, 2);

    expect((await limit.consume("key", "refill")).allowed).toBe(true);
    expect((await limit.consume("key", "refill")).allowed).toBe(true);
    expect((await limit.consume("key", "refill")).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect((await limit.consume("key", "refill")).allowed).toBe(true);
  });

  it("charges a larger cost against the same bucket", async () => {
    // How tokens/minute will work: cost stops being 1.
    const limit = limiter(60, 10);

    expect((await limit.consume("key", "cost", 8)).allowed).toBe(true);
    expect((await limit.consume("key", "cost", 8)).allowed).toBe(false);
    expect((await limit.consume("key", "cost", 2)).allowed).toBe(true);
  });

  it("reports a usable retry-after when denied", async () => {
    const limit = limiter(60, 1);
    await limit.consume("key", "retry-after");

    const denied = await limit.consume("key", "retry-after");

    expect(denied.allowed).toBe(false);
    // 60/min = 1/s, so roughly a second to earn the next token.
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1_100);
  });

  it("starts a first-time caller with a full bucket", async () => {
    expect((await limiter(60, 3).consume("key", "brand-new")).remaining).toBeGreaterThan(0);
  });

  it("expires idle buckets rather than accumulating them forever", async () => {
    const limit = limiter(60, 5);
    await limit.consume("key", "ttl-check");

    const ttl = await redis.ttl(keys.rateLimit("key", "ttl-check"));

    expect(ttl).toBeGreaterThan(0);
  });
});

describe.skipIf(!enabled)("circuit breaker against real Redis", () => {
  let redis: Redis;
  const keys = createRedisKeys("openllm-test-breaker");

  beforeAll(() => {
    redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
  });

  beforeEach(async () => {
    const existing = await redis.keys(`${keys.namespace}:*`);
    if (existing.length > 0) await redis.del(...existing);
  });

  afterAll(async () => {
    const existing = await redis.keys(`${keys.namespace}:*`);
    if (existing.length > 0) await redis.del(...existing);
    await redis.quit();
  });

  function breaker(threshold = 3, cooldown = 30) {
    return createCircuitBreaker({
      redis,
      keys,
      failureThreshold: threshold,
      cooldownSeconds: cooldown,
      logger: silentLogger,
    });
  }

  async function settle(): Promise<void> {
    // recordFailure/recordSuccess are fire-and-forget by design.
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  it("opens after consecutive failures and closes on success", async () => {
    const circuit = breaker(3);

    circuit.recordFailure("openai");
    circuit.recordFailure("openai");
    await settle();
    expect(await circuit.isOpen("openai")).toBe(false);

    circuit.recordFailure("openai");
    await settle();
    expect(await circuit.isOpen("openai")).toBe(true);

    // One success is enough — a provider that recovered should not have to
    // earn its way back one decrement at a time.
    circuit.recordSuccess("openai");
    await settle();
    expect(await circuit.isOpen("openai")).toBe(false);
  });

  it("is shared between instances, so replicas learn from each other", async () => {
    const a = breaker(2);
    const b = breaker(2);

    a.recordFailure("gemini");
    a.recordFailure("gemini");
    await settle();

    expect(await b.isOpen("gemini")).toBe(true);
  });

  it("closes on its own once the cooldown expires", async () => {
    const circuit = breaker(1, 1);

    circuit.recordFailure("anthropic");
    await settle();
    expect(await circuit.isOpen("anthropic")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // The key expired; the next request is allowed through to test the provider.
    expect(await circuit.isOpen("anthropic")).toBe(false);
  });
});

describe.skipIf(!enabled)("response cache against real Redis", () => {
  let redis: Redis;
  const keys = createRedisKeys("openllm-test-cache");

  const request: ChatRequest = {
    model: "mock",
    messages: [{ role: "user", content: "cached question" }],
  };
  const response: ChatResponse = {
    id: "resp_1",
    provider: "mock",
    model: "mock",
    content: "cached answer",
    finishReason: "stop",
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    createdAt: 1_700_000_000,
  };

  beforeAll(() => {
    redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
  });

  afterAll(async () => {
    const existing = await redis.keys(`${keys.namespace}:*`);
    if (existing.length > 0) await redis.del(...existing);
    await redis.quit();
  });

  it("round-trips through Redis and sets a TTL", async () => {
    const cache = createResponseCache({
      redis,
      keys,
      ttlSeconds: 60,
      scope: "global",
      logger: silentLogger,
    });

    expect(await cache.get(request, undefined)).toBeUndefined();

    await cache.set(request, undefined, response);
    const hit = await cache.get(request, undefined);

    expect(hit?.response.content).toBe("cached answer");
    // Entries must not live forever — completion content is at rest here.
    expect(await redis.ttl(keys.cache(await onlyCacheKey()))).toBeGreaterThan(0);
  });

  async function onlyCacheKey(): Promise<string> {
    const found = await redis.keys(`${keys.namespace}:cache:*`);
    return found[0]!.split(":").pop()!;
  }
});
