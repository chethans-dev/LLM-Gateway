import { LLMError } from "@openllm/core";
import { abortableSleep, type Sleep } from "../infra/sleep.js";
import type { Deadline } from "./deadline.js";

/**
 * Retry with exponential backoff (spec §9).
 *
 * Retry is provider-independent: the decision comes from the normalized
 * `retryable` flag, never from a provider's status codes or message text. That
 * is what the Phase 2 error model was for.
 *
 * Note the division of labour with fallback:
 *
 *   retry    — the same provider, for a failure it might recover from
 *   fallback — a different provider, when this one cannot help
 *
 * Retries are exhausted on a target before moving to the next one, so a
 * single-target route still gets recovery and a multi-target route does not skip
 * straight past a provider that was about to succeed.
 */

export interface RetryPolicy {
  /** Total attempts per target, including the first. 1 disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /**
   * Randomize the delay.
   *
   * On by default, and it matters more than it looks. Without jitter every
   * client that hit the same provider outage retries at the same instant,
   * re-creating the load spike that caused it — a thundering herd the gateway
   * would be amplifying rather than absorbing, since it sits in front of many
   * callers at once.
   */
  readonly jitter: boolean;
}

export interface RetryDeps {
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

export interface RetryAttemptInfo {
  /** The attempt that just failed, 1-based. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly code: string;
  readonly message: string;
  /** True when the provider told us how long to wait via Retry-After. */
  readonly honouredRetryAfter: boolean;
}

export interface RetryContext extends RetryDeps {
  readonly policy: RetryPolicy;
  readonly deadline: Deadline;
  /** Client hangup or overall cancellation. Aborts the backoff wait too. */
  readonly signal: AbortSignal;
  onRetry?(info: RetryAttemptInfo): void;
}

export interface RetryOutcome<T> {
  readonly value: T;
  /** Provider calls made, including the successful one. */
  readonly attempts: number;
}

/**
 * Base schedule: 250ms, 500ms, 1000ms … capped at maxDelayMs (spec §9).
 *
 * `attempt` is the 1-based number of the attempt that just failed, so the wait
 * before attempt 2 is computed with attempt = 1.
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);

  if (!policy.jitter) return capped;

  // Equal jitter: half the delay is fixed, half is random. Keeps the spec's
  // schedule as the expected value while breaking client synchronisation —
  // full jitter would sometimes retry almost immediately, which is worse when
  // the provider is genuinely overloaded.
  return Math.round(capped / 2 + random() * (capped / 2));
}

/** Providers that send Retry-After know better than our guess. */
function retryAfterFrom(error: LLMError): number | undefined {
  const hint = error.details?.["retryAfterMs"];
  return typeof hint === "number" && Number.isFinite(hint) && hint >= 0 ? hint : undefined;
}

function asLLMError(error: unknown): LLMError {
  return LLMError.is(error)
    ? error
    : LLMError.internal(error instanceof Error ? error.message : "provider call failed", {
        cause: error,
      });
}

/**
 * Run an operation, retrying retryable failures until the policy or the budget
 * says stop.
 *
 * Stops immediately — no wait, no further attempts — when:
 *  - the error is not retryable (a malformed request fails the same way twice);
 *  - attempts are exhausted;
 *  - the remaining budget cannot fit the backoff plus another call. Sleeping
 *    only to then abandon the request wastes the caller's time and ours.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  context: RetryContext,
): Promise<RetryOutcome<T>> {
  const sleep = context.sleep ?? abortableSleep;
  const random = context.random ?? Math.random;
  const { policy, deadline, signal } = context;

  let attempt = 0;

  for (;;) {
    attempt += 1;

    try {
      return { value: await operation(attempt), attempts: attempt };
    } catch (error) {
      const normalized = asLLMError(error);

      if (!normalized.retryable) throw normalized;
      if (attempt >= policy.maxAttempts) throw normalized;
      // The caller is gone, or the overall budget is spent.
      if (signal.aborted || deadline.expired()) throw normalized;

      const hint = retryAfterFrom(normalized);
      // Cap our own guess at maxDelayMs; a provider's explicit hint is honoured
      // as given, since it reflects their actual limit rather than our model.
      const delayMs = hint ?? computeBackoffMs(attempt, policy, random);

      // Waiting only to run out of budget mid-flight helps nobody. Give up now
      // so fallback can try a different provider with the time that remains.
      if (!deadline.allows(delayMs)) throw normalized;

      context.onRetry?.({
        attempt,
        delayMs,
        code: normalized.code,
        message: normalized.message,
        honouredRetryAfter: hint !== undefined,
      });

      await sleep(delayMs, signal);
    }
  }
}
