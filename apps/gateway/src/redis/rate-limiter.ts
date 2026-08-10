import type { Redis, Result } from "ioredis";
import type { Logger } from "../observability/logger.js";
import type { RedisKeys } from "./keys.js";

/**
 * Atomic token-bucket rate limiting (spec §12).
 *
 * ## Why a token bucket
 *
 * Spec §12 asks for requests/minute now and **tokens/minute later**. A token
 * bucket gives both from one implementation: the "cost" of a request is a
 * parameter, so requests/minute is cost = 1 and tokens/minute is cost = N. A
 * fixed-window counter cannot express that without being rewritten.
 *
 * It also avoids the fixed window's worst property: a client can send a full
 * window's worth of requests at 11:59:59 and another full window at 12:00:00,
 * so a "60/minute" limit permits 120 in one second. A bucket refills
 * continuously and has no boundary to exploit.
 *
 * ## Why Lua
 *
 * Read-modify-write across a network is a race. Two concurrent requests both
 * read 1 token remaining, both decide they may proceed, and the limit is
 * breached — exactly the race spec §12 says to avoid. The whole operation
 * therefore runs inside Redis as one script, which Redis executes atomically.
 *
 * ## Why the Redis clock
 *
 * `redis.call('TIME')` rather than a timestamp from the gateway. With several
 * gateway instances sharing one Redis, clock skew between them would make the
 * bucket refill inconsistently — one instance's "now" running ahead grants free
 * tokens. There is exactly one clock that all instances agree on, and it is the
 * one inside Redis.
 */
const TOKEN_BUCKET_SCRIPT = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])  -- tokens per second
local cost       = tonumber(ARGV[3])
local ttl        = tonumber(ARGV[4])

-- One clock every instance agrees on.
local time = redis.call('TIME')
local now  = tonumber(time[1]) + (tonumber(time[2]) / 1000000)

local stored = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(stored[1])
local ts     = tonumber(stored[2])

if tokens == nil or ts == nil then
  -- A new bucket starts full, so a first-time caller is never penalised.
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed * refillRate))

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Idle buckets expire rather than accumulating forever. An expired bucket is
-- indistinguishable from a full one, which is the correct behaviour anyway.
redis.call('EXPIRE', key, ttl)

local retryAfterMs = 0
if allowed == 0 then
  retryAfterMs = math.ceil(((cost - tokens) / refillRate) * 1000)
end

-- Redis truncates Lua numbers to integers on the way out, so floor explicitly
-- rather than relying on that.
return { allowed, math.floor(tokens), retryAfterMs }
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    openllmTokenBucket(
      key: string,
      capacity: string,
      refillRate: string,
      cost: string,
      ttl: string,
    ): Result<[number, number, number], Context>;
  }
}

export interface RateLimitPolicy {
  /** Sustained rate. */
  readonly requestsPerMinute: number;
  /** Bucket size — how much of the budget may be spent at once. */
  readonly burst: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterMs: number;
  /** True when Redis was unreachable and the request was let through. */
  readonly degraded: boolean;
}

export interface RateLimiter {
  /**
   * @param cost tokens to consume — 1 per request today, an LLM token count
   *   when tokens/minute lands (spec §12). The bucket does not care which.
   */
  consume(scope: string, identifier: string, cost?: number): Promise<RateLimitDecision>;
}

export interface RateLimiterDeps {
  readonly redis: Redis;
  readonly keys: RedisKeys;
  readonly policy: RateLimitPolicy;
  readonly logger?: Logger;
  /** Let a rate-limit failure through rather than failing the request. */
  readonly failOpen?: boolean;
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const { redis, keys, policy, logger } = deps;
  const failOpen = deps.failOpen ?? true;

  redis.defineCommand("openllmTokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET_SCRIPT });

  const refillPerSecond = policy.requestsPerMinute / 60;
  // Long enough that a bucket mid-refill is never dropped, short enough that
  // idle callers do not occupy memory indefinitely.
  const ttlSeconds = Math.max(60, Math.ceil((policy.burst / refillPerSecond) * 2));

  return {
    async consume(scope, identifier, cost = 1): Promise<RateLimitDecision> {
      try {
        const [allowed, remaining, retryAfterMs] = await redis.openllmTokenBucket(
          keys.rateLimit(scope, identifier),
          String(policy.burst),
          String(refillPerSecond),
          String(cost),
          String(ttlSeconds),
        );

        return {
          allowed: allowed === 1,
          limit: policy.requestsPerMinute,
          remaining: Math.max(0, remaining),
          retryAfterMs,
          degraded: false,
        };
      } catch (error) {
        // Fail OPEN by default. A rate limiter that rejects everything when
        // Redis blips converts a dependency wobble into a total outage — it
        // would be the limiter, not the load, taking the gateway down. The
        // degraded flag makes the state visible rather than silent.
        logger?.error(
          { err: error, scope, failOpen },
          "rate limit check failed; Redis may be unavailable",
        );

        if (!failOpen) {
          return {
            allowed: false,
            limit: policy.requestsPerMinute,
            remaining: 0,
            retryAfterMs: 1_000,
            degraded: true,
          };
        }

        return {
          allowed: true,
          limit: policy.requestsPerMinute,
          remaining: policy.burst,
          retryAfterMs: 0,
          degraded: true,
        };
      }
    },
  };
}
