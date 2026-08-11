import { ConfigError, loadConfig, type AppConfig } from "./config/index.js";
import { createPostgresClient } from "./infra/postgres.js";
import { connectRedis, createRedisClient } from "./infra/redis.js";
import { ShutdownManager } from "./infra/shutdown.js";
import { createApiKeyRepository } from "./auth/api-key-repository.js";
import { createRequestPruner } from "./observability/request-pruner.js";
import { createRequestRecorder } from "./observability/request-recorder.js";
import { createRequestRepository } from "./observability/request-repository.js";
import { createChatService } from "./chat/chat-service.js";
import { runMigrations } from "./db/migrate.js";
import { createActiveStreams } from "./http/active-streams.js";
import { buildServer } from "./http/server.js";
import { createLogger } from "./observability/logger.js";
import { createProviderRegistry } from "./providers/index.js";
import { createCircuitBreaker } from "./redis/circuit-breaker.js";
import { createRedisKeys } from "./redis/keys.js";
import { createRateLimiter } from "./redis/rate-limiter.js";
import { createResponseCache } from "./redis/response-cache.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const startedAt = Date.now();

  // Config is validated before anything else exists — including the logger.
  // A container that boots with a malformed DATABASE_URL and only finds out on
  // the first request has already been marked healthy and put into rotation.
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
    return;
  }

  const logger = createLogger(config);

  const shutdown = new ShutdownManager({
    logger,
    drainMs: config.shutdown.drainMs,
    timeoutMs: config.shutdown.timeoutMs,
  });
  // Trap signals before any connection exists, so a SIGTERM during a slow boot
  // still gets an orderly teardown instead of leaking sockets.
  shutdown.listen();

  const postgres = createPostgresClient(config, logger);
  const redis = createRedisClient(config, logger);
  await connectRedis(redis, logger);

  // Built at boot so misconfiguration is visible in the startup log rather than
  // discovered by the first real request.
  if (!config.database.skipMigrations) {
    await runMigrations(postgres.db, logger);
  }

  const apiKeys = createApiKeyRepository({ db: postgres.db, logger });

  if (!config.auth.required) {
    // Never a quiet state. An operator who did not intend this must see it.
    logger.warn(
      { authRequired: false },
      "API key authentication is DISABLED — /v1 is open to anyone who can reach it",
    );
  }
  if (config.auth.adminApiKey === undefined) {
    logger.info({}, "key management disabled (set ADMIN_API_KEY to enable /v1/admin)");
  }

  const keys = createRedisKeys(config.redis.keyPrefix);

  const rateLimiter = config.redis.rateLimit.enabled
    ? createRateLimiter({
        redis: redis.redis,
        keys,
        policy: {
          requestsPerMinute: config.redis.rateLimit.requestsPerMinute,
          burst: config.redis.rateLimit.burst,
        },
        logger,
        failOpen: config.redis.rateLimit.failOpen,
      })
    : undefined;

  const cache = config.redis.cache.enabled
    ? createResponseCache({
        redis: redis.redis,
        keys,
        ttlSeconds: config.redis.cache.ttlSeconds,
        scope: config.redis.cache.scope,
        logger,
      })
    : undefined;

  const breaker = config.redis.breaker.enabled
    ? createCircuitBreaker({
        redis: redis.redis,
        keys,
        failureThreshold: config.redis.breaker.failureThreshold,
        cooldownSeconds: config.redis.breaker.cooldownSeconds,
        logger,
      })
    : undefined;

  logger.info(
    {
      namespace: keys.namespace,
      rateLimit: config.redis.rateLimit.enabled
        ? `${config.redis.rateLimit.requestsPerMinute}/min`
        : "disabled",
      cache: config.redis.cache.enabled ? `${config.redis.cache.ttlSeconds}s` : "disabled",
      circuitBreaker: config.redis.breaker.enabled ? "enabled" : "disabled",
    },
    "redis features configured",
  );

  if (config.redis.cache.enabled) {
    // Caching stores completion text at rest. That is a deliberate trade, but
    // it must never be one somebody made by accident.
    logger.warn(
      { ttlSeconds: config.redis.cache.ttlSeconds, scope: config.redis.cache.scope },
      "response cache ENABLED — completion content is stored in Redis until it expires",
    );
  }

  const recorder = config.observability.recording.enabled
    ? createRequestRecorder({
        db: postgres.db,
        logger,
        batchSize: config.observability.recording.batchSize,
        flushIntervalMs: config.observability.recording.flushIntervalMs,
        maxBufferSize: config.observability.recording.maxBufferSize,
      })
    : undefined;

  // Without a retention policy the requests table grows forever: at 100 req/s
  // that is ~260M rows a year, and every dashboard query slows until somebody
  // notices. 0 disables pruning, which is a choice an operator can make but not
  // one to fall into by default.
  const pruner =
    config.observability.retention.retentionDays > 0
      ? createRequestPruner({
          db: postgres.db,
          logger,
          retentionDays: config.observability.retention.retentionDays,
          intervalMs: config.observability.retention.intervalMs,
          batchSize: config.observability.retention.batchSize,
        })
      : undefined;

  if (pruner !== undefined) {
    pruner.start();
    logger.info(
      {
        retentionDays: config.observability.retention.retentionDays,
        intervalMs: config.observability.retention.intervalMs,
      },
      "request history retention enabled",
    );
  } else {
    logger.warn(
      { retentionDays: 0 },
      "request history retention is DISABLED — the requests table will grow without bound",
    );
  }

  const requestRepository = createRequestRepository(postgres.db);

  const registry = createProviderRegistry(config, logger);
  const chatService = createChatService({
    registry,
    config,
    logger,
    ...(cache !== undefined ? { cache } : {}),
    ...(breaker !== undefined ? { breaker } : {}),
  });
  const activeStreams = createActiveStreams();

  if (chatService.routes.size() > 0) {
    logger.info(
      { routes: chatService.routes.names(), configFile: config.routing.configFile },
      "model routes configured",
    );
  }

  const app = await buildServer({
    config,
    logger,
    lifecycle: shutdown,
    checks: [redis, postgres],
    version: VERSION,
    startedAt,
    chatService,
    activeStreams,
    apiKeys,
    ...(rateLimiter !== undefined ? { rateLimiter } : {}),
    ...(recorder !== undefined ? { recorder } : {}),
    requestRepository,
    registry,
  });

  // Registration order IS teardown order: stop accepting work first, then close
  // the things in-flight work depends on.
  //
  // Streams come before the HTTP server: a streamed completion can run for tens
  // of seconds, and `app.close()` would sit waiting for it. Giving streams a
  // bounded grace period and then aborting them cleanly is better than either
  // cutting them instantly or blocking until the force-exit timer fires.
  shutdown.register({
    name: "active-streams",
    run: async () => {
      if (activeStreams.size() === 0) return;

      logger.info(
        { streams: activeStreams.size(), graceMs: config.shutdown.streamGraceMs },
        "waiting for active streams to finish",
      );
      await activeStreams.drain(config.shutdown.streamGraceMs);

      if (activeStreams.size() > 0) {
        logger.warn({ streams: activeStreams.size() }, "aborting streams that did not finish");
        activeStreams.abortAll(new Error("gateway is shutting down"));
      }
    },
  });
  shutdown.register({ name: "http-server", run: () => app.close() });
  // AFTER the server closes, so records from the last in-flight requests are
  // already buffered. Before Postgres closes, because it needs the pool.
  if (recorder !== undefined) {
    shutdown.register({
      name: "request-recorder",
      run: async () => {
        recorder.stop();
        await recorder.flush();
        const dropped = recorder.droppedCount();
        if (dropped > 0) logger.warn({ dropped }, "request records dropped during this run");
      },
    });
  }
  if (pruner !== undefined) {
    shutdown.register({ name: "request-pruner", run: async () => pruner.stop() });
  }
  shutdown.register({ name: "redis", run: () => redis.close() });
  shutdown.register({ name: "postgres", run: () => postgres.close() });

  await app.listen({ host: config.http.host, port: config.http.port });

  shutdown.markReady();
  // `env` is already on the base logger — repeating it here would emit a
  // duplicate key in the JSON line.
  logger.info(
    { host: config.http.host, port: config.http.port, version: VERSION },
    "gateway listening",
  );
}

void main();
