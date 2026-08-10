import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API key generation and hashing (spec §13).
 *
 * ## Why SHA-256 and not bcrypt/argon2
 *
 * This looks wrong to anyone pattern-matching "never hash secrets with a fast
 * hash". It is correct here, for two reasons:
 *
 * 1. **Entropy.** Password hashing is slow to make brute-forcing *low-entropy,
 *    human-chosen* secrets expensive. These keys are 256 bits of CSPRNG output.
 *    There is no dictionary and no brute force to defend against — an attacker
 *    with the hash gains nothing regardless of how fast the function is.
 *
 * 2. **Lookup.** Every request must find a key by its value. bcrypt and argon2
 *    salt per record, so their output is not a lookup key: authenticating would
 *    mean loading every row and verifying against each. At ~100ms per bcrypt
 *    verify that is not a performance detail, it is a cap of a few requests per
 *    second. An unsalted SHA-256 is deterministic, indexable, and O(1).
 *
 * Rainbow tables are the usual objection to unsalted hashing. They are built
 * over plausible human inputs; there is no table of random 256-bit strings.
 * This is the same design Stripe and GitHub use for API tokens.
 */

/** `olgm` = OpenLLM Gateway. The `live` segment leaves room for `test` keys. */
const KEY_PREFIX = "olgm";
const DEFAULT_ENVIRONMENT = "live";

/** 32 bytes → 43 base64url characters, no padding, URL and header safe. */
const SECRET_BYTES = 32;

/** How much of the key is stored in clear text for display. */
const DISPLAY_SECRET_CHARS = 6;

export interface GeneratedApiKey {
  /**
   * The full key. Returned to the caller EXACTLY ONCE, at creation, and never
   * persisted — spec §13.
   */
  readonly key: string;
  /** What goes in the database. */
  readonly keyHash: string;
  /** Clear-text identifier for display, e.g. `olgm_live_a1b2c3…`. */
  readonly keyPrefix: string;
}

export function generateApiKey(environment: string = DEFAULT_ENVIRONMENT): GeneratedApiKey {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const key = `${KEY_PREFIX}_${environment}_${secret}`;

  return {
    key,
    keyHash: hashApiKey(key),
    keyPrefix: displayPrefix(key),
  };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function displayPrefix(key: string): string {
  const [prefix, environment, secret] = key.split("_");
  if (prefix === undefined || environment === undefined || secret === undefined) {
    return key.slice(0, 12);
  }
  return `${prefix}_${environment}_${secret.slice(0, DISPLAY_SECRET_CHARS)}`;
}

/**
 * Shape check before touching the database.
 *
 * Cheap rejection of anything that could not possibly be one of our keys, so a
 * scanner spraying random strings never reaches Postgres.
 */
const KEY_PATTERN = new RegExp(`^${KEY_PREFIX}_[a-z]+_[A-Za-z0-9_-]{20,}$`);

export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/**
 * Extract a bearer credential from the request headers.
 *
 * Accepts `Authorization: Bearer <key>` (the OpenAI-compatible form, spec §13)
 * and `x-api-key`, which several SDKs send instead.
 */
export function extractCredential(headers: {
  authorization?: string | undefined;
  "x-api-key"?: string | undefined;
}): string | undefined {
  const authorization = headers.authorization?.trim();
  if (authorization !== undefined && authorization !== "") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match?.[1] !== undefined) return match[1].trim();
    // A bare credential with no scheme — accept it rather than fail a caller
    // over a formatting nicety.
    return authorization;
  }

  const headerKey = headers["x-api-key"]?.trim();
  return headerKey !== undefined && headerKey !== "" ? headerKey : undefined;
}

/**
 * Constant-time string comparison, for the admin secret.
 *
 * User keys are matched by hash lookup and need no comparison. The admin secret
 * lives only in the environment, so it IS compared directly — and a naive `===`
 * leaks its length and matching prefix through timing.
 */
export function secureCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal. Hash both to a fixed width first so every comparison costs the same.
  const digestA = createHash("sha256").update(bufferA).digest();
  const digestB = createHash("sha256").update(bufferB).digest();

  return timingSafeEqual(digestA, digestB);
}
