import { describe, expect, it } from "vitest";
import {
  displayPrefix,
  extractCredential,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
  secureCompare,
} from "../../src/auth/api-key.js";

describe("generateApiKey", () => {
  it("issues a key in the documented format", () => {
    expect(generateApiKey().key).toMatch(/^olgm_live_[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey().key));

    expect(keys.size).toBe(500);
  });

  it("returns the hash that will be stored, and a display prefix", () => {
    const generated = generateApiKey();

    expect(generated.keyHash).toBe(hashApiKey(generated.key));
    expect(generated.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(generated.key.startsWith(generated.keyPrefix)).toBe(true);
  });

  it("keeps the display prefix too short to be usable", () => {
    // It exists to identify a key in a dashboard, not to reconstruct it.
    const generated = generateApiKey();

    expect(generated.keyPrefix.length).toBeLessThan(generated.key.length / 2);
    expect(looksLikeApiKey(generated.keyPrefix)).toBe(false);
  });
});

describe("hashApiKey", () => {
  it("is deterministic, which is what makes lookup a single index hit", () => {
    // bcrypt/argon2 salt per record, so their output cannot be a lookup key —
    // authenticating would mean loading every row and verifying against each.
    expect(hashApiKey("olgm_live_abc")).toBe(hashApiKey("olgm_live_abc"));
  });

  it("differs for different keys", () => {
    expect(hashApiKey("olgm_live_abc")).not.toBe(hashApiKey("olgm_live_abd"));
  });

  it("never returns the input", () => {
    const key = generateApiKey().key;

    expect(hashApiKey(key)).not.toContain(key.slice(10));
  });
});

describe("looksLikeApiKey", () => {
  it("accepts a real key", () => {
    expect(looksLikeApiKey(generateApiKey().key)).toBe(true);
  });

  it("rejects junk before it can reach the database", () => {
    // A scanner spraying random strings should never cost us a query.
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("hunter2")).toBe(false);
    expect(looksLikeApiKey("sk-proj-abc123")).toBe(false);
    expect(looksLikeApiKey("olgm_live_short")).toBe(false);
    expect(looksLikeApiKey("olgm_live_has spaces in it aaaaaaaaaaaa")).toBe(false);
  });
});

describe("extractCredential", () => {
  it("reads the OpenAI-compatible Bearer form", () => {
    expect(extractCredential({ authorization: "Bearer olgm_live_abc" })).toBe("olgm_live_abc");
  });

  it("is case-insensitive about the scheme", () => {
    expect(extractCredential({ authorization: "bearer olgm_live_abc" })).toBe("olgm_live_abc");
  });

  it("accepts a bare credential rather than failing over a formatting nicety", () => {
    expect(extractCredential({ authorization: "olgm_live_abc" })).toBe("olgm_live_abc");
  });

  it("falls back to x-api-key, which several SDKs send instead", () => {
    expect(extractCredential({ "x-api-key": "olgm_live_abc" })).toBe("olgm_live_abc");
  });

  it("prefers Authorization when both are present", () => {
    expect(
      extractCredential({ authorization: "Bearer first", "x-api-key": "second" }),
    ).toBe("first");
  });

  it("returns undefined when there is nothing to read", () => {
    expect(extractCredential({})).toBeUndefined();
    expect(extractCredential({ authorization: "   " })).toBeUndefined();
    expect(extractCredential({ "x-api-key": "" })).toBeUndefined();
  });
});

describe("secureCompare", () => {
  it("matches identical values", () => {
    expect(secureCompare("admin-secret-value", "admin-secret-value")).toBe(true);
  });

  it("rejects different values", () => {
    expect(secureCompare("admin-secret-value", "admin-secret-valuf")).toBe(false);
  });

  it("handles length mismatch without throwing", () => {
    // timingSafeEqual throws on unequal lengths, and that throw would itself be
    // a timing signal — hence hashing to a fixed width first.
    expect(secureCompare("short", "a-much-longer-secret")).toBe(false);
    expect(secureCompare("", "x")).toBe(false);
  });
});

describe("displayPrefix", () => {
  it("keeps the identifying segments and truncates the secret", () => {
    expect(displayPrefix("olgm_live_abcdefghijklmnop")).toBe("olgm_live_abcdef");
  });

  it("degrades safely on a malformed key", () => {
    expect(displayPrefix("nonsense").length).toBeLessThanOrEqual(12);
  });
});
