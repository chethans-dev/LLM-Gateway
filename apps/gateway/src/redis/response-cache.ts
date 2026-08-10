import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "../observability/logger.js";
import type { ChatRequest, ChatResponse } from "../providers/types.js";
import type { RedisKeys } from "./keys.js";

/**
 * Exact-match response cache.
 *
 * ## Off by default, deliberately
 *
 * Caching an LLM response means **storing the completion at rest**. Spec §14 and
 * §26 make privacy the default, so this cannot be on unless an operator asks for
 * it. Enabling it is a considered trade: real money saved, in exchange for
 * completion text living in Redis for the TTL.
 *
 * The key is a hash, so prompts are not recoverable from Redis keys — but the
 * stored *value* contains the completion in clear text, and anyone who can read
 * the Redis instance can read it. That is stated plainly in the docs rather than
 * buried.
 *
 * ## It changes semantics, and that is why it is opt-in
 *
 * A cached response makes repeated identical calls deterministic even at
 * `temperature: 1`. For most gateway use that is desirable — it is the entire
 * cost saving — but it is a behaviour change, not a transparent optimisation,
 * and the operator is the right person to decide.
 *
 * Temperature is part of the cache key, so requests that differ only in sampling
 * settings never share an entry.
 */

export type CacheScope = "global" | "api-key";

export interface CachedResponse {
  readonly response: ChatResponse;
  /** When the entry was written, for the age header. */
  readonly cachedAt: number;
}

export interface ResponseCache {
  get(request: ChatRequest, apiKeyId: string | undefined): Promise<CachedResponse | undefined>;
  set(
    request: ChatRequest,
    apiKeyId: string | undefined,
    response: ChatResponse,
  ): Promise<void>;
}

export interface ResponseCacheDeps {
  readonly redis: Redis;
  readonly keys: RedisKeys;
  readonly ttlSeconds: number;
  readonly scope: CacheScope;
  readonly logger?: Logger;
}

/**
 * Hash everything that can change the output.
 *
 * Anything omitted here is a correctness bug: two requests that differ in a
 * missing field would collide and one would receive the other's answer. Hence
 * the explicit, ordered construction rather than hashing the request object —
 * an object hash would silently include or exclude fields as the type evolves.
 */
export function cacheKeyFor(
  request: ChatRequest,
  apiKeyId: string | undefined,
  scope: CacheScope,
): string {
  const material = JSON.stringify({
    // The RESOLVED model, not what the client asked for: `fast` and
    // `gpt-4.1-mini` must share an entry when they resolve to the same thing.
    model: request.model,
    messages: request.messages.map((message) => [message.role, message.content]),
    temperature: request.temperature ?? null,
    maxOutputTokens: request.maxOutputTokens ?? null,
    topP: request.topP ?? null,
    stop: request.stop ?? null,
    // Per-key scoping for operators who would rather not share entries between
    // tenants at all, even though a hit requires sending the identical prompt.
    scope: scope === "api-key" ? (apiKeyId ?? "anonymous") : "global",
  });

  return createHash("sha256").update(material).digest("hex");
}

export function createResponseCache(deps: ResponseCacheDeps): ResponseCache {
  const { redis, keys, ttlSeconds, scope, logger } = deps;

  return {
    async get(request, apiKeyId): Promise<CachedResponse | undefined> {
      try {
        const raw = await redis.get(keys.cache(cacheKeyFor(request, apiKeyId, scope)));
        if (raw === null) return undefined;
        return JSON.parse(raw) as CachedResponse;
      } catch (error) {
        // A cache is an optimisation. Redis being down, or an entry written by
        // an older version failing to parse, must degrade to a miss — never to
        // a failed request.
        logger?.warn({ err: error }, "response cache read failed; treating as a miss");
        return undefined;
      }
    },

    async set(request, apiKeyId, response): Promise<void> {
      try {
        const entry: CachedResponse = { response, cachedAt: Date.now() };
        await redis.set(
          keys.cache(cacheKeyFor(request, apiKeyId, scope)),
          JSON.stringify(entry),
          "EX",
          ttlSeconds,
        );
      } catch (error) {
        logger?.warn({ err: error }, "response cache write failed");
      }
    },
  };
}
