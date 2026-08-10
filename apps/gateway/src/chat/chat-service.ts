import { LLMError, type ProviderId } from "@openllm/core";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatChunk, ChatRequest, ChatResponse } from "../providers/types.js";
import { createDeadline, type Deadline } from "../routing/deadline.js";
import {
  runWithFallback,
  streamWithFallback,
  type FailedAttempt,
  type StartedStream,
} from "../routing/fallback.js";
import type { CircuitBreaker } from "../redis/circuit-breaker.js";
import type { ResponseCache } from "../redis/response-cache.js";
import { withRetry, type RetryDeps } from "../routing/retry.js";
import {
  buildRouteTable,
  planTargets,
  type RouteTable,
  type RouteTarget,
} from "../routing/route-table.js";

export interface ChatCompletionOutcome {
  readonly response: ChatResponse;
  readonly provider: ProviderId;
  /** Wall time for the whole operation, retries and fallbacks included. */
  readonly latencyMs: number;
  readonly route: string | undefined;
  /** Targets that failed before this one succeeded. */
  readonly failedAttempts: readonly FailedAttempt[];
  /** Total provider calls made, counting retries. */
  readonly providerCalls: number;
  /** True when the response came from cache and no provider was called. */
  readonly cached: boolean;
}

export interface ChatServiceDeps {
  readonly registry: ProviderRegistry;
  readonly config: AppConfig;
  readonly logger?: Logger;
  /** Injected in tests so backoff costs no real time. */
  readonly retryDeps?: RetryDeps;
  /** Optional. Absent means every request goes to a provider. */
  readonly cache?: ResponseCache;
  /** Optional. Absent means no provider is ever skipped. */
  readonly breaker?: CircuitBreaker;
}

export interface ChatStream {
  readonly route: string | undefined;
  readonly chunks: AsyncIterable<ChatChunk>;
  /** Provider calls made so far. Only final once the stream has started. */
  callCount(): number;
}

export interface ChatCompletionContext {
  /** Scopes the cache when CACHE_SCOPE=api-key. */
  readonly apiKeyId?: string | undefined;
}

export interface ChatService {
  complete(
    request: ChatRequest,
    signal: AbortSignal,
    context?: ChatCompletionContext,
  ): Promise<ChatCompletionOutcome>;
  stream(request: ChatRequest, signal: AbortSignal): ChatStream;
  readonly routes: RouteTable;
}

/**
 * Orchestrates a completion: plan the route, then run it under retry, fallback
 * and two independent timeouts.
 *
 * The composition is deliberate and this is the file that owns it:
 *
 *     for each target in the route:        <- fallback  (a different provider)
 *       for each attempt on that target:   <- retry     (the same provider)
 *         one provider call                <- PROVIDER_TIMEOUT_MS
 *     ...all bounded by                    <- REQUEST_TIMEOUT_MS
 *
 * Retries are exhausted on a target before moving on, so a single-target route
 * still recovers from a transient blip, and a multi-target route does not skip
 * past a provider that was one retry away from succeeding. Both decisions read
 * the normalized error flags — `retryable` for the inner loop, `failoverable`
 * for the outer — never a provider's status codes or message text.
 */
export function createChatService(deps: ChatServiceDeps): ChatService {
  const { registry, config, logger } = deps;
  const { retry: retryPolicy, timeoutMs, requestTimeoutMs } = config.reliability;

  // Throws on a bad route definition, so misconfiguration fails at boot.
  const routes = buildRouteTable(config.routing.routes);

  /**
   * The signal for ONE provider call.
   *
   * Rebuilt per attempt — a single shared timeout would have been consumed by
   * the first attempt and would kill every retry after it. Capped by whatever
   * remains of the overall budget so no attempt can outlive the request.
   */
  function attemptSignal(signal: AbortSignal, deadline: Deadline): AbortSignal {
    const budget = Math.max(1, Math.min(timeoutMs, deadline.remainingMs()));
    // AbortSignal.any means either reason actually cancels the upstream HTTP
    // request rather than merely abandoning the promise, so we stop paying for
    // tokens nobody will read.
    return AbortSignal.any([signal, AbortSignal.timeout(budget)]);
  }

  function onFailover(attempt: FailedAttempt, next: RouteTarget): void {
    // Warn, not info: falling over means something upstream is wrong, and an
    // AUTHENTICATION_ERROR here means OUR credential is broken and is being
    // masked by the fallback. That must stay visible.
    logger?.warn(
      {
        failedProvider: attempt.provider,
        failedModel: attempt.model,
        code: attempt.code,
        latencyMs: attempt.latencyMs,
        nextProvider: next.provider,
        nextModel: next.model,
      },
      attempt.code === "AUTHENTICATION_ERROR"
        ? "provider credential rejected; falling back (fix the credential)"
        : "provider failed; falling back",
    );
  }

  /** Wrap a single target's call in the retry policy. */
  function retryContext(target: RouteTarget, signal: AbortSignal, deadline: Deadline) {
    return {
      policy: retryPolicy,
      deadline,
      signal,
      ...deps.retryDeps,
      onRetry: (info: {
        attempt: number;
        delayMs: number;
        code: string;
        honouredRetryAfter: boolean;
      }) => {
        logger?.warn(
          {
            provider: target.provider,
            model: target.model,
            attempt: info.attempt,
            maxAttempts: retryPolicy.maxAttempts,
            delayMs: info.delayMs,
            code: info.code,
            // Distinguishes "the provider told us how long" from our own guess.
            honouredRetryAfter: info.honouredRetryAfter,
          },
          "provider call failed; retrying after backoff",
        );
      },
    };
  }

  /**
   * Drop targets whose circuit is open — but never all of them.
   *
   * If every provider looks unhealthy, trying one is strictly better than
   * returning a guaranteed failure without a call: it is also the only way the
   * circuit ever gets the chance to close again.
   */
  async function healthyTargets(
    targets: readonly RouteTarget[],
  ): Promise<readonly RouteTarget[]> {
    if (deps.breaker === undefined || targets.length <= 1) return targets;

    const open = new Set(
      await deps.breaker.openProviders(targets.map((target) => target.provider)),
    );
    const healthy = targets.filter((target) => !open.has(target.provider));

    if (healthy.length === 0) return targets;
    if (healthy.length < targets.length) {
      logger?.debug(
        { skipped: [...open], remaining: healthy.length },
        "skipping providers with an open circuit",
      );
    }
    return healthy;
  }

  /** Only provider-side failures count against a provider's health. */
  function recordProviderFailure(target: RouteTarget, error: unknown): void {
    // A malformed request would fail identically anywhere; counting it against
    // the provider would open circuits on every provider because of one bad
    // client.
    if (LLMError.is(error) && !error.failoverable) return;
    deps.breaker?.recordFailure(target.provider);
  }

  return {
    routes,

    async complete(
      request: ChatRequest,
      signal: AbortSignal,
      context: ChatCompletionContext = {},
    ): Promise<ChatCompletionOutcome> {
      const plan = planTargets(request.model, routes);
      const deadline = createDeadline(requestTimeoutMs);
      const startedAt = performance.now();

      const cached = await deps.cache?.get(
        { ...request, model: plan.targets[0]?.model ?? request.model },
        context.apiKeyId,
      );
      if (cached !== undefined) {
        return {
          response: cached.response,
          provider: cached.response.provider,
          latencyMs: Math.round(performance.now() - startedAt),
          route: plan.route?.name,
          failedAttempts: [],
          providerCalls: 0,
          cached: true,
        };
      }

      const targets = await healthyTargets(plan.targets);

      let providerCalls = 0;
      const countCall = (): void => {
        providerCalls += 1;
      };

      const outcome = await runWithFallback(
        targets,
        async (target) => {
          const result = await withRetry(
            async () => {
              countCall();
              // Throws MODEL_NOT_FOUND (failoverable, not retryable) if the
              // provider is not configured, so an unconfigured target costs one
              // cheap attempt and no backoff.
              const provider = registry.require(target.provider);
              // The provider is handed the model name as IT knows it, so no
              // adapter has to understand our routing syntax.
              try {
                const response = await provider.chat(
                  { ...request, model: target.model },
                  { signal: attemptSignal(signal, deadline) },
                );
                deps.breaker?.recordSuccess(target.provider);
                return response;
              } catch (error) {
                recordProviderFailure(target, error);
                throw error;
              }
            },
            retryContext(target, signal, deadline),
          );
          return result.value;
        },
        { onFailover },
      );

      // Written after the fact and never awaited on the way in — a cache write
      // failing must not fail a request that already succeeded.
      void deps.cache?.set(
        { ...request, model: outcome.target.model },
        context.apiKeyId,
        outcome.value,
      );

      return {
        response: outcome.value,
        provider: outcome.target.provider,
        latencyMs: Math.round(performance.now() - startedAt),
        route: plan.route?.name,
        failedAttempts: outcome.failed,
        providerCalls,
        cached: false,
      };
    },

    stream(request: ChatRequest, signal: AbortSignal): ChatStream {
      // Streaming is deliberately NOT cached: a cached stream would replay
      // instantly with none of the incremental delivery the client asked for,
      // and the value is the full response, which the buffered path already
      // caches under a different key shape.
      const plan = planTargets(request.model, routes);
      const deadline = createDeadline(requestTimeoutMs);

      let providerCalls = 0;
      const countCall = (): void => {
        providerCalls += 1;
      };

      return {
        route: plan.route?.name,
        callCount: () => providerCalls,
        chunks: streamWithFallback(
          plan.targets,
          async (target): Promise<StartedStream> => {
            const result = await withRetry(async () => {
              countCall();
              const chunks = registry
                .require(target.provider)
                .stream(
                  { ...request, model: target.model },
                  { signal: attemptSignal(signal, deadline) },
                );
              const iterator = chunks[Symbol.asyncIterator]();

              try {
                // Pulling the first chunk here is what makes retry and fallback
                // possible at all for streams: adapters throw on a non-OK status
                // before yielding, so this is the last moment a swap is safe.
                const first = await iterator.next();
                deps.breaker?.recordSuccess(target.provider);
                return { iterator, first };
              } catch (error) {
                // Release the failed attempt's connection before retrying.
                await iterator.return?.().catch(() => {});
                recordProviderFailure(target, error);
                throw error;
              }
            }, retryContext(target, signal, deadline));

            return result.value;
          },
          { onFailover },
        ),
      };
    },
  };
}
