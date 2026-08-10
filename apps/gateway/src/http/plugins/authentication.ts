import { LLMError } from "@openllm/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractCredential, looksLikeApiKey, secureCompare } from "../../auth/api-key.js";
import type { ApiKeyIdentity, ApiKeyRepository } from "../../auth/api-key-repository.js";
import type { AppConfig } from "../../config/index.js";
import type { Logger } from "../../observability/logger.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set once a request has authenticated. Undefined when auth is disabled. */
    apiKey?: ApiKeyIdentity;
  }
}

export interface AuthenticationOptions {
  readonly config: AppConfig;
  readonly repository: ApiKeyRepository;
  readonly logger: Logger;
}

/**
 * Paths that must never require a credential.
 *
 * An orchestrator's liveness probe cannot hold an API key. If `/health` needed
 * one, a misconfigured secret would make Kubernetes kill every pod — turning an
 * auth problem into a total outage.
 */
const PUBLIC_PATHS = new Set(["/health", "/ready"]);

const ADMIN_PREFIX = "/v1/admin";
/**
 * Read-only subtree of /v1/admin.
 *
 * Accepts the dashboard credential as well as the admin one. Everything else
 * under /v1/admin — key creation and revocation — still requires ADMIN_API_KEY.
 */
const READ_ONLY_ADMIN_PREFIXES = ["/v1/admin/stats", "/v1/admin/requests"] as const;

/**
 * API key authentication (spec §13).
 *
 * Two separate credentials, deliberately:
 *
 *  - **User keys** (`olgm_live_*`) live in the database as hashes and reach the
 *    `/v1` API.
 *  - **The admin secret** lives only in the environment and reaches `/v1/admin`.
 *    Keeping it out of the database means a database compromise cannot mint new
 *    keys — the attacker would get hashes they cannot reverse and no way to
 *    issue working credentials.
 */
export function registerAuthentication(
  app: FastifyInstance,
  options: AuthenticationOptions,
): void {
  const { config, repository, logger } = options;

  app.addHook("onRequest", async (request) => {
    const path = pathOf(request);

    if (PUBLIC_PATHS.has(path)) return;

    if (path.startsWith(ADMIN_PREFIX)) {
      const readOnly = READ_ONLY_ADMIN_PREFIXES.some((prefix) => path.startsWith(prefix));
      authenticateAdmin(request, config, logger, readOnly);
      return;
    }

    if (!config.auth.required) return;

    await authenticateApiKey(request, repository, logger);
  });
}

/** Strip the query string; `/health?x=1` is still the health probe. */
function pathOf(request: FastifyRequest): string {
  const queryStart = request.url.indexOf("?");
  return queryStart === -1 ? request.url : request.url.slice(0, queryStart);
}

function unauthorized(message: string): LLMError {
  return LLMError.authentication(message, {
    // Never failoverable and never retryable: this is our caller's problem, and
    // replaying it at another provider would be nonsense.
    failoverable: false,
  });
}

function authenticateAdmin(
  request: FastifyRequest,
  config: AppConfig,
  logger: Logger,
  readOnly = false,
): void {
  // A read-only route accepts either credential; a mutating one accepts only
  // the admin secret. The dashboard therefore never holds a key that can mint
  // API keys, which matters because a browser app's credential is one XSS away
  // from being someone else's.
  const accepted = readOnly
    ? [config.auth.adminApiKey, config.auth.dashboardApiKey].filter(
        (value): value is string => value !== undefined,
      )
    : [config.auth.adminApiKey].filter((value): value is string => value !== undefined);

  if (accepted.length === 0) {
    // Not "unauthorized" — the feature is switched off. Saying so plainly beats
    // an operator debugging a credential they never set.
    throw LLMError.invalidRequest(
      readOnly
        ? "Stats are disabled. Set DASHBOARD_API_KEY (or ADMIN_API_KEY) to enable them."
        : "Key management is disabled. Set ADMIN_API_KEY to enable /v1/admin.",
      { httpStatus: 404 },
    );
  }

  const presented = extractCredential(request.headers);
  if (presented === undefined) {
    throw unauthorized("Missing admin credential. Send 'Authorization: Bearer <ADMIN_API_KEY>'.");
  }

  // Every candidate is compared, so the time taken does not reveal which
  // credential matched — or how many are configured.
  const matched = accepted.reduce(
    (found, candidate) => secureCompare(presented, candidate) || found,
    false,
  );

  if (!matched) {
    logger.warn({ path: request.url, readOnly }, "admin authentication failed");
    throw unauthorized("Invalid admin credential.");
  }
}

async function authenticateApiKey(
  request: FastifyRequest,
  repository: ApiKeyRepository,
  logger: Logger,
): Promise<void> {
  const presented = extractCredential(request.headers);

  if (presented === undefined) {
    throw unauthorized(
      "Missing API key. Send 'Authorization: Bearer olgm_live_...'.",
    );
  }

  // Shape check first, so a scanner spraying random strings never reaches
  // Postgres.
  if (!looksLikeApiKey(presented)) {
    throw unauthorized("Invalid API key.");
  }

  const identity = await repository.findActiveByKey(presented);

  if (identity === undefined) {
    // Deliberately identical to the message above. Distinguishing "unknown key"
    // from "revoked key" would confirm to an attacker that a value was once
    // valid. The distinction is available server-side, in the logs.
    logger.warn({ path: request.url }, "api key authentication failed");
    throw unauthorized("Invalid API key.");
  }

  request.apiKey = identity;
  // Every log line for this request now carries who made it — and Phase 9
  // persists it alongside the request record.
  request.log = request.log.child({ apiKeyId: identity.id, apiKeyName: identity.name });

  repository.touch(identity.id);
}
