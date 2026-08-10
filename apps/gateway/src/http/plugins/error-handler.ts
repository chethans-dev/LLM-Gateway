import { LLMError, toOpenAIErrorEnvelope } from "@openllm/core";
import type { FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

/**
 * Translate everything that can go wrong into the OpenAI-compatible error
 * envelope (spec §4, §23).
 *
 * There is exactly one of these. Phase 4 adds `/v1/chat/completions` without
 * needing a second error path, which is what keeps the compatibility promise
 * honest: a client's error handling works the same whether the failure came from
 * our validation layer, our router, or the upstream provider.
 */
export function normalizeError(error: unknown): LLMError {
  if (LLMError.is(error)) return error;

  // Zod rejected the body. Report WHICH field and why — "Invalid request" costs
  // the caller a debugging session that a field name would have prevented.
  if (hasZodFastifySchemaValidationErrors(error)) {
    const details = error.validation
      .map((issue) => {
        const path = issue.instancePath.replace(/^\//, "").replace(/\//g, ".");
        const message = issue.message ?? "is invalid";
        return path.length > 0 ? `${path}: ${message}` : message;
      })
      .filter((message) => message.length > 0)
      .join("; ");

    return LLMError.invalidRequest(details.length > 0 ? details : "Invalid request body");
  }

  if (isFastifyError(error)) {
    // Schema validation rejected the payload before the handler ran.
    if (error.validation !== undefined) {
      return LLMError.invalidRequest(error.message);
    }
    if (error.statusCode === 413) {
      return LLMError.invalidRequest("Request body is too large");
    }
    if (error.statusCode === 429) {
      return LLMError.rateLimited(error.message);
    }
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return LLMError.invalidRequest(error.message, { httpStatus: error.statusCode });
    }
  }

  // Unknown failure: this is our bug. The client gets a generic message and the
  // request ID; the detail stays in our logs. Stack traces are never a response body.
  return LLMError.internal("Internal server error", { cause: error });
}

interface FastifyLikeError {
  statusCode?: number;
  validation?: unknown;
  message: string;
}

function isFastifyError(error: unknown): error is FastifyLikeError {
  return error instanceof Error && ("statusCode" in error || "validation" in error);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    // The observation hook reads these. Without the error code, every failure
    // would be recorded with a status but no reason.
    if (request.observation !== undefined) {
      request.observation.errorCode = normalized.code;
      // A failed request never reaches the success path that normally records
      // the provider, so without this "which provider failed?" — the single most
      // useful question a dashboard answers — shows as unrouted.
      request.observation.provider ??= normalized.provider;
      request.observation.model ??= normalized.model;
    }

    const logPayload = {
      err: error,
      code: normalized.code,
      httpStatus: normalized.httpStatus,
      retryable: normalized.retryable,
    };

    // 5xx is our problem and deserves error level; 4xx is the caller's and would
    // otherwise let anyone fill our logs with error-level noise by sending junk.
    if (normalized.httpStatus >= 500) {
      request.log.error(logPayload, "request failed");
    } else {
      request.log.warn(logPayload, "request rejected");
    }

    void reply
      .status(normalized.httpStatus)
      .send(toOpenAIErrorEnvelope(normalized, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    const error = LLMError.invalidRequest(`Unknown route: ${request.method} ${request.url}`, {
      httpStatus: 404,
    });
    void reply.status(404).send(toOpenAIErrorEnvelope(error, request.id));
  });
}
