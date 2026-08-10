import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICING,
  estimateCost,
  lookupPricing,
  mergePricing,
  type PricingTable,
} from "../../src/observability/pricing.js";

const table: PricingTable = {
  "gpt-4.1-mini": { inputPerMillionTokens: 0.4, outputPerMillionTokens: 1.6 },
  "gpt-4.1": { inputPerMillionTokens: 2, outputPerMillionTokens: 8 },
  "ollama/": { inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
};

const usage = { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 };

describe("lookupPricing", () => {
  it("prefers an exact match", () => {
    expect(lookupPricing("gpt-4.1", undefined, table)?.key).toBe("gpt-4.1");
  });

  it("falls back to the longest matching prefix", () => {
    // Providers ship dated snapshots that share a price with the base model;
    // an entry per snapshot would be stale within a month.
    const found = lookupPricing("gpt-4.1-mini-2025-04-14", undefined, table);

    expect(found?.key).toBe("gpt-4.1-mini");
    expect(found?.pricing.inputPerMillionTokens).toBe(0.4);
  });

  it("picks the most specific prefix, not the first that matches", () => {
    // `gpt-4.1-mini-…` matches both `gpt-4.1` and `gpt-4.1-mini`; charging the
    // full-size price for a mini model would overstate every bill.
    expect(lookupPricing("gpt-4.1-mini-2025-04-14", undefined, table)?.key).toBe("gpt-4.1-mini");
  });

  it("matches a provider-qualified key by prefix", () => {
    // `ollama/` covers every locally hosted model without an entry each, since
    // their names are arbitrary local strings.
    expect(lookupPricing("qwen3", "ollama", table)?.key).toBe("ollama/");
  });

  it("returns undefined for an unknown model", () => {
    expect(lookupPricing("some-new-model", undefined, table)).toBeUndefined();
  });
});

describe("estimateCost", () => {
  it("charges input and output at their separate rates", () => {
    // 1M input at $0.40 + 0.5M output at $1.60 = 0.40 + 0.80
    expect(estimateCost(usage, "gpt-4.1-mini", undefined, table)?.usd).toBeCloseTo(1.2, 10);
  });

  it("returns undefined when usage is unknown — never zero", () => {
    // Zero is a claim ("this was free"); undefined is the truth ("we don't
    // know"). Zero-filling makes every aggregate understate the bill in a way
    // that looks like good news.
    expect(estimateCost(undefined, "gpt-4.1-mini", undefined, table)).toBeUndefined();
  });

  it("returns undefined when pricing is unknown — never zero", () => {
    expect(estimateCost(usage, "some-new-model", undefined, table)).toBeUndefined();
  });

  it("returns an actual zero for a genuinely free model", () => {
    // A locally hosted model really does cost nothing per token, and that is a
    // different statement from "unknown".
    const free = estimateCost(usage, "qwen3", "ollama", table);

    expect(free).toBeDefined();
    expect(free?.usd).toBe(0);
  });

  it("reports which pricing entry was used", () => {
    // So a surprising figure can be explained rather than argued about.
    expect(estimateCost(usage, "gpt-4.1-mini-2025-04-14", undefined, table)?.pricingKey).toBe(
      "gpt-4.1-mini",
    );
  });

  it("handles small token counts without losing the value", () => {
    const small = estimateCost(
      { inputTokens: 824, outputTokens: 214, totalTokens: 1_038 },
      "gpt-4.1-mini",
      undefined,
      table,
    );

    expect(small?.usd).toBeGreaterThan(0);
    expect(small?.usd).toBeLessThan(0.001);
  });
});

describe("mergePricing", () => {
  it("returns the defaults when there are no overrides", () => {
    expect(mergePricing(undefined)).toBe(DEFAULT_PRICING);
  });

  it("lets operator entries win outright", () => {
    // Deep-merging would allow a half-overridden price — their input rate with
    // our stale output rate — which is worse than either.
    const merged = mergePricing(
      { mock: { inputPerMillionTokens: 5, outputPerMillionTokens: 10 } },
      { mock: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } },
    );

    expect(merged["mock"]).toEqual({ inputPerMillionTokens: 5, outputPerMillionTokens: 10 });
  });

  it("keeps defaults the operator did not mention", () => {
    const merged = mergePricing({ "custom-model": { inputPerMillionTokens: 1, outputPerMillionTokens: 2 } });

    expect(merged["mock"]).toBeDefined();
    expect(merged["custom-model"]).toBeDefined();
  });
});
