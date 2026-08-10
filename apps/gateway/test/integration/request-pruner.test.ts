import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema.js";
import { createRequestPruner } from "../../src/observability/request-pruner.js";
import { silentLogger } from "../helpers/build-test-server.js";

/**
 * Retention against real Postgres.
 *
 * The unit tests cover the loop; these cover the parts only a real database can
 * show — that the SQL is valid, that the advisory lock genuinely excludes a
 * second instance, and that rows inside the window survive.
 *
 *   docker compose up -d postgres
 *   INTEGRATION_TESTS=1 pnpm test:integration
 */
const enabled = process.env["INTEGRATION_TESTS"] === "1";

const PREFIX = "req_prune_";

describe.skipIf(!enabled)("request pruning against real Postgres", () => {
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

  /** Insert a row with an explicit age, since created_at defaults to now(). */
  async function insertAged(id: string, daysOld: number): Promise<void> {
    await db.execute(sql`
      insert into requests
        (request_id, trace_id, requested_model, status, http_status, latency_ms, created_at)
      values
        (${PREFIX + id}, ${"tr_" + id}, 'mock', 'success', 200, 10,
         now() - (${daysOld} * interval '1 day'))
    `);
  }

  async function remaining(): Promise<string[]> {
    const rows = await db.execute<{ request_id: string }>(
      sql`select request_id from requests where request_id like ${PREFIX + "%"} order by request_id`,
    );
    return rows.rows.map((row) => row.request_id);
  }

  function pruner(retentionDays: number, batchSize = 2) {
    return createRequestPruner({
      db,
      logger: silentLogger,
      retentionDays,
      batchSize,
      sleep: async () => {},
    });
  }

  it("deletes rows older than the window and keeps the rest", async () => {
    await insertAged("ancient", 120);
    await insertAged("old", 100);
    await insertAged("recent", 10);
    await insertAged("today", 0);

    const deleted = await pruner(90).prune();

    expect(deleted).toBe(2);
    expect(await remaining()).toEqual([`${PREFIX}recent`, `${PREFIX}today`]);
  });

  it("keeps a row sitting exactly inside the boundary", async () => {
    // Off-by-one here silently deletes a day of history every run.
    await insertAged("just-inside", 89);
    await insertAged("just-outside", 91);

    await pruner(90).prune();

    expect(await remaining()).toEqual([`${PREFIX}just-inside`]);
  });

  it("works across several batches", async () => {
    for (let i = 0; i < 7; i += 1) await insertAged(`bulk-${i}`, 200);

    const deleted = await pruner(90, 2).prune();

    expect(deleted).toBe(7);
    expect(await remaining()).toEqual([]);
  });

  it("is a no-op when nothing is old enough", async () => {
    await insertAged("fresh", 1);

    expect(await pruner(90).prune()).toBe(0);
    expect(await remaining()).toEqual([`${PREFIX}fresh`]);
  });

  it("lets only ONE instance prune at a time", async () => {
    // The real concurrency guarantee: two gateway replicas, one Postgres. A
    // second instance must skip rather than delete the same rows in parallel.
    for (let i = 0; i < 6; i += 1) await insertAged(`race-${i}`, 200);

    // Separate pools, so each holds its own session and the advisory lock is a
    // genuine exclusion rather than the same connection re-entering.
    const otherPool = new pg.Pool({ connectionString: pool.options.connectionString, max: 2 });
    const otherDb = drizzle(otherPool, { schema });

    try {
      const slow = createRequestPruner({
        db,
        logger: silentLogger,
        retentionDays: 90,
        batchSize: 1,
        // Slow enough that the second pruner definitely overlaps it.
        sleep: async () => new Promise((resolve) => setTimeout(resolve, 60)),
      });
      const fast = createRequestPruner({
        db: otherDb,
        logger: silentLogger,
        retentionDays: 90,
        batchSize: 1,
        sleep: async () => {},
      });

      const [slowDeleted, fastDeleted] = await Promise.all([
        slow.prune(),
        // Give the first one time to take the lock.
        new Promise<number>((resolve) => setTimeout(() => void fast.prune().then(resolve), 20)),
      ]);

      // One did all the work; the other skipped entirely.
      expect(fastDeleted).toBe(0);
      expect(slowDeleted).toBe(6);
      expect(await remaining()).toEqual([]);
    } finally {
      await otherPool.end();
    }
  });

  it("releases the lock so the next run can proceed", async () => {
    await insertAged("first", 200);
    await pruner(90).prune();

    await insertAged("second", 200);

    // A leaked lock would make this silently delete nothing.
    expect(await pruner(90).prune()).toBe(1);
  });

  it("touches only the requests table", async () => {
    // Retention is about request history. API keys are few, and revoked ones
    // are an audit trail that must survive.
    const before = await db.execute<{ count: string }>(sql`select count(*) from api_keys`);
    await insertAged("scoped", 200);

    await pruner(90).prune();

    const after = await db.execute<{ count: string }>(sql`select count(*) from api_keys`);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
