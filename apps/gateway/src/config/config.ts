import type { RouteDefinition } from "../routing/route-table.js";
import { toRouteDefinitions } from "../routing/route-table.js";
import { mergePricing, type PricingTable } from "../observability/pricing.js";
import { loadConfigFile } from "./file.js";
import { envSchema, type Env } from "./env.js";

export type NodeEnv = Env["NODE_ENV"];
export type LogLevel = Env["LOG_LEVEL"];

export interface AppConfig {
  readonly env: NodeEnv;
  readonly isProduction: boolean;
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly bodyLimitBytes: number;
    readonly corsOrigins: readonly string[];
  };
  readonly logging: {
    readonly level: LogLevel;
    /** Pretty-printed logs in development, JSON everywhere else. */
    readonly pretty: boolean;
  };
  readonly postgres: {
    readonly url: string;
    readonly poolMax: number;
    readonly connectionTimeoutMs: number;
    readonly idleTimeoutMs: number;
  };
  readonly redis: {
    readonly url: string;
    /** Namespaces every key so several gateways can share one Redis. */
    readonly keyPrefix: string;
    readonly rateLimit: {
      readonly enabled: boolean;
      readonly requestsPerMinute: number;
      readonly burst: number;
      readonly failOpen: boolean;
    };
    readonly cache: {
      readonly enabled: boolean;
      readonly ttlSeconds: number;
      readonly scope: "global" | "api-key";
    };
    readonly breaker: {
      readonly enabled: boolean;
      readonly failureThreshold: number;
      readonly cooldownSeconds: number;
    };
  };
  readonly readiness: {
    readonly checkTimeoutMs: number;
    readonly cacheTtlMs: number;
  };
  readonly shutdown: {
    readonly drainMs: number;
    readonly timeoutMs: number;
    /**
     * Grace period for in-flight streams before they are aborted. A streamed
     * completion can run for tens of seconds; cutting it mid-sentence loses work
     * the user has already been billed for.
     */
    readonly streamGraceMs: number;
  };
  readonly reliability: {
    /**
     * Ceiling on a SINGLE provider call (spec §10).
     *
     * Not optional and not unbounded: an LLM request that hangs holds a
     * connection, a Postgres pool slot and the caller's socket open indefinitely.
     */
    readonly timeoutMs: number;
    /**
     * Ceiling on the WHOLE operation — retries and fallbacks included.
     *
     * The two are deliberately separate. Conflating them means reliability
     * features multiply latency: three targets at three attempts each is nine
     * calls plus eight backoff waits, which at a 30s per-call timeout is several
     * minutes for a request the caller abandoned in the first ten seconds.
     */
    readonly requestTimeoutMs: number;
    /** Spec §9. Attempts are per target; fallback then moves to the next one. */
    readonly retry: {
      readonly maxAttempts: number;
      readonly baseDelayMs: number;
      readonly maxDelayMs: number;
      readonly jitter: boolean;
    };
  };
  readonly providers: ProvidersConfig;
  readonly routing: RoutingConfig;
  readonly auth: {
    /** Whether /v1 routes require an API key. */
    readonly required: boolean;
    /** Secret for /v1/admin. Undefined disables key management entirely. */
    readonly adminApiKey: string | undefined;
    /** Read-only secret for the stats endpoints. Cannot mint keys. */
    readonly dashboardApiKey: string | undefined;
  };
  readonly database: {
    readonly skipMigrations: boolean;
  };
  readonly observability: {
    readonly recording: {
      readonly enabled: boolean;
      readonly batchSize: number;
      readonly flushIntervalMs: number;
      readonly maxBufferSize: number;
    };
    /** Merged over the built-in defaults. Cost figures are estimates. */
    readonly pricing: PricingTable;
  };
}

export interface RoutingConfig {
  /**
   * Raw route definitions. Validated into a `RouteTable` at service
   * construction, so a typo in the config file fails at boot rather than 404ing
   * the first time somebody uses that alias.
   */
  readonly routes: readonly RouteDefinition[];
  /** Path the routes came from, for the startup log. */
  readonly configFile: string | undefined;
}

/**
 * Provider settings.
 *
 * `enabled` is derived, never configured directly: a provider is enabled when it
 * has what it needs to make a call. That keeps "configured" and "usable" from
 * drifting apart, which is the state that produces confusing 502s.
 *
 * API keys live here and nowhere else. They are never logged (pino redaction
 * strips anything key-shaped) and never leave the process — spec §7 and §26.
 */
export interface ProvidersConfig {
  readonly openai: {
    readonly enabled: boolean;
    readonly apiKey: string | undefined;
    readonly baseUrl: string;
  };
  readonly gemini: {
    readonly enabled: boolean;
    readonly apiKey: string | undefined;
    readonly baseUrl: string;
  };
  readonly anthropic: {
    readonly enabled: boolean;
    readonly apiKey: string | undefined;
    readonly baseUrl: string;
    readonly version: string;
  };
  readonly ollama: {
    readonly enabled: boolean;
    readonly baseUrl: string | undefined;
  };
  readonly mock: {
    readonly enabled: boolean;
    readonly latencyMs: number;
    readonly chunkDelayMs: number;
    readonly failureRate: number;
  };
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

/**
 * Parse and validate configuration.
 *
 * Reports EVERY invalid variable at once. Fixing one broken env var, redeploying,
 * and discovering the next one is a miserable loop we should not inflict on operators.
 *
 * `source` is injectable so tests never mutate the real process environment.
 * Phase 7 will extend this to merge a YAML config file (spec §7) beneath the
 * environment, with environment taking precedence.
 */
export interface LoadConfigDeps {
  /** Injected in tests so config loading never touches the real filesystem. */
  readonly readFile?: (path: string) => string;
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  deps: LoadConfigDeps = {},
): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }

  const env = parsed.data;

  // Structure (aliases, routes, provider enablement) comes from YAML;
  // credentials come only from the environment. The file cannot carry a key.
  const { file, path: configFile } = loadConfigFile({
    path: env.CONFIG_FILE,
    ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
  });

  /**
   * A provider is usable when the environment gave it a credential AND the
   * config file did not explicitly disable it. The file can only turn something
   * off — it can never turn on a provider that has no way to authenticate.
   */
  const isEnabled = (id: keyof ProvidersConfig, hasCredential: boolean): boolean =>
    hasCredential && file.providers?.[id]?.enabled !== false;

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    http: {
      host: env.HOST,
      port: env.PORT,
      bodyLimitBytes: env.BODY_LIMIT_BYTES,
      corsOrigins: parseOrigins(env.CORS_ORIGINS),
    },
    logging: {
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === "development",
    },
    postgres: {
      url: env.DATABASE_URL,
      poolMax: env.POSTGRES_POOL_MAX,
      connectionTimeoutMs: env.POSTGRES_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.POSTGRES_IDLE_TIMEOUT_MS,
    },
    redis: {
      url: env.REDIS_URL,
      keyPrefix: env.REDIS_KEY_PREFIX,
      rateLimit: {
        enabled: env.RATE_LIMIT_ENABLED,
        requestsPerMinute: env.RATE_LIMIT_REQUESTS_PER_MINUTE,
        // Defaulting burst to the rate means "60/minute" behaves the way people
        // expect it to, while still allowing a deliberate burst allowance.
        burst: env.RATE_LIMIT_BURST ?? env.RATE_LIMIT_REQUESTS_PER_MINUTE,
        failOpen: env.RATE_LIMIT_FAIL_OPEN,
      },
      cache: {
        enabled: env.CACHE_ENABLED,
        ttlSeconds: env.CACHE_TTL_SECONDS,
        scope: env.CACHE_SCOPE,
      },
      breaker: {
        enabled: env.BREAKER_ENABLED,
        failureThreshold: env.BREAKER_FAILURE_THRESHOLD,
        cooldownSeconds: env.BREAKER_COOLDOWN_SECONDS,
      },
    },
    readiness: {
      checkTimeoutMs: env.READINESS_CHECK_TIMEOUT_MS,
      cacheTtlMs: env.READINESS_CACHE_MS,
    },
    shutdown: {
      drainMs: env.SHUTDOWN_DRAIN_MS,
      timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      streamGraceMs: env.SHUTDOWN_STREAM_GRACE_MS,
    },
    reliability: {
      timeoutMs: env.PROVIDER_TIMEOUT_MS,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
      retry: {
        maxAttempts: env.RETRY_MAX_ATTEMPTS,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        maxDelayMs: env.RETRY_MAX_DELAY_MS,
        jitter: env.RETRY_JITTER,
      },
    },
    providers: {
      openai: {
        enabled: isEnabled("openai", env.OPENAI_API_KEY !== undefined),
        apiKey: env.OPENAI_API_KEY,
        baseUrl: stripTrailingSlash(env.OPENAI_BASE_URL),
      },
      gemini: {
        enabled: isEnabled("gemini", env.GEMINI_API_KEY !== undefined),
        apiKey: env.GEMINI_API_KEY,
        baseUrl: stripTrailingSlash(env.GEMINI_BASE_URL),
      },
      anthropic: {
        enabled: isEnabled("anthropic", env.ANTHROPIC_API_KEY !== undefined),
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: stripTrailingSlash(env.ANTHROPIC_BASE_URL),
        version: env.ANTHROPIC_VERSION,
      },
      ollama: {
        enabled: isEnabled("ollama", env.OLLAMA_BASE_URL !== undefined),
        baseUrl:
          env.OLLAMA_BASE_URL === undefined ? undefined : stripTrailingSlash(env.OLLAMA_BASE_URL),
      },
      mock: {
        // Enabled outside production unless explicitly overridden. A mock
        // provider silently reachable in production would let a
        // misconfiguration return fabricated completions to real users.
        enabled: isEnabled("mock", env.MOCK_PROVIDER_ENABLED ?? env.NODE_ENV !== "production"),
        latencyMs: env.MOCK_LATENCY_MS,
        chunkDelayMs: env.MOCK_CHUNK_DELAY_MS,
        failureRate: env.MOCK_FAILURE_RATE,
      },
    },
    routing: {
      routes: toRouteDefinitions(file),
      configFile,
    },
    auth: {
      // On in production, off elsewhere — the same shape as the mock provider,
      // and for the same reason: a convenient default must not become an
      // insecure production default.
      required: env.AUTH_REQUIRED ?? env.NODE_ENV === "production",
      adminApiKey: env.ADMIN_API_KEY,
      dashboardApiKey: env.DASHBOARD_API_KEY,
    },
    database: {
      skipMigrations: env.SKIP_MIGRATIONS,
    },
    observability: {
      recording: {
        enabled: env.REQUEST_RECORDING_ENABLED,
        batchSize: env.REQUEST_RECORDING_BATCH_SIZE,
        flushIntervalMs: env.REQUEST_RECORDING_FLUSH_MS,
        maxBufferSize: env.REQUEST_RECORDING_MAX_BUFFER,
      },
      pricing: mergePricing(toPricingTable(file.pricing)),
    },
  };
}

/** YAML `{input, output}` → the internal per-million-token shape. */
function toPricingTable(
  source: Readonly<Record<string, { input: number; output: number }>> | undefined,
): PricingTable | undefined {
  if (source === undefined) return undefined;

  const table: Record<string, { inputPerMillionTokens: number; outputPerMillionTokens: number }> =
    {};
  for (const [model, price] of Object.entries(source)) {
    table[model] = {
      inputPerMillionTokens: price.input,
      outputPerMillionTokens: price.output,
    };
  }
  return table;
}

/** `${baseUrl}/chat/completions` should not become `...//chat/completions`. */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function parseOrigins(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
