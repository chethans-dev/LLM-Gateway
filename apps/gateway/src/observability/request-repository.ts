import { desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../auth/api-key-repository.js";
import { requests, type RequestRow } from "../db/schema.js";

/**
 * Read-only queries over the request history (spec §18).
 *
 * All SQL lives here rather than in a route handler (spec §22). Aggregation runs
 * in Postgres, not in JavaScript: a dashboard that loads a month of rows to sum
 * them in the browser stops working at exactly the traffic level where the
 * numbers become interesting.
 */

export type StatsWindow = "1h" | "24h" | "7d" | "30d";

export const STATS_WINDOWS: readonly StatsWindow[] = ["1h", "24h", "7d", "30d"];

const WINDOW_INTERVALS: Record<StatsWindow, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

export interface StatsSummary {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  /** 0–1. Null when there is no traffic — 100% of nothing is not 100%. */
  readonly successRate: number | null;
  readonly averageLatencyMs: number | null;
  /**
   * The number that actually matters for latency. An average hides the tail,
   * and the tail is what users experience as "the gateway is slow".
   */
  readonly p95LatencyMs: number | null;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Sum of known costs. Requests with unknown pricing contribute nothing. */
  readonly estimatedCostUsd: number;
  /**
   * How many requests had no cost estimate. Without this the total looks
   * authoritative when it may be missing most of the traffic.
   */
  readonly requestsWithoutCost: number;
  readonly cachedRequests: number;
}

export interface ProviderStats {
  readonly provider: string;
  readonly requests: number;
  readonly successfulRequests: number;
  readonly averageLatencyMs: number | null;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

export interface RequestListItem {
  readonly id: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly createdAt: Date;
  readonly provider: string | null;
  readonly model: string | null;
  readonly requestedModel: string;
  readonly status: "success" | "error";
  readonly errorCode: string | null;
  readonly httpStatus: number;
  readonly latencyMs: number;
  readonly totalTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly cached: boolean;
  readonly streamed: boolean;
}

export interface RequestDetail extends RequestListItem {
  readonly route: string | null;
  readonly apiKeyId: string | null;
  readonly providerCalls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface RequestRepository {
  summary(window: StatsWindow): Promise<StatsSummary>;
  byProvider(window: StatsWindow): Promise<readonly ProviderStats[]>;
  recent(options: { window: StatsWindow; limit: number }): Promise<readonly RequestListItem[]>;
  /** Accepts the database id or the `req_…` request id. */
  find(id: string): Promise<RequestDetail | undefined>;
  /** Every request sharing a trace, for following one logical operation. */
  byTrace(traceId: string): Promise<readonly RequestListItem[]>;
}

/** Postgres returns NUMERIC and COUNT as strings to avoid precision loss. */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createRequestRepository(db: Database): RequestRepository {
  const since = (window: StatsWindow) =>
    sql<Date>`now() - ${sql.raw(`interval '${WINDOW_INTERVALS[window]}'`)}`;

  return {
    async summary(window): Promise<StatsSummary> {
      const result = await db.execute<Record<string, unknown>>(sql`
        select
          count(*)                                             as total,
          count(*) filter (where status = 'success')           as successes,
          count(*) filter (where status = 'error')             as failures,
          count(*) filter (where cached)                       as cached,
          count(*) filter (where estimated_cost_usd is null)   as without_cost,
          avg(latency_ms)                                      as avg_latency,
          percentile_cont(0.95) within group (order by latency_ms) as p95_latency,
          coalesce(sum(total_tokens), 0)                       as total_tokens,
          coalesce(sum(input_tokens), 0)                       as input_tokens,
          coalesce(sum(output_tokens), 0)                      as output_tokens,
          -- sum() skips NULLs, so unpriced models do not drag the total to zero.
          coalesce(sum(estimated_cost_usd), 0)                 as cost
        from requests
        where created_at >= ${since(window)}
      `);

      const row = result.rows[0] ?? {};
      const total = toNumber(row["total"]);
      const successes = toNumber(row["successes"]);

      return {
        totalRequests: total,
        successfulRequests: successes,
        failedRequests: toNumber(row["failures"]),
        // Null rather than 1 when there is no traffic: "100% success" from zero
        // requests is a misleading thing to put on a dashboard.
        successRate: total === 0 ? null : successes / total,
        averageLatencyMs: toNullableNumber(row["avg_latency"]),
        p95LatencyMs: toNullableNumber(row["p95_latency"]),
        totalTokens: toNumber(row["total_tokens"]),
        inputTokens: toNumber(row["input_tokens"]),
        outputTokens: toNumber(row["output_tokens"]),
        estimatedCostUsd: toNumber(row["cost"]),
        requestsWithoutCost: toNumber(row["without_cost"]),
        cachedRequests: toNumber(row["cached"]),
      };
    },

    async byProvider(window): Promise<readonly ProviderStats[]> {
      const result = await db.execute<Record<string, unknown>>(sql`
        select
          coalesce(provider, 'unrouted')             as provider,
          count(*)                                   as requests,
          count(*) filter (where status = 'success') as successes,
          avg(latency_ms)                            as avg_latency,
          coalesce(sum(total_tokens), 0)             as total_tokens,
          coalesce(sum(estimated_cost_usd), 0)       as cost
        from requests
        where created_at >= ${since(window)}
        group by 1
        order by 2 desc
      `);

      return result.rows.map((row) => ({
        provider: String(row["provider"]),
        requests: toNumber(row["requests"]),
        successfulRequests: toNumber(row["successes"]),
        averageLatencyMs: toNullableNumber(row["avg_latency"]),
        totalTokens: toNumber(row["total_tokens"]),
        estimatedCostUsd: toNumber(row["cost"]),
      }));
    },

    async recent({ window, limit }): Promise<readonly RequestListItem[]> {
      const rows = await db
        .select()
        .from(requests)
        .where(gte(requests.createdAt, sql`now() - ${sql.raw(`interval '${WINDOW_INTERVALS[window]}'`)}`))
        .orderBy(desc(requests.createdAt))
        .limit(limit);

      return rows.map(toListItem);
    },

    async find(id): Promise<RequestDetail | undefined> {
      const rows = await db
        .select()
        .from(requests)
        // Operators quote the `req_…` from a client error report; the UUID is
        // what a link carries. Accept both rather than making anyone care.
        .where(id.startsWith("req_") ? eq(requests.requestId, id) : eq(requests.id, id))
        .limit(1);

      const row = rows[0];
      return row === undefined ? undefined : toDetail(row);
    },

    async byTrace(traceId): Promise<readonly RequestListItem[]> {
      const rows = await db
        .select()
        .from(requests)
        .where(eq(requests.traceId, traceId))
        .orderBy(desc(requests.createdAt))
        .limit(100);

      return rows.map(toListItem);
    },
  };
}

function toListItem(row: RequestRow): RequestListItem {
  return {
    id: row.id,
    requestId: row.requestId,
    traceId: row.traceId,
    createdAt: row.createdAt,
    provider: row.provider,
    model: row.model,
    requestedModel: row.requestedModel,
    status: row.status,
    errorCode: row.errorCode,
    httpStatus: row.httpStatus,
    latencyMs: row.latencyMs,
    totalTokens: row.totalTokens,
    // Null stays null all the way to the UI, which renders it as "—" rather
    // than "$0.00" — the distinction the whole cost path preserves.
    estimatedCostUsd: toNullableNumber(row.estimatedCostUsd),
    cached: row.cached,
    streamed: row.streamed,
  };
}

function toDetail(row: RequestRow): RequestDetail {
  return {
    ...toListItem(row),
    route: row.route,
    apiKeyId: row.apiKeyId,
    providerCalls: row.providerCalls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}
