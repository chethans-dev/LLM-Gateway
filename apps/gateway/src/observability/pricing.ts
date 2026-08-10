import type { TokenUsage } from "../providers/types.js";

/**
 * Cost estimation (spec §16).
 *
 * ## These are ESTIMATES, and the code says so everywhere
 *
 * The column is `estimated_cost_usd`, the field is `estimatedCostUsd`, and the
 * docs repeat it. That is not false modesty — provider billing has nuances this
 * model does not capture:
 *
 *  - **Cached input tokens** are discounted heavily by several providers, and we
 *    cannot see which of our input tokens hit their cache.
 *  - **Batch APIs** are cheaper; we do not use them, but a reader comparing our
 *    total to an invoice that includes batch usage will see a gap.
 *  - **Reasoning tokens** are billed as output on some models and reported
 *    separately, or not at all.
 *  - **Tiered and negotiated pricing** exists and is per-account.
 *
 * A gateway that displayed these as "cost" would be lying by a small percentage
 * in a way nobody could audit. Naming them estimates costs nothing and keeps the
 * number honest.
 *
 * ## Unknown pricing yields undefined, never zero
 *
 * The same rule as token usage. Zero is a claim ("this was free"); undefined is
 * the truth ("we do not know"). Zero-filling would make every aggregate
 * understate the bill in a way that looks like good news.
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  readonly inputPerMillionTokens: number;
  /** USD per 1,000,000 output tokens. */
  readonly outputPerMillionTokens: number;
}

export interface PricingTable {
  /** Exact model id, or a prefix — see `lookupPricing`. */
  readonly [model: string]: ModelPricing;
}

/**
 * Seed pricing.
 *
 * **This table goes stale.** Provider prices change, and nothing here checks
 * them. It exists so a fresh install produces plausible numbers rather than a
 * column of nulls; anyone who cares about the figure should override it in
 * `openllm.yaml` from their provider's current pricing page, which is why
 * pricing is data loaded from config rather than constants compiled into the
 * cost calculation (spec §16).
 *
 * Keys are matched exactly first, then by longest prefix, so `gpt-4.1-mini`
 * covers `gpt-4.1-mini-2025-04-14` without an entry per dated snapshot.
 */
export const DEFAULT_PRICING: PricingTable = {
  // Locally hosted: no per-token cost. Electricity is not our department.
  "ollama/": { inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
  // The mock provider is free by construction, which keeps test totals sane.
  "mock": { inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
};

export interface CostEstimate {
  readonly usd: number;
  /** The pricing entry used, for explaining a figure back to an operator. */
  readonly pricingKey: string;
}

/**
 * Find pricing for a model.
 *
 * Exact match first, then the longest matching prefix. Providers ship dated
 * snapshots (`gpt-4.1-mini-2025-04-14`) that share a price with their base
 * model, and an entry per snapshot would be stale within a month.
 */
export function lookupPricing(
  model: string,
  provider: string | undefined,
  table: PricingTable,
): { pricing: ModelPricing; key: string } | undefined {
  const candidates = provider === undefined ? [model] : [`${provider}/${model}`, model];

  for (const candidate of candidates) {
    const exact = table[candidate];
    if (exact !== undefined) return { pricing: exact, key: candidate };
  }

  let best: { pricing: ModelPricing; key: string } | undefined;
  for (const candidate of candidates) {
    for (const [key, pricing] of Object.entries(table)) {
      if (!candidate.startsWith(key)) continue;
      if (best === undefined || key.length > best.key.length) {
        best = { pricing, key };
      }
    }
    if (best !== undefined) return best;
  }

  return undefined;
}

/**
 * Estimate what a request cost.
 *
 * Returns undefined — not zero — when usage or pricing is unknown. Callers must
 * carry that distinction all the way to the dashboard.
 */
export function estimateCost(
  usage: TokenUsage | undefined,
  model: string,
  provider: string | undefined,
  table: PricingTable,
): CostEstimate | undefined {
  if (usage === undefined) return undefined;

  const found = lookupPricing(model, provider, table);
  if (found === undefined) return undefined;

  const usd =
    (usage.inputTokens / 1_000_000) * found.pricing.inputPerMillionTokens +
    (usage.outputTokens / 1_000_000) * found.pricing.outputPerMillionTokens;

  return { usd, pricingKey: found.key };
}

/**
 * Merge operator-supplied pricing over the defaults.
 *
 * Operator entries win outright rather than being deep-merged: a half-overridden
 * price (their input rate, our stale output rate) is worse than either.
 */
export function mergePricing(
  overrides: PricingTable | undefined,
  base: PricingTable = DEFAULT_PRICING,
): PricingTable {
  if (overrides === undefined) return base;
  return { ...base, ...overrides };
}
