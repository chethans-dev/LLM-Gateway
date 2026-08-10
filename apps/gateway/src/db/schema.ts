import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema.
 *
 * Planned (spec §14):
 *   Phase 7.5 — api_keys                 ✅
 *   Phase 9   — providers, requests
 *
 * `requests` will deliberately have no prompt or completion columns: privacy
 * first is the default, not an option (spec §14, §26).
 */

export const apiKeyStatus = pgEnum("api_key_status", ["active", "revoked"]);

/**
 * API keys (spec §13).
 *
 * **The raw key is never stored.** Only its SHA-256 hash, and a short display
 * prefix. A database dump therefore does not let anyone call the gateway, which
 * is the entire point of the table's shape.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human label, e.g. "staging-backend". Not a secret. */
    name: text("name").notNull(),
    /**
     * SHA-256 of the raw key, hex encoded.
     *
     * Unique so a lookup is a single index hit — see api-key.ts for why a fast
     * hash is the correct choice here and bcrypt/argon2 would be wrong.
     */
    keyHash: text("key_hash").notNull().unique(),
    /**
     * First few characters of the key, in clear text.
     *
     * Not in the spec's minimal table, but a key you cannot identify is a key
     * you cannot safely revoke: without this the dashboard can only show opaque
     * UUIDs, and an operator has no way to match a row to the key sitting in
     * their config. Every developer platform does this ("sk-live-a1b2…").
     */
    keyPrefix: text("key_prefix").notNull(),
    status: apiKeyStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Last time this key authenticated a request.
     *
     * Updated opportunistically and never on the request path — see the
     * repository. Answers "which keys can I safely revoke?", which is otherwise
     * unanswerable and leaves dead credentials live forever.
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // Revocation must take effect immediately, so status is read on every
    // authenticated request alongside the hash.
    index("api_keys_status_idx").on(table.status),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;

export const requestStatus = pgEnum("request_status", ["success", "error"]);

/**
 * One row per gateway request (spec §14, §15).
 *
 * ## There is no prompt column, and no completion column
 *
 * Not "we don't populate them" — they do not exist. Privacy-first is the
 * default (spec §14, §26), and a nullable `prompt` column is a column somebody
 * eventually fills in "just for debugging". Content logging, when it arrives,
 * will be an explicitly configured separate store rather than a field here that
 * quietly starts being written.
 *
 * A schema test asserts this table has no content-shaped column, so the
 * guarantee survives a future migration written in a hurry.
 */
export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `req_…` — matches the x-request-id header the client was given. */
    requestId: text("request_id").notNull(),
    /** `tr_…` — adopted from the caller when they supplied one. */
    traceId: text("trace_id").notNull(),
    /**
     * Nullable, and NOT a foreign key.
     *
     * Null when authentication is disabled. Not a constraint because request
     * history must outlive the key: an operator deleting a key row should not
     * silently erase the record of what it spent.
     */
    apiKeyId: uuid("api_key_id"),

    /** What the client asked for — `fast`, `gpt-4.1-mini`. */
    requestedModel: text("requested_model").notNull(),
    /** Route name when an alias was used. */
    route: text("route"),
    /** Who actually served it. Null when the request failed before selection. */
    provider: text("provider"),
    /** The model that actually served it, which under fallback is not predictable. */
    model: text("model"),

    status: requestStatus("status").notNull(),
    /** Normalized LLMErrorCode. Never a provider's raw message. */
    errorCode: text("error_code"),
    httpStatus: integer("http_status").notNull(),

    /** Wall time for the whole operation, retries and fallbacks included. */
    latencyMs: integer("latency_ms").notNull(),
    /** Provider calls made, counting retries and failovers. */
    providerCalls: integer("provider_calls").notNull().default(0),
    cached: boolean("cached").notNull().default(false),
    streamed: boolean("streamed").notNull().default(false),

    // Null, never zero, when the provider did not report usage — the same
    // distinction the provider layer preserves. Zero would silently understate
    // every aggregate built on top of this table.
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),

    /**
     * NUMERIC, not double precision.
     *
     * A single request costs a fraction of a cent. Summing millions of floats
     * accumulates error precisely where the number matters most — the monthly
     * total. Null when pricing for the model is unknown; see pricing.ts for why
     * that is never zero.
     */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 20, scale: 10 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every dashboard query is "recent activity", so this is the one index that
    // is not optional. Descending because nobody asks for the oldest requests.
    index("requests_created_at_idx").on(table.createdAt.desc()),
    index("requests_api_key_idx").on(table.apiKeyId, table.createdAt.desc()),
    index("requests_provider_idx").on(table.provider, table.createdAt.desc()),
    // Following one logical operation across requests (spec §15).
    index("requests_trace_idx").on(table.traceId),
  ],
);

export type RequestRow = typeof requests.$inferSelect;
export type NewRequestRow = typeof requests.$inferInsert;
