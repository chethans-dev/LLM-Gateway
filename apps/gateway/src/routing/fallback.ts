import { LLMError } from "@openllm/core";
import type { ChatChunk } from "../providers/types.js";
import type { RouteTarget } from "./route-table.js";

/**
 * Fallback execution (spec §8 Level 3).
 *
 * The rule the whole file exists to enforce: **fall back only on failures a
 * different provider could plausibly fix.** Spec §8 says so explicitly — "do not
 * fallback on every error" — and the cost of getting it wrong is not just
 * latency. Replaying a malformed request across four providers means four
 * charges for four identical 400s.
 *
 * The decision is read from `LLMError.failoverable`, never from a provider's own
 * status codes or message text. That is what the Phase 2 normalization was for.
 */

export interface FailedAttempt {
  readonly provider: string;
  readonly model: string;
  readonly code: string;
  readonly message: string;
  /** Wall time spent on this target, including any retries within it. */
  readonly latencyMs: number;
}

/**
 * A stream that has already produced its first chunk.
 *
 * Fallback needs the first chunk to have been pulled before it can decide the
 * attempt succeeded — that is also the last moment a swap is possible. Handing
 * back both the iterator and that chunk keeps retry out of this file: the caller
 * decides how many times to try opening a stream, and fallback only sees the
 * final outcome per target.
 */
export interface StartedStream {
  readonly iterator: AsyncIterator<ChatChunk>;
  readonly first: IteratorResult<ChatChunk>;
}

export interface FallbackOutcome<T> {
  readonly value: T;
  readonly target: RouteTarget;
  /** Attempts that failed before this one succeeded. Empty on a first-try win. */
  readonly failed: readonly FailedAttempt[];
}

export interface FallbackHooks {
  /** Called for each failed attempt when another target will be tried. */
  onFailover?(attempt: FailedAttempt, next: RouteTarget): void;
}

function toFailedAttempt(target: RouteTarget, error: LLMError, latencyMs: number): FailedAttempt {
  return {
    provider: target.provider,
    model: target.model,
    code: error.code,
    message: error.message,
    latencyMs,
  };
}

/**
 * When every target fails, report the LAST error but attach the full history.
 *
 * The last failure is the most recent state of the world, and its status code is
 * the most honest thing to return. The history matters because "all four
 * providers rate-limited" and "the first three are misconfigured and the fourth
 * rate-limited" look identical from the final error alone.
 */
function exhausted(failed: readonly FailedAttempt[], last: LLMError): LLMError {
  if (failed.length <= 1) return last;

  return new LLMError(last.code, {
    message: `All ${failed.length} providers failed. Last error: ${last.message}`,
    ...(last.provider !== undefined ? { provider: last.provider } : {}),
    ...(last.model !== undefined ? { model: last.model } : {}),
    details: { attempts: failed },
    cause: last,
  });
}

function asLLMError(error: unknown): LLMError {
  return LLMError.is(error)
    ? error
    : LLMError.internal(error instanceof Error ? error.message : "provider call failed", {
        cause: error,
      });
}

/** Buffered path: try each target in order until one succeeds. */
export async function runWithFallback<T>(
  targets: readonly RouteTarget[],
  run: (target: RouteTarget) => Promise<T>,
  hooks: FallbackHooks = {},
): Promise<FallbackOutcome<T>> {
  if (targets.length === 0) {
    throw LLMError.modelNotFound("No provider targets are configured for this model");
  }

  const failed: FailedAttempt[] = [];

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    const startedAt = performance.now();

    try {
      return { value: await run(target), target, failed };
    } catch (error) {
      const normalized = asLLMError(error);
      const attempt = toFailedAttempt(target, normalized, Math.round(performance.now() - startedAt));

      const next = targets[index + 1];

      // A non-failoverable error stops everything immediately — it would fail
      // the same way on every remaining target.
      if (!normalized.failoverable || next === undefined) {
        failed.push(attempt);
        throw exhausted(failed, normalized);
      }

      failed.push(attempt);
      hooks.onFailover?.(attempt, next);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw LLMError.internal("fallback executor completed without a result");
}

/**
 * Streaming path: fall back only until the first chunk is delivered.
 *
 * This is where Phase 5's design pays off. The route pulls one chunk before
 * committing to a 200, and every adapter performs its HTTP request and throws on
 * a non-OK status before yielding — so a rate-limited first provider can still
 * be swapped for a healthy one with the client none the wiser.
 *
 * Once a chunk HAS been delivered, falling back is no longer possible: those
 * tokens are already on the wire, and restarting on another provider would
 * produce a response that contradicts itself mid-sentence. After that point
 * errors propagate, which the route surfaces as an SSE error event.
 */
export async function* streamWithFallback(
  targets: readonly RouteTarget[],
  start: (target: RouteTarget) => Promise<StartedStream>,
  hooks: FallbackHooks = {},
): AsyncGenerator<ChatChunk> {
  if (targets.length === 0) {
    throw LLMError.modelNotFound("No provider targets are configured for this model");
  }

  const failed: FailedAttempt[] = [];

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    const startedAt = performance.now();

    let started: StartedStream;
    try {
      // `start` opens the stream AND pulls its first chunk — including any
      // retries the caller layered on. Everything that can still be recovered
      // from happens inside this call.
      started = await start(target);
    } catch (error) {
      const normalized = asLLMError(error);
      const attempt = toFailedAttempt(target, normalized, Math.round(performance.now() - startedAt));
      const next = targets[index + 1];

      if (!normalized.failoverable || next === undefined) {
        failed.push(attempt);
        throw exhausted(failed, normalized);
      }

      failed.push(attempt);
      hooks.onFailover?.(attempt, next);
      continue;
    }

    // A chunk has been produced: committed to this provider from here on.
    // Restarting elsewhere now would produce a response that contradicts itself
    // mid-sentence, and those tokens are already on their way to the client.
    const { iterator, first } = started;
    try {
      if (first.done !== true) yield first.value;

      for (;;) {
        const next = await iterator.next();
        if (next.done === true) break;
        yield next.value;
      }
    } finally {
      // Runs when the consumer breaks out early (client disconnect, shutdown),
      // closing the provider connection rather than leaving it generating.
      await iterator.return?.().catch(() => {});
    }
    return;
  }
}
