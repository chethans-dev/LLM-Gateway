/**
 * Display formatting.
 *
 * Separate from components so the rules are testable and stated once. The
 * important one: **null is not zero**. The gateway preserves that distinction
 * from the provider adapters through the database; throwing it away in the last
 * step before a human reads it would waste the whole effort and, worse, present
 * "we don't know" as "it was free".
 */

/** Null renders as an em dash, never as a number. */
export const UNKNOWN = "—";

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  return new Intl.NumberFormat().format(value);
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return UNKNOWN;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return UNKNOWN;
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Cost, at a precision that does not pretend to be exact.
 *
 * Per-request figures are fractions of a cent, so a fixed 2 decimals would show
 * every request as $0.00. Small values get more digits; the number is still an
 * estimate and the UI labels it as one.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return UNKNOWN;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Short relative age, for "how recent is this row". */
export function formatAge(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
