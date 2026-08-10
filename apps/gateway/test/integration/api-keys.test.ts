import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import {
  createApiKeyRepository,
  type ApiKeyRepository,
} from "../../src/auth/api-key-repository.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema.js";
import { silentLogger } from "../helpers/build-test-server.js";

/**
 * The api_keys table against real Postgres.
 *
 *   docker compose up -d postgres
 *   INTEGRATION_TESTS=1 pnpm test:integration
 */
const enabled = process.env["INTEGRATION_TESTS"] === "1";

/** Every key this suite creates is named with this prefix, so cleanup is scoped. */
const PREFIX = "itest-apikeys-";

describe.skipIf(!enabled)("api_keys against real Postgres", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: ApiKeyRepository;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString:
        process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/openllm",
      max: 4,
    });
    db = drizzle(pool, { schema });

    // Proves the migration actually applies, not just that the schema compiles.
    await runMigrations(db, silentLogger);
    // Scoped to this suite's own rows. A blanket `delete from api_keys` makes
    // integration suites stomp on each other — and would destroy real keys if
    // DATABASE_URL ever pointed somewhere that mattered.
    await db.execute(sql`delete from api_keys where name like ${PREFIX + "%"}`);

    repository = createApiKeyRepository({ db, logger: silentLogger });
  });

  afterAll(async () => {
    await db?.execute(sql`delete from api_keys where name like ${PREFIX + "%"}`);
    await pool?.end();
  });

  it("is idempotent to migrate twice", async () => {
    // Every boot runs migrations; the second one must find nothing to do.
    await expect(runMigrations(db, silentLogger)).resolves.toBeUndefined();
  });

  it("creates a key and finds it by value", async () => {
    const created = await repository.create(`${PREFIX}integration-test`);

    const identity = await repository.findActiveByKey(created.key);

    expect(identity).toMatchObject({ id: created.id, name: `${PREFIX}integration-test` });
  });

  it("NEVER stores the raw key", async () => {
    // The whole point of the table's shape: a database dump must not let anyone
    // call the gateway.
    const created = await repository.create(`${PREFIX}secret-check`);

    const rows = await db.execute<{ key_hash: string; key_prefix: string }>(
      sql`select key_hash, key_prefix from api_keys where id = ${created.id}`,
    );
    const row = rows.rows[0];

    expect(row).toBeDefined();
    expect(row?.key_hash).toBe(hashApiKey(created.key));
    expect(row?.key_hash).not.toContain(created.key);
    // The stored prefix is too short to reconstruct anything from.
    expect(created.key.startsWith(row!.key_prefix)).toBe(true);
    expect(row!.key_prefix.length).toBeLessThan(created.key.length / 2);

    // And no column anywhere holds the full value.
    const all = await db.execute<{ found: string }>(
      sql`select id::text as found from api_keys where key_hash = ${created.key}`,
    );
    expect(all.rows).toHaveLength(0);
  });

  it("does not find an unknown key", async () => {
    expect(await repository.findActiveByKey(generateApiKey().key)).toBeUndefined();
  });

  it("stops finding a key once revoked", async () => {
    const created = await repository.create(`${PREFIX}to-revoke`);

    expect(await repository.revoke(created.id)).toBe(true);

    expect(await repository.findActiveByKey(created.key)).toBeUndefined();
  });

  it("keeps the revoked row rather than deleting it", async () => {
    // Phase 9's request history references these rows: "who made this call"
    // must survive the key being turned off.
    const created = await repository.create(`${PREFIX}kept-after-revoke`);
    await repository.revoke(created.id);

    const listed = await repository.list();
    const found = listed.find((key) => key.id === created.id);

    expect(found?.status).toBe("revoked");
    expect(found?.revokedAt).toBeInstanceOf(Date);
  });

  it("reports revoking twice as a no-op", async () => {
    const created = await repository.create(`${PREFIX}double-revoke`);
    await repository.revoke(created.id);

    expect(await repository.revoke(created.id)).toBe(false);
  });

  it("rejects a duplicate hash at the database level", async () => {
    // The unique constraint is the real guarantee; application code could have
    // a race that this catches.
    const generated = generateApiKey();
    await db.insert(schema.apiKeys).values({
      name: `${PREFIX}first`,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
    });

    await expect(
      db.insert(schema.apiKeys).values({
        name: `${PREFIX}second`,
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
      }),
    ).rejects.toThrow();
  });

  it("records last-used at most once per interval", async () => {
    let clock = 1_000_000;
    const throttled = createApiKeyRepository({
      db,
      logger: silentLogger,
      now: () => clock,
    });
    const created = await throttled.create(`${PREFIX}touch-test`);

    throttled.touch(created.id);
    await waitForWrites();

    const first = await lastUsedAt(created.id);
    expect(first).not.toBeNull();

    // Immediately again — must be skipped, or auth becomes a write on every
    // request on the hottest path in the system.
    clock += 1_000;
    throttled.touch(created.id);
    await waitForWrites();
    expect(await lastUsedAt(created.id)).toEqual(first);

    // Past the interval — now it writes.
    clock += 120_000;
    throttled.touch(created.id);
    await waitForWrites();
    expect(await lastUsedAt(created.id)).not.toEqual(first);
  });

  async function lastUsedAt(id: string): Promise<Date | null> {
    const rows = await db.execute<{ last_used_at: Date | null }>(
      sql`select last_used_at from api_keys where id = ${id}`,
    );
    return rows.rows[0]?.last_used_at ?? null;
  }

  /** touch() is fire-and-forget by design, so give the write a moment to land. */
  function waitForWrites(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 150));
  }
});
