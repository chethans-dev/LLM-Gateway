import pino from "pino";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../src/config/index.js";
import type { DependencyCheck } from "../../src/infra/dependency.js";
import type { LifecycleState } from "../../src/infra/shutdown.js";
import { buildServer } from "../../src/http/server.js";
import type { LifecycleView } from "../../src/http/routes/health.js";
import { createChatService, type ChatService } from "../../src/chat/chat-service.js";
import type { ActiveStreams } from "../../src/http/active-streams.js";
import { createProviderRegistry } from "../../src/providers/registry.js";

export const silentLogger = pino({ level: "silent" });

const baseConfig: AppConfig = {
  env: "test",
  isProduction: false,
  http: { host: "127.0.0.1", port: 0, bodyLimitBytes: 1024, corsOrigins: [] },
  logging: { level: "silent", pretty: false },
  postgres: {
    url: "postgresql://postgres:postgres@127.0.0.1:5432/openllm_test",
    poolMax: 2,
    connectionTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
  },
  redis: {
    url: "redis://127.0.0.1:6379",
    keyPrefix: "openllm-test",
    // Redis features off by default so existing tests need no Redis; the
    // Redis tests enable them explicitly.
    rateLimit: { enabled: false, requestsPerMinute: 60, burst: 60, failOpen: true },
    cache: { enabled: false, ttlSeconds: 300, scope: "global" },
    breaker: { enabled: false, failureThreshold: 5, cooldownSeconds: 30 },
  },
  readiness: { checkTimeoutMs: 50, cacheTtlMs: 0 },
  shutdown: { drainMs: 0, timeoutMs: 1_000, streamGraceMs: 0 },
  reliability: {
    timeoutMs: 1_000,
    requestTimeoutMs: 5_000,
    // Retry off by default so existing tests assert one call per target;
    // the retry tests opt in explicitly.
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5, jitter: false },
  },
  providers: {
    openai: { enabled: false, apiKey: undefined, baseUrl: "https://api.openai.com/v1" },
    gemini: {
      enabled: false,
      apiKey: undefined,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
    anthropic: {
      enabled: false,
      apiKey: undefined,
      baseUrl: "https://api.anthropic.com/v1",
      version: "2023-06-01",
    },
    ollama: { enabled: false, baseUrl: undefined },
    mock: { enabled: true, latencyMs: 0, chunkDelayMs: 0, failureRate: 0 },
  },
  routing: { routes: [], configFile: undefined },
  // Auth off by default so route tests stay about routing; the auth tests
  // enable it explicitly.
  auth: { required: false, adminApiKey: undefined, dashboardApiKey: undefined },
  database: { skipMigrations: true },
  observability: {
    recording: { enabled: false, batchSize: 10, flushIntervalMs: 50, maxBufferSize: 100 },
    retention: { retentionDays: 90, intervalMs: 3_600_000, batchSize: 100 },
    pricing: { mock: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } },
  },
};

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...baseConfig, ...overrides };
}

export function fakeLifecycle(state: LifecycleState): LifecycleView {
  return { getState: () => state };
}

export type CheckBehaviour = "up" | "down" | "hang";

export interface FakeCheck extends DependencyCheck {
  readonly calls: () => number;
}

export function fakeCheck(name: string, behaviour: CheckBehaviour = "up"): FakeCheck {
  let calls = 0;
  return {
    name,
    calls: () => calls,
    async ping(): Promise<void> {
      calls += 1;
      if (behaviour === "down") throw new Error(`${name} is unreachable`);
      // Never settles — proves the probe applies its own timeout rather than
      // trusting the dependency to respect the one it was given.
      if (behaviour === "hang") await new Promise<void>(() => {});
    },
  };
}

export interface TestServerOptions {
  readonly state?: LifecycleState;
  readonly checks?: readonly DependencyCheck[];
  readonly config?: Partial<AppConfig>;
}

export async function buildTestServer(options: TestServerOptions = {}): Promise<FastifyInstance> {
  return buildServer({
    config: createTestConfig(options.config),
    logger: silentLogger,
    lifecycle: fakeLifecycle(options.state ?? "ready"),
    checks: options.checks ?? [fakeCheck("redis"), fakeCheck("postgres")],
    version: "0.1.0-test",
  });
}

/**
 * The full request path: route → chat service → model resolver → registry →
 * provider. Backed by the mock provider, so it costs nothing and never touches
 * the network.
 */
export async function buildChatServer(
  configOverrides: Partial<AppConfig> = {},
  activeStreams?: ActiveStreams,
): Promise<FastifyInstance> {
  const config = createTestConfig(configOverrides);
  const registry = createProviderRegistry(config, silentLogger);

  return buildServer({
    config,
    logger: silentLogger,
    lifecycle: fakeLifecycle("ready"),
    checks: [],
    version: "0.1.0-test",
    chatService: createChatService({ registry, config }),
    ...(activeStreams !== undefined ? { activeStreams } : {}),
  });
}

/**
 * Same server, but with a hand-written ChatService.
 *
 * Needed for failure modes the mock provider deliberately cannot produce — most
 * importantly an error raised *after* chunks have already been sent, which is
 * the case where the status code is no longer changeable.
 */
export async function buildServerWithChatService(
  chatService: ChatService,
  activeStreams?: ActiveStreams,
): Promise<FastifyInstance> {
  return buildServer({
    config: createTestConfig(),
    logger: silentLogger,
    lifecycle: fakeLifecycle("ready"),
    checks: [],
    version: "0.1.0-test",
    chatService,
    ...(activeStreams !== undefined ? { activeStreams } : {}),
  });
}
