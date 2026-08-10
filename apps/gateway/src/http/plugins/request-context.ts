import { AsyncLocalStorage } from "node:async_hooks";
import { newTraceId, parseTraceId, type RequestId, type TraceId } from "@openllm/core";
import type { FastifyInstance } from "fastify";

export interface RequestContext {
  readonly requestId: RequestId;
  readonly traceId: TraceId;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Read correlation IDs from anywhere in the call stack.
 *
 * This is the alternative to threading a `ctx` parameter through every function
 * signature between the route and the provider HTTP client. From Phase 3 a
 * provider adapter can log with the right requestId without the router having to
 * hand it one, and in Phase 9 the persistence layer can stamp the trace ID
 * without changing any intermediate signature.
 *
 * It is also the seam OpenTelemetry slots into later (spec §2) — an OTel span
 * context lives in exactly this kind of storage.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

declare module "fastify" {
  interface FastifyRequest {
    traceId: TraceId;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Assign a request ID and trace ID to every request.
 *
 * `request.id` is already our `req_*` value — see `genReqId` in server.ts.
 * The trace ID is adopted from an inbound `x-trace-id` when the caller supplied
 * a well-formed one, so a trace that starts upstream stays joined to ours;
 * otherwise we mint a new one.
 *
 * Both are echoed back as response headers so a client hitting a bug can quote
 * an ID that we can find in the logs.
 */
export function registerRequestContext(app: FastifyInstance): void {
  // Primitive placeholder: Fastify shares the decorator across requests, so a
  // reference type here would be shared mutable state between them.
  app.decorateRequest("traceId", "" as TraceId);

  app.addHook("onRequest", (request, reply, done) => {
    const requestId = request.id as RequestId;
    const traceId = parseTraceId(firstHeader(request.headers["x-trace-id"])) ?? newTraceId();

    request.traceId = traceId;
    // Only traceId: Fastify's own child logger already carries the request id,
    // relabelled to `requestId` in server.ts.
    request.log = request.log.child({ traceId });

    void reply.header("x-request-id", requestId);
    void reply.header("x-trace-id", traceId);

    // run() (rather than enterWith()) keeps the context scoped to this request
    // and lets Node reclaim it when the request finishes.
    storage.run({ requestId, traceId }, done);
  });
}
