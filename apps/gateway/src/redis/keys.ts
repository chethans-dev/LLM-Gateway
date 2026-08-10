/**
 * Redis key strategy (spec §12).
 *
 * Every key is `{prefix}:{version}:{feature}:{...}`:
 *
 *   openllm:v1:rl:key:3f2a…          rate limit bucket
 *   openllm:v1:cache:9c81…           cached response
 *   openllm:v1:health:openai         provider failure state
 *
 * The **prefix** lets several gateways (or a staging and a production
 * deployment) share one Redis without colliding, and makes
 * `SCAN MATCH openllm:*` a usable operational tool.
 *
 * The **version** is the part people skip and regret. When the rate-limit value
 * format changes, a rolling deploy has both formats live at once; without a
 * version in the key, new code reads old values and the limiter silently
 * misbehaves for the length of the rollout. Bumping the version makes the old
 * keys invisible, and they expire on their own.
 */
export const KEY_SCHEMA_VERSION = "v1";

export interface RedisKeys {
  rateLimit(scope: string, identifier: string): string;
  cache(hash: string): string;
  providerHealth(provider: string): string;
  /** For diagnostics and tests — never used to build a key. */
  readonly namespace: string;
}

export function createRedisKeys(prefix: string): RedisKeys {
  const namespace = `${prefix}:${KEY_SCHEMA_VERSION}`;

  return {
    namespace,
    rateLimit: (scope, identifier) => `${namespace}:rl:${scope}:${identifier}`,
    cache: (hash) => `${namespace}:cache:${hash}`,
    providerHealth: (provider) => `${namespace}:health:${provider}`,
  };
}
