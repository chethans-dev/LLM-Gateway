import { LLMError } from "@openllm/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type {
  RequestListItem,
  RequestRepository,
  StatsWindow,
} from "../../observability/request-repository.js";

export interface AdminStatsRouteOptions {
  readonly repository: RequestRepository;
}

const windowSchema = z.enum(["1h", "24h", "7d", "30d"]).default("24h");
const windowQuery = z.object({ window: windowSchema });

/**
 * Wire shapes.
 *
 * Nullable rather than defaulted-to-zero throughout. "No data" and "zero" are
 * different, and the whole cost path has preserved that distinction from the
 * provider adapters down — collapsing it here, at the last step before display,
 * would waste the effort.
 */
const summarySchema = z.object({
  total_requests: z.number(),
  successful_requests: z.number(),
  failed_requests: z.number(),
  success_rate: z.number().nullable(),
  average_latency_ms: z.number().nullable(),
  p95_latency_ms: z.number().nullable(),
  total_tokens: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  estimated_cost_usd: z.number(),
  requests_without_cost: z.number(),
  cached_requests: z.number(),
});

const requestItemSchema = z.object({
  id: z.string(),
  request_id: z.string(),
  trace_id: z.string(),
  created_at: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  requested_model: z.string(),
  status: z.enum(["success", "error"]),
  error_code: z.string().nullable(),
  http_status: z.number(),
  latency_ms: z.number(),
  total_tokens: z.number().nullable(),
  estimated_cost_usd: z.number().nullable(),
  cached: z.boolean(),
  streamed: z.boolean(),
});

const requestDetailSchema = requestItemSchema.extend({
  route: z.string().nullable(),
  api_key_id: z.string().nullable(),
  provider_calls: z.number(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
});

function toWireItem(item: RequestListItem) {
  return {
    id: item.id,
    request_id: item.requestId,
    trace_id: item.traceId,
    created_at: item.createdAt.toISOString(),
    provider: item.provider,
    model: item.model,
    requested_model: item.requestedModel,
    status: item.status,
    error_code: item.errorCode,
    http_status: item.httpStatus,
    latency_ms: item.latencyMs,
    total_tokens: item.totalTokens,
    estimated_cost_usd: item.estimatedCostUsd,
    cached: item.cached,
    streamed: item.streamed,
  };
}

/**
 * Read-only statistics for the dashboard (spec §18).
 *
 * Under `/v1/admin` so the authentication hook covers it, but in the read-only
 * subtree: these accept `DASHBOARD_API_KEY` as well as `ADMIN_API_KEY`. The
 * dashboard is a browser app, and the credential it holds must not be one that
 * can mint API keys.
 *
 * **Nothing here can return message content**, because none is stored. That is
 * spec §18's "do not show prompts/completions" satisfied by construction rather
 * than by a filter somebody could forget.
 */
export function registerAdminStatsRoutes(
  app: FastifyInstance,
  options: AdminStatsRouteOptions,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { repository } = options;

  typed.get(
    "/v1/admin/stats/summary",
    { schema: { querystring: windowQuery, response: { 200: summarySchema } } },
    async (request) => {
      const summary = await repository.summary(request.query.window as StatsWindow);
      return {
        total_requests: summary.totalRequests,
        successful_requests: summary.successfulRequests,
        failed_requests: summary.failedRequests,
        success_rate: summary.successRate,
        average_latency_ms: summary.averageLatencyMs,
        p95_latency_ms: summary.p95LatencyMs,
        total_tokens: summary.totalTokens,
        input_tokens: summary.inputTokens,
        output_tokens: summary.outputTokens,
        estimated_cost_usd: summary.estimatedCostUsd,
        requests_without_cost: summary.requestsWithoutCost,
        cached_requests: summary.cachedRequests,
      };
    },
  );

  typed.get(
    "/v1/admin/stats/providers",
    {
      schema: {
        querystring: windowQuery,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                provider: z.string(),
                requests: z.number(),
                successful_requests: z.number(),
                average_latency_ms: z.number().nullable(),
                total_tokens: z.number(),
                estimated_cost_usd: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const rows = await repository.byProvider(request.query.window as StatsWindow);
      return {
        data: rows.map((row) => ({
          provider: row.provider,
          requests: row.requests,
          successful_requests: row.successfulRequests,
          average_latency_ms: row.averageLatencyMs,
          total_tokens: row.totalTokens,
          estimated_cost_usd: row.estimatedCostUsd,
        })),
      };
    },
  );

  typed.get(
    "/v1/admin/stats/timeseries",
    {
      schema: {
        querystring: windowQuery,
        response: {
          200: z.object({
            bucket_seconds: z.number(),
            data: z.array(
              z.object({
                bucket_start: z.string(),
                total: z.number(),
                errors: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const series = await repository.timeseries(request.query.window as StatsWindow);
      return {
        bucket_seconds: series.bucketSeconds,
        data: series.buckets.map((bucket) => ({
          bucket_start: bucket.bucketStart.toISOString(),
          total: bucket.total,
          errors: bucket.errors,
        })),
      };
    },
  );

  typed.get(
    "/v1/admin/stats/facets",
    {
      schema: {
        querystring: windowQuery,
        response: {
          200: z.object({ providers: z.array(z.string()), models: z.array(z.string()) }),
        },
      },
    },
    async (request) => {
      const facets = await repository.facets(request.query.window as StatsWindow);
      return { providers: [...facets.providers], models: [...facets.models] };
    },
  );

  typed.get(
    "/v1/admin/requests",
    {
      schema: {
        querystring: z.object({
          window: windowSchema,
          // Capped: an unbounded limit is a way to make the gateway read its
          // whole history into memory on somebody's behalf.
          limit: z.coerce.number().int().min(1).max(200).default(50),
          status: z.enum(["success", "error"]).optional(),
          provider: z.string().min(1).max(100).optional(),
          model: z.string().min(1).max(200).optional(),
          /** From a previous response's `next_cursor`. */
          cursor: z.string().min(1).max(200).optional(),
        }),
        response: {
          200: z.object({
            data: z.array(requestItemSchema),
            next_cursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { window, limit, status, provider, model, cursor } = request.query;

      const page = await repository.recent({
        window: window as StatsWindow,
        limit,
        // `exactOptionalPropertyTypes` is on, so an absent filter must be an
        // absent key rather than an explicit undefined.
        filters: {
          ...(status !== undefined ? { status } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
        },
        cursor: cursor ?? null,
      });

      return { data: page.items.map(toWireItem), next_cursor: page.nextCursor };
    },
  );

  typed.get(
    "/v1/admin/requests/:id",
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: { 200: requestDetailSchema },
      },
    },
    async (request) => {
      const detail = await repository.find(request.params.id);

      if (detail === undefined) {
        throw LLMError.modelNotFound(`No request found with id '${request.params.id}'`, {
          httpStatus: 404,
        });
      }

      return {
        ...toWireItem(detail),
        route: detail.route,
        api_key_id: detail.apiKeyId,
        provider_calls: detail.providerCalls,
        input_tokens: detail.inputTokens,
        output_tokens: detail.outputTokens,
      };
    },
  );

  typed.get(
    "/v1/admin/traces/:traceId",
    {
      schema: {
        params: z.object({ traceId: z.string().min(1) }),
        response: { 200: z.object({ data: z.array(requestItemSchema) }) },
      },
    },
    async (request) => {
      // Following one logical operation across requests (spec §15) — the reason
      // trace IDs are adopted from callers rather than always minted here.
      const rows = await repository.byTrace(request.params.traceId);
      return { data: rows.map(toWireItem) };
    },
  );
}
