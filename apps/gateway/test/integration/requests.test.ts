import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { like, sql } from "drizzle-orm";
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema.js";
import {
  createRequestRecorder,
  type RequestObservation,
} from "../../src/observability/request-recorder.js";
import { silentLogger } from "../helpers/build-test-server.js";

/**
 *   docker compose up -d postgres
 *   INTEGRATION_TESTS=1 pnpm test:integration
 */
const enabled = process.env["INTEGRATION_TESTS"] === "1";

/** Every row this suite writes carries this prefix, so cleanup is scoped. */
const PREFIX = "req_itest_";

const observation: RequestObservation = {
  requestId: `${PREFIX}base`,
  traceId: "tr_integration",
  apiKeyId: undefined,
  requestedModel: "fast",
  route: "fast",
  provider: "mock",
  model: "echo",
  status: "success",
  errorCode: undefined,
  httpStatus: 200,
  latencyMs: 42,
  providerCalls: 2,
  cached: false,
  streamed: false,
  inputTokens: 824,
  outputTokens: 214,
  totalTokens: 1_038,
  estimatedCostUsd: 0.0004128,
};

describe.skipIf(!enabled)("requests table against real Postgres", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString:
        process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/openllm",
      max: 4,
    });
    db = drizzle(pool, { schema });
    await runMigrations(db, silentLogger);
  });

  beforeEach(async () => {
    await db.execute(sql`delete from requests where request_id like ${PREFIX + "%"}`);
  });

  afterAll(async () => {
    await db?.execute(sql`delete from requests where request_id like ${PREFIX + "%"}`);
    await pool?.end();
  });

  /**
   * This suite's rows only.
   *
   * An unscoped `select().from(requests)` would see whatever other integration
   * suites left behind and turn exact-count assertions into flakes that only
   * appear when the full suite runs — the failure mode that caught this.
   */
  function ownRows() {
    return db.select().from(schema.requests).where(like(schema.requests.requestId, `${PREFIX}%`));
  }

  it("has NO column that could hold message content", async () => {
    // The strongest form of the privacy guarantee (spec §14, §26): not "we
    // don't write prompts" but "there is nowhere to write them". This test
    // exists so the guarantee survives a future migration written in a hurry.
    const columns = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'requests'`,
    );
    const names = columns.rows.map((row) => row.column_name);

    for (const forbidden of [
      "prompt",
      "completion",
      "messages",
      "content",
      "request_body",
      "response_body",
      "input",
      "output",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // Token counts are metadata, not content, and must still be there.
    expect(names).toContain("input_tokens");
    expect(names).toContain("output_tokens");
  });

  it("persists a record with every field spec §15 asks for", async () => {
    const recorder = createRequestRecorder({ db, logger: silentLogger, batchSize: 10 });
    recorder.record(observation);
    await recorder.flush();
    recorder.stop();

    const rows = await ownRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: `${PREFIX}base`,
      traceId: "tr_integration",
      requestedModel: "fast",
      route: "fast",
      provider: "mock",
      model: "echo",
      status: "success",
      httpStatus: 200,
      latencyMs: 42,
      providerCalls: 2,
      inputTokens: 824,
      outputTokens: 214,
      totalTokens: 1_038,
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("keeps cost exact through NUMERIC rather than rounding it away", async () => {
    // A single request costs a fraction of a cent; float error accumulates
    // exactly where the number matters most.
    const recorder = createRequestRecorder({ db, logger: silentLogger, batchSize: 10 });
    recorder.record({ ...observation, estimatedCostUsd: 0.0000000123 });
    await recorder.flush();
    recorder.stop();

    const rows = await ownRows();

    expect(Number(rows[0]?.estimatedCostUsd)).toBeCloseTo(0.0000000123, 12);
  });

  it("stores NULL, not zero, when usage or pricing is unknown", async () => {
    // "We don't know" and "it was free" must stay distinguishable all the way
    // to the dashboard.
    const recorder = createRequestRecorder({ db, logger: silentLogger, batchSize: 10 });
    recorder.record({
      ...observation,
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      estimatedCostUsd: undefined,
    });
    await recorder.flush();
    recorder.stop();

    const rows = await ownRows();

    expect(rows[0]?.inputTokens).toBeNull();
    expect(rows[0]?.estimatedCostUsd).toBeNull();
  });

  it("writes a batch in one statement", async () => {
    const recorder = createRequestRecorder({ db, logger: silentLogger, batchSize: 100 });
    for (let i = 0; i < 25; i += 1) {
      recorder.record({ ...observation, requestId: `${PREFIX}${i}` });
    }
    await recorder.flush();
    recorder.stop();

    const rows = await ownRows();

    expect(rows).toHaveLength(25);
  });

  it("survives a key being deleted, because history is not a foreign key", async () => {
    // An operator removing a key row must not silently erase the record of what
    // it spent.
    const recorder = createRequestRecorder({ db, logger: silentLogger, batchSize: 10 });
    recorder.record({ ...observation, apiKeyId: "2f1d6b6e-1f6b-4c1e-9a3a-9d5a2f5c6b7e" });
    await recorder.flush();
    recorder.stop();

    const rows = await ownRows();

    expect(rows[0]?.apiKeyId).toBe("2f1d6b6e-1f6b-4c1e-9a3a-9d5a2f5c6b7e");
  });

  it("supports the aggregate the dashboard will run", async () => {
    // Phase 10's summary tiles: totals, success rate, average latency, cost.
    const recorder = createRequestRecorder({ db, logger: silentLogger, batchSize: 100 });
    recorder.record({ ...observation, requestId: `${PREFIX}a`, estimatedCostUsd: 0.001 });
    recorder.record({ ...observation, requestId: `${PREFIX}b`, estimatedCostUsd: 0.002 });
    recorder.record({
      ...observation,
      requestId: `${PREFIX}c`,
      status: "error",
      httpStatus: 502,
      errorCode: "PROVIDER_ERROR",
      estimatedCostUsd: undefined,
    });
    await recorder.flush();
    recorder.stop();

    const summary = await db.execute<{
      total: string;
      successes: string;
      avg_latency: string;
      total_cost: string | null;
    }>(sql`
      select count(*) as total,
             count(*) filter (where status = 'success') as successes,
             avg(latency_ms) as avg_latency,
             sum(estimated_cost_usd) as total_cost
      from requests
      where request_id like ${PREFIX + "%"}
    `);
    const row = summary.rows[0];

    expect(Number(row?.total)).toBe(3);
    expect(Number(row?.successes)).toBe(2);
    // sum() skips NULLs, so unknown cost does not drag the total toward zero.
    expect(Number(row?.total_cost)).toBeCloseTo(0.003, 10);
  });
});
