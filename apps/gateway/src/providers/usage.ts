import type { TokenUsage } from "./types.js";

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Build a `TokenUsage` from whatever a provider reported.
 *
 * Returns `undefined` unless BOTH counts are present and sane. That strictness
 * is the point: providers omit usage on streamed responses, return `null` on
 * errors, and occasionally send partial objects. Defaulting the missing half to
 * zero would hand Phase 9 a confident-looking number that silently understates
 * cost, and spec §16 requires cost estimates to be honest about what they do not
 * know.
 *
 * "We have no usage data" and "this request used zero tokens" must stay
 * distinguishable all the way to the dashboard.
 */
export function createTokenUsage(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): TokenUsage | undefined {
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return undefined;

  return {
    inputTokens,
    outputTokens,
    // Computed rather than taken from the provider's own total: providers
    // disagree about whether their total includes reasoning or cached tokens,
    // and a total that does not equal input + output makes downstream
    // arithmetic unauditable.
    totalTokens: inputTokens + outputTokens,
  };
}

/** Sum usage across attempts. Used by retry/fallback (Phase 7) — a request that
 * failed over still consumed tokens on the first provider, and the bill reflects
 * that. Returns undefined only when no attempt reported usage. */
export function addTokenUsage(
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;

  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
