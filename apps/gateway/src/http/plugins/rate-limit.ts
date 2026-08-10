import { LLMError } from "@openllm/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RateLimiter } from "../../redis/rate-limiter.js";

export interface RateLimitOptions {
  readonly limiter: RateLimiter;
  /** Paths exempt from limiting. Probes are always exempt. */
  readonly exemptPaths?: ReadonlySet<string>;
}

const ALWAYS_EXEMPT = new Set(["/health", "/ready"]);

/**
 * Per-caller rate limiting (spec §12).
 *
 * Runs after authentication, which matters: the limit is keyed by the
 * authenticated API key, so it survives a client changing IP and cannot be
 * evaded by one. When auth is disabled the caller falls back to their address —
 * imperfect behind NAT, but the only identity available.
 *
 * Probes are exempt for the same reason they skip auth: an orchestrator polling
 * `/health` must not be able to exhaust a budget and get the instance killed.
 */
export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  const { limiter } = options;

  app.addHook("onRequest", async (request, reply) => {
    const path = pathOf(request);
    if (ALWAYS_EXEMPT.has(path) || options.exemptPaths?.has(path) === true) return;

    const { scope, identifier } = callerFor(request);
    const decision = await limiter.consume(scope, identifier);

    // OpenAI's header names, so a client's existing back-off handling works
    // unchanged — the same reasoning as the response body shape.
    void reply.header("x-ratelimit-limit-requests", String(decision.limit));
    void reply.header("x-ratelimit-remaining-requests", String(decision.remaining));
    void reply.header(
      "x-ratelimit-reset-requests",
      `${Math.ceil(decision.retryAfterMs / 1000)}s`,
    );

    if (decision.degraded) {
      // Visible to the caller AND in logs: a silently-not-limiting gateway is
      // how a bill arrives unexpectedly.
      void reply.header("x-openllm-ratelimit-degraded", "true");
      request.log.warn({ scope }, "rate limiting degraded; Redis unavailable");
    }

    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      void reply.header("retry-after", String(retryAfterSeconds));

      request.log.warn(
        { scope, identifier: redactIdentifier(identifier), retryAfterMs: decision.retryAfterMs },
        "request rate limited",
      );

      throw LLMError.rateLimited(
        `Rate limit exceeded. Retry in ${retryAfterSeconds}s.`,
        {
          // Ours, not a provider's: failing over to another provider would not
          // help, and retrying is the caller's decision, not the router's.
          retryable: false,
          failoverable: false,
          details: { retryAfterMs: decision.retryAfterMs },
        },
      );
    }
  });
}

function pathOf(request: FastifyRequest): string {
  const queryStart = request.url.indexOf("?");
  return queryStart === -1 ? request.url : request.url.slice(0, queryStart);
}

/**
 * Who is being limited.
 *
 * An authenticated key is the right unit — stable across IPs, and it is what an
 * operator would raise or lower a limit for. The IP fallback exists only so an
 * unauthenticated gateway is not completely unprotected.
 */
function callerFor(request: FastifyRequest): { scope: string; identifier: string } {
  if (request.apiKey !== undefined) {
    return { scope: "key", identifier: request.apiKey.id };
  }
  return { scope: "ip", identifier: request.ip };
}

/** An IP is personal data; a key id is not, but keep both short in logs. */
function redactIdentifier(identifier: string): string {
  return identifier.length > 12 ? `${identifier.slice(0, 12)}…` : identifier;
}

export function isRateLimitReply(reply: FastifyReply): boolean {
  return reply.statusCode === 429;
}
