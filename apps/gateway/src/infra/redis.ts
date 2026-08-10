import { Redis } from "ioredis";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import { withTimeout, type Closable, type DependencyCheck } from "./dependency.js";

export interface RedisClient extends DependencyCheck, Closable {
  readonly redis: Redis;
}

/**
 * Redis client.
 *
 * `enableOfflineQueue: false` is the important setting. ioredis defaults to
 * buffering commands while disconnected and replaying them on reconnect. For a
 * gateway that is the wrong behaviour twice over: the readiness probe would hang
 * instead of reporting Redis down, and (from Phase 8) rate-limit increments would
 * be replayed against a window that has already closed.
 *
 * `maxRetriesPerRequest: 1` likewise favours failing fast over queueing behind a
 * dead server.
 */
export function createRedisClient(config: AppConfig, logger: Logger): RedisClient {
  const redis = new Redis(config.redis.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Bounded backoff: retry quickly at first, then settle at 2s. Returning a
    // number (never null) keeps reconnecting forever, so a Redis outage degrades
    // readiness rather than permanently poisoning the client.
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });

  // ioredis emits 'error' on every failed connection attempt. An EventEmitter
  // 'error' with no listener is a hard process crash — so this listener is not
  // optional, it is what stops a Redis blip from killing the gateway.
  redis.on("error", (error: Error) => {
    logger.warn({ err: error, dependency: "redis" }, "redis connection error");
  });

  redis.on("ready", () => {
    logger.info({ dependency: "redis" }, "redis connected");
  });

  return {
    name: "redis",
    redis,
    async ping(timeoutMs: number): Promise<void> {
      await withTimeout(redis.ping(), timeoutMs, "redis ping");
    },
    async close(): Promise<void> {
      // quit() waits for pending replies; disconnect() drops them. During a
      // graceful shutdown we want the former, but never indefinitely.
      try {
        await withTimeout(redis.quit(), 5_000, "redis quit");
      } catch {
        redis.disconnect();
      }
    },
  };
}

/**
 * Open the connection, tolerating failure.
 *
 * A gateway that refuses to boot because Redis is briefly unavailable cannot
 * report *why* it is unhealthy. Booting and failing readiness is strictly more
 * observable, and ioredis reconnects in the background.
 */
export async function connectRedis(client: RedisClient, logger: Logger): Promise<void> {
  try {
    await client.redis.connect();
  } catch (error) {
    logger.warn(
      { err: error, dependency: "redis" },
      "initial redis connection failed; continuing in not-ready state",
    );
  }
}
