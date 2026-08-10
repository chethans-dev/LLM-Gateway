import { z } from "zod";

/**
 * The single place `process.env` is read (enforced by the `no-restricted-properties`
 * ESLint rule scoped to src/config). Everything downstream receives a typed AppConfig.
 *
 * Why validate at boot rather than at point of use: a container that starts with a
 * malformed DATABASE_URL and only discovers it on the first request has already been
 * marked healthy and put into rotation. Failing at boot keeps the bad build out.
 */

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/**
 * Environment variables are strings. `z.coerce.boolean()` is a trap here —
 * it follows JavaScript truthiness, so the string "false" becomes `true`.
 */
const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/**
 * Treat a present-but-blank variable as absent.
 *
 * `.env` files are full of `OPENAI_API_KEY=` — that is what `.env.example` ships,
 * and what a `docker compose` env_file produces for every key an operator has
 * not filled in yet. Without this, following the quickstart hands the schema an
 * empty string, `min(1)` rejects it, and the gateway crash-loops on a config it
 * should have read as "not set".
 *
 * Applied to the whole object rather than field by field so it cannot be
 * forgotten on the next variable someone adds. Required variables still fail —
 * with "Required", which is the more accurate message anyway.
 */
function blankToUndefined(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.trim() === "") continue;
    result[key] = value;
  }
  return result;
}

const envObjectSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * Optional YAML file for model aliases and fallback routes (spec §7, §8).
   * When set, the file must exist — see loadConfigFile for why that is an error
   * rather than a warning.
   */
  CONFIG_FILE: z.string().min(1).optional(),

  // HTTP
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Spec §26: cap request bodies so a single caller cannot exhaust memory. */
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Comma-separated allowlist. Empty means CORS is not enabled at all. */
  CORS_ORIGINS: z.string().default(""),

  // Logging
  LOG_LEVEL: z.enum(logLevels).default("info"),

  // Postgres
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  POSTGRES_POOL_MAX: z.coerce.number().int().positive().default(10),
  POSTGRES_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  POSTGRES_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // ---------------------------------------------------------------------------
  // Redis features (spec §12)
  // ---------------------------------------------------------------------------
  /** Namespaces all keys, so several gateways can share one Redis. */
  REDIS_KEY_PREFIX: z.string().min(1).default("openllm"),

  RATE_LIMIT_ENABLED: booleanish.default(true),
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Bucket size — how much of the budget may be spent at once. Defaults to the rate. */
  RATE_LIMIT_BURST: z.coerce.number().int().positive().optional(),
  /**
   * Allow requests through when Redis is unreachable.
   *
   * On by default: a limiter that rejects everything during a Redis blip turns
   * a dependency wobble into a total outage. Set false where exceeding the limit
   * is worse than being unavailable.
   */
  RATE_LIMIT_FAIL_OPEN: booleanish.default(true),

  /**
   * Exact-match response cache. OFF by default because enabling it stores
   * completion text in Redis, and privacy-first is the default (spec §14, §26).
   */
  CACHE_ENABLED: booleanish.default(false),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** `global` shares entries across callers; `api-key` isolates them. */
  CACHE_SCOPE: z.enum(["global", "api-key"]).default("global"),

  /** Skip providers that are failing, instead of paying their timeout every request. */
  BREAKER_ENABLED: booleanish.default(true),
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  BREAKER_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(30),

  // Redis
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // Readiness probe
  READINESS_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  READINESS_CACHE_MS: z.coerce.number().int().nonnegative().default(1_000),

  // Shutdown
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().nonnegative().default(5_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** How long to let in-flight streamed responses finish before aborting them. */
  SHUTDOWN_STREAM_GRACE_MS: z.coerce.number().int().nonnegative().default(10_000),

  // Reliability (spec §10). Retry policy joins this section in Phase 7.
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Budget for the WHOLE operation — every retry and every fallback combined.
   * Distinct from PROVIDER_TIMEOUT_MS, which bounds a single call. Without it,
   * 3 targets x 3 attempts x 30s is several minutes for a request the caller
   * abandoned long ago.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // ---------------------------------------------------------------------------
  // Request recording (spec §14, §15)
  // ---------------------------------------------------------------------------
  /** Persist one metadata row per request. Never message content. */
  REQUEST_RECORDING_ENABLED: booleanish.default(true),
  REQUEST_RECORDING_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  REQUEST_RECORDING_FLUSH_MS: z.coerce.number().int().positive().default(1_000),
  /** Ceiling on buffered records; oldest are dropped past it. */
  REQUEST_RECORDING_MAX_BUFFER: z.coerce.number().int().positive().default(10_000),

  /**
   * Days of request history to keep. `0` keeps everything forever.
   *
   * Defaulting to a finite window rather than 0 is deliberate: a table nothing
   * ever deletes from grows until queries crawl, and "unbounded by default" is
   * an outage waiting for enough traffic. 90 days is far more than most
   * dashboards look back, and these rows are metadata — no prompts, nothing
   * irreplaceable. Set 0 if you ship them elsewhere and want them kept.
   */
  REQUEST_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),
  /** How often the pruner runs. */
  REQUEST_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Rows per DELETE. Small batches keep locks short and let autovacuum keep up. */
  REQUEST_PRUNE_BATCH_SIZE: z.coerce.number().int().positive().max(50_000).default(5_000),

  // ---------------------------------------------------------------------------
  // Authentication (spec §13)
  // ---------------------------------------------------------------------------
  /**
   * Require an API key on /v1 routes.
   *
   * Defaults to ON in production and OFF elsewhere, so `docker compose up`
   * followed by a curl works before any key exists. A loud warning is logged
   * whenever it is off, because "auth disabled" must never be a quiet state.
   */
  AUTH_REQUIRED: booleanish.optional(),
  /**
   * Secret for the key-management endpoints. Environment only — never stored in
   * the database, so a database compromise cannot mint new keys.
   * Without it, /v1/admin is disabled entirely.
   */
  ADMIN_API_KEY: z.string().min(16, "ADMIN_API_KEY must be at least 16 characters").optional(),
  /**
   * READ-ONLY credential for the dashboard's stats endpoints.
   *
   * Deliberately separate from ADMIN_API_KEY. The dashboard is a browser app,
   * and whatever credential it holds is one XSS away from being stolen — that
   * must not be a credential that can mint API keys. This one can only read
   * request metadata. ADMIN_API_KEY also works, for curl and scripts.
   */
  DASHBOARD_API_KEY: z
    .string()
    .min(16, "DASHBOARD_API_KEY must be at least 16 characters")
    .optional(),

  /** Run pending migrations at boot. Off where a deploy step handles them. */
  SKIP_MIGRATIONS: booleanish.default(false),

  // Retry (spec §9). Attempts are per target; fallback then moves to the next.
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(5_000),
  /** Randomize backoff so a shared outage does not sync every client's retry. */
  RETRY_JITTER: booleanish.default(true),

  // ---------------------------------------------------------------------------
  // Providers
  //
  // Enablement rule: a provider is enabled when its credential is configured —
  // an API key for the hosted providers, a base URL for Ollama. No separate
  // *_ENABLED flag, because a provider that is "enabled" with no way to
  // authenticate is not a state worth being able to express.
  // ---------------------------------------------------------------------------
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().min(1).default("https://api.openai.com/v1"),

  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_BASE_URL: z.string().min(1).default("https://generativelanguage.googleapis.com/v1beta"),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().min(1).default("https://api.anthropic.com/v1"),
  ANTHROPIC_VERSION: z.string().min(1).default("2023-06-01"),

  // No default: Ollama is optional (spec §19), so it turns on only when you
  // point at one. A default would enable it everywhere and make readiness and
  // provider health checks fail on machines that have never run Ollama.
  OLLAMA_BASE_URL: z.string().min(1).optional(),

  // Mock provider (spec §17). Defaults to enabled outside production — it exists
  // to exercise retries, fallback, and timeouts without spending API credits,
  // and it must not be silently reachable on a production deployment.
  MOCK_PROVIDER_ENABLED: booleanish.optional(),
  MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(0),
  /** Delay between streamed chunks — for exercising SSE flushing and proxies. */
  MOCK_CHUNK_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export const envSchema = z.preprocess(blankToUndefined, envObjectSchema);

/**
 * Every variable the gateway reads.
 *
 * Exported so a test can assert the documentation lists all of them — reaching
 * into Zod's internals to recover this would break on any minor version.
 */
export const ENV_VAR_NAMES: readonly string[] = Object.keys(envObjectSchema.shape);

export type Env = z.infer<typeof envSchema>;
