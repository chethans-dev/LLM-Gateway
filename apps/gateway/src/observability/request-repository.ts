import { and, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";
import { LLMError } from "@openllm/core";
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

/**
 * Bucket width per window, chosen so every window yields 30–60 points.
 *
 * Enough resolution to see a spike, few enough that each bar stays wide enough
 * to hit with a mouse. Fixed per window rather than derived from the data, so
 * the same window always looks the same and two screenshots are comparable.
 */
const WINDOW_BUCKETS: Record<StatsWindow, { readonly interval: string; readonly seconds: number }> =
  {
    "1h": { interval: "1 minute", seconds: 60 },
    "24h": { interval: "30 minutes", seconds: 1_800 },
    "7d": { interval: "4 hours", seconds: 14_400 },
    "30d": { interval: "1 day", seconds: 86_400 },
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

/** One point on the traffic chart. */
export interface TimeBucket {
  readonly bucketStart: Date;
  readonly total: number;
  readonly errors: number;
}

export interface TimeSeries {
  /** Bucket width, so the client can size bars without re-deriving it. */
  readonly bucketSeconds: number;
  readonly buckets: readonly TimeBucket[];
}

/**
 * The values a dashboard filter can offer.
 *
 * Derived from the traffic in the window rather than from configuration: the
 * useful question is "which providers actually served anything", and a dropdown
 * listing configured-but-idle providers only produces empty result sets.
 */
export interface RequestFacets {
  readonly providers: readonly string[];
  readonly models: readonly string[];
}

export interface RequestFilters {
  readonly status?: "success" | "error";
  /** `unrouted` selects rows that never reached a provider. */
  readonly provider?: string;
  readonly model?: string;
}

export interface RequestPage {
  readonly items: readonly RequestListItem[];
  /** Opaque; pass back as `cursor` for the next page. Null at the end. */
  readonly nextCursor: string | null;
}

export interface RequestRepository {
  summary(window: StatsWindow): Promise<StatsSummary>;
  byProvider(window: StatsWindow): Promise<readonly ProviderStats[]>;
  /** Bucketed request and error counts, for the traffic chart. */
  timeseries(window: StatsWindow): Promise<TimeSeries>;
  /** Distinct providers and models seen in the window, for filter controls. */
  facets(window: StatsWindow): Promise<RequestFacets>;
  recent(options: {
    window: StatsWindow;
    limit: number;
    filters?: RequestFilters;
    cursor?: string | null;
  }): Promise<RequestPage>;
  /** Accepts the database id or the `req_…` request id. */
  find(id: string): Promise<RequestDetail | undefined>;
  /** Every request sharing a trace, for following one logical operation. */
  byTrace(traceId: string): Promise<readonly RequestListItem[]>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keyset pagination, not OFFSET.
 *
 * This list is sorted newest-first over a table that is being appended to while
 * somebody reads it. With OFFSET, a row inserted between page 1 and page 2
 * pushes everything down and page 2 repeats a row page 1 already showed. A
 * cursor naming the last row seen is immune to that, and it stays on the
 * `(created_at desc)` index instead of counting past N rows to discard them.
 */
export function encodeCursor(item: { createdAt: Date; id: string }): string {
  return `${item.createdAt.toISOString()}|${item.id}`;
}

export function parseCursor(cursor: string): { createdAt: Date; id: string } {
  const separator = cursor.indexOf("|");
  const timePart = separator === -1 ? "" : cursor.slice(0, separator);
  const id = separator === -1 ? "" : cursor.slice(separator + 1);
  const createdAt = new Date(timePart);

  // Rejected loudly rather than ignored. A cursor silently treated as "start
  // from the top" makes a paging bug look like duplicated data, which is a much
  // harder thing to diagnose than a 400.
  if (timePart === "" || Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw LLMError.invalidRequest("Malformed cursor");
  }

  return { createdAt, id };
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

    async timeseries(window): Promise<TimeSeries> {
      const bucket = WINDOW_BUCKETS[window];
      const width = sql.raw(`interval '${bucket.interval}'`);

      // Two steps on purpose. Aggregating first is one index range scan over the
      // window; generating the bucket spine separately and LEFT JOINing onto it
      // is what makes an idle period render as a run of zeros instead of
      // vanishing. A chart that silently omits empty buckets draws an outage as
      // a narrower-but-healthy chart, which is precisely backwards.
      const result = await db.execute<Record<string, unknown>>(sql`
        with counts as (
          select
            date_bin(${width}, created_at, timestamptz 'epoch') as bucket_start,
            count(*)                                   as total,
            count(*) filter (where status = 'error')   as errors
          from requests
          where created_at >= ${since(window)}
          group by 1
        ),
        spine as (
          select generate_series(
            date_bin(${width}, now() - ${sql.raw(`interval '${WINDOW_INTERVALS[window]}'`)}, timestamptz 'epoch'),
            date_bin(${width}, now(), timestamptz 'epoch'),
            ${width}
          ) as bucket_start
        )
        select
          spine.bucket_start,
          coalesce(counts.total, 0)  as total,
          coalesce(counts.errors, 0) as errors
        from spine
        left join counts using (bucket_start)
        order by spine.bucket_start
      `);

      return {
        bucketSeconds: bucket.seconds,
        buckets: result.rows.map((row) => ({
          bucketStart: new Date(String(row["bucket_start"])),
          total: toNumber(row["total"]),
          errors: toNumber(row["errors"]),
        })),
      };
    },

    async facets(window): Promise<RequestFacets> {
      // One scan for both lists. `coalesce(model, requested_model)` mirrors what
      // the table's Model column displays, so every option in the dropdown
      // matches text a reader can actually see in a row.
      const result = await db.execute<Record<string, unknown>>(sql`
        select
          array_agg(distinct coalesce(provider, 'unrouted'))       as providers,
          array_agg(distinct coalesce(model, requested_model))     as models
        from requests
        where created_at >= ${since(window)}
      `);

      const row = result.rows[0] ?? {};
      const toList = (value: unknown): readonly string[] =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string").sort()
          : [];

      return { providers: toList(row["providers"]), models: toList(row["models"]) };
    },

    async recent({ window, limit, filters = {}, cursor = null }): Promise<RequestPage> {
      const conditions: SQL[] = [
        gte(requests.createdAt, sql`now() - ${sql.raw(`interval '${WINDOW_INTERVALS[window]}'`)}`),
      ];

      if (filters.status !== undefined) {
        conditions.push(eq(requests.status, filters.status));
      }
      if (filters.provider !== undefined) {
        // Matches the `unrouted` bucket the provider breakdown reports: those
        // are the requests that failed before a provider was chosen, and being
        // able to list them is most of the point of the filter.
        conditions.push(
          filters.provider === "unrouted"
            ? isNull(requests.provider)
            : eq(requests.provider, filters.provider),
        );
      }
      if (filters.model !== undefined) {
        conditions.push(
          sql`coalesce(${requests.model}, ${requests.requestedModel}) = ${filters.model}`,
        );
      }
      if (cursor !== null) {
        const position = parseCursor(cursor);
        // Row comparison, so the tiebreak on id is part of the same index-ordered
        // predicate. Two requests can share a timestamp; without the tiebreak one
        // of them is dropped at every page boundary.
        conditions.push(
          sql`(${requests.createdAt}, ${requests.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
        );
      }

      // One extra row is the cheapest way to know whether a next page exists
      // without a second COUNT query over the same predicate.
      const rows = await db
        .select()
        .from(requests)
        .where(and(...conditions))
        .orderBy(desc(requests.createdAt), desc(requests.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = (hasMore ? rows.slice(0, limit) : rows).map(toListItem);
      const last = page[page.length - 1];

      return {
        items: page,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      };
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
