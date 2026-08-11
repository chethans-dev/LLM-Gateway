import type { LLMErrorCode } from "@openllm/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { estimateCost, type PricingTable } from "../../observability/pricing.js";
import type { RequestRecorder } from "../../observability/request-recorder.js";
import type { TokenUsage } from "../../providers/types.js";

/**
 * Accumulated facts about a request, filled in as it progresses.
 *
 * Mutable by design — the handler learns the provider partway through, the
 * error handler learns the failure code later still. The alternative is
 * threading a growing tuple through every layer.
 *
 * There is no field for message content, so no call site can record any.
 */
export interface ObservationDraft {
  readonly startedAt: number;
  /** Set by the chat route. Its absence is how probes and 404s are excluded. */
  requestedModel: string | undefined;
  route: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  providerCalls: number;
  cached: boolean;
  streamed: boolean;
  usage: TokenUsage | undefined;
  errorCode: LLMErrorCode | undefined;
  /**
   * Failed despite a non-error status.
   *
   * Only a stream can be in this position: once the first chunk is written the
   * status is fixed at 200, so a provider failing halfway through is reported as
   * an event inside an otherwise-successful response. Deriving status from the
   * HTTP code alone would file that under "success" and hide truncated streams
   * from the success rate they should be dragging down.
   */
  failed: boolean;
  /** Set once written, so the hijacked streaming path is not recorded twice. */
  recorded: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    observation: ObservationDraft;
  }
}

export interface ObservationOptions {
  readonly recorder: RequestRecorder;
  readonly pricing: PricingTable;
}

/**
 * Persist one metadata row per gateway request (spec §15).
 *
 * Recording happens in an `onResponse` hook rather than in the route, so it
 * covers every outcome uniformly: success, validation failure, rate limit,
 * provider error. A route that returned early or threw would otherwise be a
 * request that silently never got recorded.
 *
 * Streaming is the exception — `reply.hijack()` means `onResponse` never fires —
 * so that path records explicitly and sets `recorded` to keep it idempotent.
 */
export function registerObservation(
  app: FastifyInstance,
  /** Absent means capture the draft but persist nothing. */
  options: ObservationOptions | undefined,
): void {
  // Assigned per request in the hook below. Decorating with an object literal
  // would give every concurrent request the SAME draft — Fastify shares the
  // decorator value, so one request's provider would overwrite another's.
  app.decorateRequest("observation", undefined as unknown as ObservationDraft);

  app.addHook("onRequest", (request, _reply, done) => {
    request.observation = {
      startedAt: performance.now(),
      requestedModel: undefined,
      route: undefined,
      provider: undefined,
      model: undefined,
      providerCalls: 0,
      cached: false,
      streamed: false,
      usage: undefined,
      errorCode: undefined,
      failed: false,
      recorded: false,
    };
    done();
  });

  // The draft is always created, even with no recorder: routes populate it
  // unconditionally, and a conditionally-existing property would be a
  // TypeError waiting for the first deployment that turns recording off.
  if (options === undefined) return;

  app.addHook("onResponse", (request, reply, done) => {
    recordObservation(request, reply.statusCode, options);
    done();
  });
}

/**
 * Write the record, once.
 *
 * Exported because the streaming path has to call it directly — a hijacked
 * response never reaches `onResponse`.
 */
export function recordObservation(
  request: FastifyRequest,
  httpStatus: number,
  options: ObservationOptions,
): void {
  const draft = request.observation;

  // Absent when the request never reached the chat route: health probes,
  // unknown paths, malformed bodies rejected by schema validation. Recording
  // those would bury real traffic in the table the dashboard reads.
  if (draft === undefined || draft.requestedModel === undefined) return;
  if (draft.recorded) return;
  draft.recorded = true;

  const cost =
    draft.model === undefined
      ? undefined
      : estimateCost(draft.usage, draft.model, draft.provider, options.pricing);

  options.recorder.record({
    requestId: request.id,
    traceId: request.traceId,
    apiKeyId: request.apiKey?.id,
    requestedModel: draft.requestedModel,
    route: draft.route,
    provider: draft.provider,
    model: draft.model,
    // `failed` covers the streamed case where the status is pinned at 200
    // because bytes were already on the wire when the provider broke.
    status: httpStatus < 400 && !draft.failed ? "success" : "error",
    errorCode: draft.errorCode,
    httpStatus,
    latencyMs: Math.round(performance.now() - draft.startedAt),
    providerCalls: draft.providerCalls,
    cached: draft.cached,
    streamed: draft.streamed,
    inputTokens: draft.usage?.inputTokens,
    outputTokens: draft.usage?.outputTokens,
    totalTokens: draft.usage?.totalTokens,
    // Undefined, never zero, when pricing or usage is unknown — see pricing.ts.
    estimatedCostUsd: cost?.usd,
  });
}
