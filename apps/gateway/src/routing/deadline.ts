/**
 * A budget for the whole operation, across every retry and every fallback.
 *
 * Without one, reliability features multiply latency instead of improving it: a
 * route with three targets and three attempts each is nine provider calls plus
 * eight backoff waits. At a 30s per-call timeout that is several minutes for a
 * request the caller almost certainly abandoned in the first ten seconds.
 *
 * So there are two distinct limits, and conflating them is the mistake:
 *
 *   PROVIDER_TIMEOUT_MS — how long ONE provider call may take
 *   REQUEST_TIMEOUT_MS  — how long we may spend in total, retries included
 *
 * The deadline is what makes retry and fallback safe to enable by default.
 */
export interface Deadline {
  /** Milliseconds left, never negative. */
  remainingMs(): number;
  expired(): boolean;
  /** Whether an operation expected to take `ms` still fits. */
  allows(ms: number): boolean;
}

export function createDeadline(totalMs: number, now: () => number = Date.now): Deadline {
  const expiresAt = now() + totalMs;

  return {
    remainingMs: () => Math.max(0, expiresAt - now()),
    expired: () => now() >= expiresAt,
    allows: (ms: number) => now() + ms < expiresAt,
  };
}

/** A deadline that never expires, for call sites that do not impose one. */
export function unboundedDeadline(): Deadline {
  return {
    remainingMs: () => Number.MAX_SAFE_INTEGER,
    expired: () => false,
    allows: () => true,
  };
}
