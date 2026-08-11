import cors from "@fastify/cors";
import { newRequestId } from "@openllm/core";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { ChatService } from "../chat/chat-service.js";
import type { AppConfig } from "../config/index.js";
import type { DependencyCheck } from "../infra/dependency.js";
import type { ApiKeyRepository } from "../auth/api-key-repository.js";
import type { RateLimiter } from "../redis/rate-limiter.js";
import type { RequestRecorder } from "../observability/request-recorder.js";
import type { RequestRepository } from "../observability/request-repository.js";
import type { Logger } from "../observability/logger.js";
import { createActiveStreams, type ActiveStreams } from "./active-streams.js";
import { registerAuthentication } from "./plugins/authentication.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerObservation, recordObservation } from "./plugins/observation.js";
import { READ_ONLY_ADMIN_PREFIXES, registerRateLimit } from "./plugins/rate-limit.js";
import { registerRequestContext } from "./plugins/request-context.js";
import { registerAdminKeyRoutes } from "./routes/admin-keys.js";
import { registerAdminStatsRoutes } from "./routes/admin-stats.js";
import { registerChatCompletionRoutes } from "./routes/chat-completions.js";
import {
  createReadinessProbe,
  registerHealthRoutes,
  type LifecycleView,
} from "./routes/health.js";

export interface ServerDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly lifecycle: LifecycleView;
  readonly checks: readonly DependencyCheck[];
  readonly version: string;
  readonly startedAt?: number;
  /**
   * Omitted only by tests that exercise the probe endpoints in isolation. When
   * absent, `/v1/chat/completions` is simply not registered.
   */
  readonly chatService?: ChatService;
  /** Required alongside chatService; shutdown uses it to drain open streams. */
  readonly activeStreams?: ActiveStreams;
  /** Required for authentication and key management. */
  readonly apiKeys?: ApiKeyRepository;
  /** Absent means no rate limiting. */
  readonly rateLimiter?: RateLimiter;
  /** Absent means requests are not persisted. */
  readonly recorder?: RequestRecorder;
  /** Absent means the dashboard's stats endpoints are not registered. */
  readonly requestRepository?: RequestRepository;
}

/**
 * Build a configured Fastify instance from injected dependencies.
 *
 * This function opens no connections and listens on no port. That is what lets
 * the unit tests run the real server with fake dependencies via `app.inject()`,
 * and the integration tests run the *same* builder against real Redis and
 * Postgres. A server that constructs its own database pool can only be tested
 * against a database.
 */
export async function buildServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const { config, logger } = deps;

  const app = Fastify({
    // Widened to FastifyBaseLogger so the instance keeps Fastify's default
    // generics. Otherwise every helper that takes a plain `FastifyInstance`
    // would have to be generic over the concrete pino logger type.
    loggerInstance: logger as FastifyBaseLogger,
    // Our own IDs, so the value in the log matches the x-request-id header the
    // client was given.
    genReqId: () => newRequestId(),
    bodyLimit: config.http.bodyLimitBytes,
    // Suppress Fastify's built-in per-request log lines: they carry no trace ID
    // and fire on every orchestrator health check. We emit our own in the
    // onResponse hook below. This is the replacement for the top-level
    // `disableRequestLogging` option, deprecated in Fastify 5 and gone in 6.
    logController: new LogController({
      disableRequestLogging: true,
      // Fastify labels its own request id `reqId`. Renaming it to `requestId`
      // means one key, matching the x-request-id header and the docs, instead of
      // the same value under two names on every line.
      requestIdLogLabel: "requestId",
    }),
  });

  // Zod validates request bodies and serializes responses. Using one schema
  // language for HTTP, config and provider payloads keeps the runtime check and
  // the compile-time type from drifting apart (decision D6). Response
  // serialization through the schema also means nothing outside it can leak
  // into a response body, whatever a later refactor returns.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerRequestContext(app);

  // Before the error handler and the routes: the draft must exist by the time
  // anything wants to write to it.
  const observationOptions =
    deps.recorder === undefined
      ? undefined
      : { recorder: deps.recorder, pricing: config.observability.pricing };
  registerObservation(app, observationOptions);

  registerErrorHandler(app);

  if (config.http.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: [...config.http.corsOrigins],
      credentials: true,
    });
  }

  const probe = createReadinessProbe({
    checks: deps.checks,
    checkTimeoutMs: config.readiness.checkTimeoutMs,
    cacheTtlMs: config.readiness.cacheTtlMs,
  });

  registerHealthRoutes(app, {
    lifecycle: deps.lifecycle,
    probe,
    version: deps.version,
    startedAt: deps.startedAt ?? Date.now(),
  });

  // Registered before the routes so the hook runs for every one of them,
  // including any added later — a route that forgets to opt in to auth would be
  // an open door, so opting OUT is the explicit act instead.
  if (deps.apiKeys !== undefined) {
    registerAuthentication(app, { config, repository: deps.apiKeys, logger });
    registerAdminKeyRoutes(app, { repository: deps.apiKeys });
  }

  if (deps.requestRepository !== undefined) {
    registerAdminStatsRoutes(app, { repository: deps.requestRepository });
  }

  // AFTER authentication, so the limit is keyed by the authenticated caller
  // rather than an IP they can change.
  if (deps.rateLimiter !== undefined) {
    registerRateLimit(app, {
      limiter: deps.rateLimiter,
      exemptPrefixes: READ_ONLY_ADMIN_PREFIXES,
    });
  }

  if (deps.chatService !== undefined) {
    registerChatCompletionRoutes(app, {
      chatService: deps.chatService,
      activeStreams: deps.activeStreams ?? createActiveStreams(),
      ...(observationOptions !== undefined
        ? {
            observation: (request, httpStatus) =>
              recordObservation(request, httpStatus, observationOptions),
          }
        : {}),
    });
  }

  // Probe endpoints are hit continuously by the orchestrator. Logging them
  // buries real traffic and, at scale, costs real money in log ingestion.
  const silentPaths = new Set(["/health", "/ready"]);

  app.addHook("onResponse", (request, reply, done) => {
    if (!silentPaths.has(request.url)) {
      request.log.info(
        {
          method: request.method,
          url: request.url,
          statusCode: reply.statusCode,
          latencyMs: Math.round(reply.elapsedTime),
        },
        "request completed",
      );
    }
    done();
  });

  return app;
}
