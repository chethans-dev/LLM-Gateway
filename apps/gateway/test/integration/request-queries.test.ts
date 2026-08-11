import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { LLMError } from "@openllm/core";
import { runMigrations } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema.js";
import {
  createRequestRepository,
  type RequestRepository,
} from "../../src/observability/request-repository.js";
import { silentLogger } from "../helpers/build-test-server.js";

/**
 * The dashboard's read queries against real Postgres.
 *
 * The unit tests run against a fake database, which proves the plumbing and
 * nothing about the SQL. `date_bin`, `generate_series`, `array_agg … filter` and
 * row-constructor comparison either exist and behave or they do not, and the
 * only place that question gets answered is here.
 *
 *   docker compose up -d postgres
 *   INTEGRATION_TESTS=1 pnpm test:integration
 */
const enabled = process.env["INTEGRATION_TESTS"] === "1";

/** Scopes every row and every assertion to this suite. */
const PREFIX = "req_query_";
const MODEL = "itest-query-model";
const PROVIDER = "itest-query-provider";

describe.skipIf(!enabled)("dashboard queries against real Postgres", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: RequestRepository;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString:
        process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/openllm",
      max: 4,
    });
    db = drizzle(pool, { schema });
    await runMigrations(db, silentLogger);
    repository = createRequestRepository(db);
  });

  beforeEach(async () => {
    await db.execute(sql`delete from requests where request_id like ${PREFIX + "%"}`);
  });

  afterAll(async () => {
    await db?.execute(sql`delete from requests where request_id like ${PREFIX + "%"}`);
    await pool?.end();
  });

  async function insert(options: {
    id: string;
    minutesAgo?: number;
    status?: "success" | "error";
    provider?: string | null;
    model?: string | null;
    requestedModel?: string;
    createdAt?: string;
  }): Promise<void> {
    const minutesAgo = options.minutesAgo ?? 1;
    await db.execute(sql`
      insert into requests
        (request_id, trace_id, requested_model, model, provider, status, http_status,
         latency_ms, created_at)
      values
        (${PREFIX + options.id},
         ${"tr_" + options.id},
         ${options.requestedModel ?? MODEL},
         ${options.model === undefined ? MODEL : options.model},
         ${options.provider === undefined ? PROVIDER : options.provider},
         ${options.status ?? "success"},
         ${options.status === "error" ? 502 : 200},
         10,
         ${
           options.createdAt !== undefined
             ? sql`${options.createdAt}::timestamptz`
             : sql`now() - (${minutesAgo} * interval '1 minute')`
         })
    `);
  }

  /** Only this suite's rows, so other suites cannot make counts flaky. */
  const mine = () => repository.recent({ window: "24h", limit: 100, filters: { model: MODEL } });

  describe("timeseries", () => {
    it("returns a contiguous spine at the documented bucket width", async () => {
      const series = await repository.timeseries("24h");

      expect(series.bucketSeconds).toBe(1_800);
      expect(series.buckets.length).toBeGreaterThan(40);

      for (let i = 1; i < series.buckets.length; i += 1) {
        const gap =
          series.buckets[i]!.bucketStart.getTime() - series.buckets[i - 1]!.bucketStart.getTime();
        expect(gap).toBe(1_800_000);
      }
    });

    it("uses a different bucket width per window", async () => {
      // If these ever collapse to one value the chart silently changes meaning.
      expect((await repository.timeseries("1h")).bucketSeconds).toBe(60);
      expect((await repository.timeseries("7d")).bucketSeconds).toBe(14_400);
      expect((await repository.timeseries("30d")).bucketSeconds).toBe(86_400);
    });

    it("emits zero-count buckets rather than omitting them", async () => {
      // The reason the spine exists. A 30-day window on a gateway that ran for
      // an afternoon must still be 30 buckets wide.
      const series = await repository.timeseries("30d");

      expect(series.buckets.length).toBeGreaterThanOrEqual(30);
      expect(series.buckets.some((bucket) => bucket.total === 0)).toBe(true);
    });

    it("counts rows into the bucket that contains their timestamp", async () => {
      // Measured as a DELTA on one identified bucket.
      //
      // The tempting version of this test plants rows at a quiet past timestamp
      // and asserts an absolute count. That assumption does not survive: "45
      // minutes ago" is a moving target, and on any database with history it
      // eventually lands on a minute when something real was happening. Nothing
      // about this table is exclusively ours, so nothing absolute is assertable.
      const at = new Date(Date.now() - 45 * 60_000);
      at.setSeconds(20, 0);

      const holding = (series: Awaited<ReturnType<RequestRepository["timeseries"]>>) =>
        series.buckets.find(
          (bucket) =>
            bucket.bucketStart.getTime() <= at.getTime() &&
            at.getTime() < bucket.bucketStart.getTime() + series.bucketSeconds * 1_000,
        );

      const before = holding(await repository.timeseries("1h"));

      await insert({ id: "ts-ok-1", createdAt: at.toISOString() });
      await insert({ id: "ts-ok-2", createdAt: at.toISOString() });
      await insert({ id: "ts-err", createdAt: at.toISOString(), status: "error" });

      const after = holding(await repository.timeseries("1h"));

      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(after?.total).toBe((before?.total ?? 0) + 3);
      expect(after?.errors).toBe((before?.errors ?? 0) + 1);
    });

    it("puts a row in the bucket it belongs to, not a neighbouring one", async () => {
      // An origin mistake in `date_bin` shifts every point by a partial bucket,
      // which moves an incident on the chart away from when it happened.
      const at = new Date(Date.now() - 40 * 60_000);
      at.setSeconds(5, 0);

      // Measured as a delta on one identified bucket rather than by hunting for
      // a bucket with particular counts: this table is shared, and anything that
      // reads whole-table totals is a test that fails the moment something else
      // writes a row.
      const holding = (series: Awaited<ReturnType<RequestRepository["timeseries"]>>) =>
        series.buckets.find(
          (bucket) =>
            bucket.bucketStart.getTime() <= at.getTime() &&
            at.getTime() < bucket.bucketStart.getTime() + series.bucketSeconds * 1_000,
        );

      const before = holding(await repository.timeseries("1h"));
      await insert({ id: "ts-placement", createdAt: at.toISOString() });
      const after = holding(await repository.timeseries("1h"));

      expect(before).toBeDefined();
      expect(after).toBeDefined();
      // The row landed in THIS bucket, not the one on either side.
      expect(after?.total).toBe((before?.total ?? 0) + 1);
      // And buckets are minute-aligned: the row sits 5 seconds into one.
      expect(at.getTime() - (after?.bucketStart.getTime() ?? 0)).toBe(5_000);
    });

    it("counts errors as a subset of the total, never alongside it", async () => {
      // The chart derives successes as total − errors. If errors were counted
      // separately, an all-error bucket would render as half its real height.
      await insert({ id: "ts-subset", minutesAgo: 3, status: "error" });

      const series = await repository.timeseries("1h");

      for (const bucket of series.buckets) {
        expect(bucket.errors).toBeLessThanOrEqual(bucket.total);
      }
    });

    it("orders buckets oldest first", async () => {
      const series = await repository.timeseries("7d");
      const times = series.buckets.map((bucket) => bucket.bucketStart.getTime());

      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });
  });

  describe("facets", () => {
    it("lists a provider and model that served traffic", async () => {
      await insert({ id: "facet-1" });

      const facets = await repository.facets("24h");

      expect(facets.providers).toContain(PROVIDER);
      expect(facets.models).toContain(MODEL);
    });

    it("reports provider-less rows as 'unrouted'", async () => {
      // Requests that failed before routing. They are the most interesting rows
      // on the page, so they must be reachable from the filter.
      await insert({ id: "facet-unrouted", provider: null, model: null, requestedModel: MODEL });

      expect((await repository.facets("24h")).providers).toContain("unrouted");
    });

    it("falls back to the requested model when no model was resolved", async () => {
      // Matches what the table's Model column displays, so every dropdown option
      // is text a reader can actually find in a row.
      await insert({
        id: "facet-requested",
        model: null,
        requestedModel: "itest-alias-only",
        provider: null,
      });

      expect((await repository.facets("24h")).models).toContain("itest-alias-only");
    });

    it("returns empty lists rather than nulls on an empty window", async () => {
      // array_agg over no rows is NULL, not an empty array — a `.map` on that is
      // a crashed dashboard.
      const facets = await repository.facets("1h");

      expect(Array.isArray(facets.providers)).toBe(true);
      expect(Array.isArray(facets.models)).toBe(true);
    });
  });

  describe("filtering", () => {
    beforeEach(async () => {
      await insert({ id: "f-ok-1", minutesAgo: 1 });
      await insert({ id: "f-ok-2", minutesAgo: 2 });
      await insert({ id: "f-err", minutesAgo: 3, status: "error" });
      await insert({ id: "f-other-provider", minutesAgo: 4, provider: "itest-other" });
      await insert({ id: "f-unrouted", minutesAgo: 5, provider: null });
    });

    it("filters by status", async () => {
      const page = await repository.recent({
        window: "24h",
        limit: 50,
        filters: { model: MODEL, status: "error" },
      });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.requestId).toBe(`${PREFIX}f-err`);
    });

    it("filters by provider", async () => {
      const page = await repository.recent({
        window: "24h",
        limit: 50,
        filters: { model: MODEL, provider: "itest-other" },
      });

      expect(page.items.map((item) => item.requestId)).toEqual([`${PREFIX}f-other-provider`]);
    });

    it("selects provider-less rows through the 'unrouted' filter", async () => {
      const page = await repository.recent({
        window: "24h",
        limit: 50,
        filters: { model: MODEL, provider: "unrouted" },
      });

      expect(page.items.map((item) => item.requestId)).toEqual([`${PREFIX}f-unrouted`]);
      expect(page.items[0]?.provider).toBeNull();
    });

    it("combines filters with AND, not OR", async () => {
      const page = await repository.recent({
        window: "24h",
        limit: 50,
        filters: { model: MODEL, provider: PROVIDER, status: "error" },
      });

      expect(page.items.map((item) => item.requestId)).toEqual([`${PREFIX}f-err`]);
    });

    it("returns nothing for a filter that matches nothing", async () => {
      const page = await repository.recent({
        window: "24h",
        limit: 50,
        filters: { model: "no-such-model" },
      });

      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it("treats a filter value containing SQL as a literal", async () => {
      const page = await repository.recent({
        window: "24h",
        limit: 50,
        filters: { model: "' or 1=1 --" },
      });

      expect(page.items).toEqual([]);
    });
  });

  describe("pagination", () => {
    it("walks the whole result set exactly once", async () => {
      for (let i = 0; i < 10; i += 1) {
        await insert({ id: `page-${i}`, minutesAgo: i + 1 });
      }

      const seen: string[] = [];
      let cursor: string | null = null;

      for (let guard = 0; guard < 20; guard += 1) {
        const page: Awaited<ReturnType<RequestRepository["recent"]>> = await repository.recent({
          window: "24h",
          limit: 3,
          filters: { model: MODEL },
          cursor,
        });
        seen.push(...page.items.map((item) => item.requestId));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toHaveLength(10);
      expect(new Set(seen).size).toBe(10);
    });

    it("does not skip rows that share a timestamp", async () => {
      // The reason the cursor carries an id as well as a time. Under batched
      // recording, whole batches land on the same millisecond, and a timestamp
      // -only cursor drops all but one of them at every page boundary.
      const sameTime = new Date(Date.now() - 60_000).toISOString();
      for (let i = 0; i < 6; i += 1) {
        await insert({ id: `tie-${i}`, createdAt: sameTime });
      }

      const seen: string[] = [];
      let cursor: string | null = null;

      for (let guard = 0; guard < 12; guard += 1) {
        const page: Awaited<ReturnType<RequestRepository["recent"]>> = await repository.recent({
          window: "24h",
          limit: 2,
          filters: { model: MODEL },
          cursor,
        });
        seen.push(...page.items.map((item) => item.requestId));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(new Set(seen).size).toBe(6);
    });

    it("reports no cursor when the last page is exactly full", async () => {
      // The off-by-one that shows an empty "Load more" page.
      for (let i = 0; i < 4; i += 1) await insert({ id: `exact-${i}`, minutesAgo: i + 1 });

      const page = await repository.recent({
        window: "24h",
        limit: 4,
        filters: { model: MODEL },
      });

      expect(page.items).toHaveLength(4);
      expect(page.nextCursor).toBeNull();
    });

    it("keeps newest-first order across pages", async () => {
      for (let i = 0; i < 6; i += 1) await insert({ id: `order-${i}`, minutesAgo: i + 1 });

      const first = await repository.recent({
        window: "24h",
        limit: 3,
        filters: { model: MODEL },
      });
      const second = await repository.recent({
        window: "24h",
        limit: 3,
        filters: { model: MODEL },
        cursor: first.nextCursor,
      });

      const times = [...first.items, ...second.items].map((item) => item.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it("carries filters across pages", async () => {
      for (let i = 0; i < 5; i += 1) {
        await insert({ id: `mixed-ok-${i}`, minutesAgo: i + 1 });
        await insert({ id: `mixed-err-${i}`, minutesAgo: i + 1, status: "error" });
      }

      const first = await repository.recent({
        window: "24h",
        limit: 2,
        filters: { model: MODEL, status: "error" },
      });
      const second = await repository.recent({
        window: "24h",
        limit: 2,
        filters: { model: MODEL, status: "error" },
        cursor: first.nextCursor,
      });

      for (const item of [...first.items, ...second.items]) {
        expect(item.status).toBe("error");
      }
    });

    it("rejects a malformed cursor instead of reaching Postgres with it", async () => {
      // The id half is cast to ::uuid. Anything that is not one has to be
      // rejected here, not surfaced as a 500 from a failed cast.
      await expect(
        repository.recent({ window: "24h", limit: 5, cursor: "not-a-cursor" }),
      ).rejects.toThrow(LLMError);
    });

    it("accepts its own cursor format", async () => {
      await insert({ id: "roundtrip-1", minutesAgo: 1 });
      await insert({ id: "roundtrip-2", minutesAgo: 2 });

      const first = await repository.recent({
        window: "24h",
        limit: 1,
        filters: { model: MODEL },
      });

      expect(first.nextCursor).not.toBeNull();
      await expect(
        repository.recent({
          window: "24h",
          limit: 1,
          filters: { model: MODEL },
          cursor: first.nextCursor,
        }),
      ).resolves.toBeDefined();
    });
  });

  it("never selects a column that could hold message content", async () => {
    // Structural: the table has no such column, and this asserts it stays that
    // way as the schema grows.
    await insert({ id: "privacy" });

    const page = await mine();
    const serialized = JSON.stringify(page.items);

    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("prompt");
  });
});
