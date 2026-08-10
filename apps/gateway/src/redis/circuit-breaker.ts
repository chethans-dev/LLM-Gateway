import type { ProviderId } from "@openllm/core";
import type { Redis } from "ioredis";
import type { Logger } from "../observability/logger.js";
import type { RedisKeys } from "./keys.js";

/**
 * Provider health, shared across gateway instances (spec §12: "provider state").
 *
 * When a provider is down, every request still pays its timeout before failing
 * over. With a 30s provider timeout and a three-target route, a dead first
 * provider adds 30 seconds to *every* request until someone notices. The point
 * of tracking failures is to stop paying that toll.
 *
 * State lives in Redis rather than in process memory because a gateway usually
 * runs several replicas: in-memory counters mean each replica has to rediscover
 * the outage independently, and a replica that just started knows nothing.
 *
 * Two rules keep this from becoming a liability of its own:
 *
 *  - **Redis failure means closed.** If the breaker cannot read its own state it
 *    allows the call. A monitoring dependency must never be able to block
 *    traffic on its own.
 *  - **Never open every path.** If all targets are open, the router tries anyway
 *    — a guaranteed failure is worse than a probably-failing attempt, and it is
 *    how the circuit gets a chance to close again.
 */

export interface CircuitBreaker {
  isOpen(provider: ProviderId): Promise<boolean>;
  recordSuccess(provider: ProviderId): void;
  recordFailure(provider: ProviderId): void;
  /** Providers currently considered unhealthy, for /ready and diagnostics. */
  openProviders(providers: readonly ProviderId[]): Promise<readonly ProviderId[]>;
}

export interface CircuitBreakerDeps {
  readonly redis: Redis;
  readonly keys: RedisKeys;
  /** Consecutive failures before the circuit opens. */
  readonly failureThreshold: number;
  /** How long it stays open before a request is allowed through to test it. */
  readonly cooldownSeconds: number;
  readonly logger?: Logger;
}

export function createCircuitBreaker(deps: CircuitBreakerDeps): CircuitBreaker {
  const { redis, keys, failureThreshold, cooldownSeconds, logger } = deps;

  async function failureCount(provider: ProviderId): Promise<number> {
    const raw = await redis.get(keys.providerHealth(provider));
    return raw === null ? 0 : Number.parseInt(raw, 10) || 0;
  }

  return {
    async isOpen(provider: ProviderId): Promise<boolean> {
      try {
        return (await failureCount(provider)) >= failureThreshold;
      } catch (error) {
        // Closed on error: the breaker exists to save time, not to gate traffic.
        logger?.warn({ err: error, provider }, "circuit breaker read failed; treating as closed");
        return false;
      }
    },

    recordSuccess(provider: ProviderId): void {
      // One success closes the circuit outright rather than decrementing.
      // Half-open behaviour comes free: after the cooldown the key has expired,
      // the next request is allowed, and if it succeeds the provider is healthy
      // again immediately.
      void redis.del(keys.providerHealth(provider)).catch((error: unknown) => {
        logger?.debug({ err: error, provider }, "failed to clear provider failure count");
      });
    },

    recordFailure(provider: ProviderId): void {
      // Not awaited: recording health must not add latency to a request that
      // has already failed and is on its way to a fallback.
      void redis
        .multi()
        .incr(keys.providerHealth(provider))
        // Refreshed on every failure, so the circuit stays open while a provider
        // keeps failing and closes on its own once it stops.
        .expire(keys.providerHealth(provider), cooldownSeconds)
        .exec()
        .then((results) => {
          const count = results?.[0]?.[1];
          if (typeof count === "number" && count === failureThreshold) {
            logger?.warn(
              { provider, failures: count, cooldownSeconds },
              "provider circuit opened; requests will skip it until it recovers",
            );
          }
        })
        .catch((error: unknown) => {
          logger?.debug({ err: error, provider }, "failed to record provider failure");
        });
    },

    async openProviders(providers): Promise<readonly ProviderId[]> {
      try {
        const counts = await Promise.all(providers.map((provider) => failureCount(provider)));
        return providers.filter((_, index) => (counts[index] ?? 0) >= failureThreshold);
      } catch (error) {
        logger?.warn({ err: error }, "circuit breaker sweep failed");
        return [];
      }
    },
  };
}
