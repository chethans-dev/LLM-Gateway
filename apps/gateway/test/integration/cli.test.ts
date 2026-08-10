import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { hashApiKey } from "../../src/auth/api-key.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema.js";
import { silentLogger } from "../helpers/build-test-server.js";

/**
 * The key-creation CLI, run as a real process.
 *
 * This is the bootstrap path: `/v1/admin/keys` needs `ADMIN_API_KEY`, and an
 * operator who has not set one still needs a first key. It is also the only part
 * of the system with no in-process entry point, so the only honest way to test
 * it is to spawn it and read its output — which is what an operator does.
 *
 *   docker compose up -d postgres
 *   INTEGRATION_TESTS=1 pnpm test:integration
 */
const enabled = process.env["INTEGRATION_TESTS"] === "1";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../../src/cli/create-key.ts", import.meta.url));
const CWD = fileURLToPath(new URL("../../", import.meta.url));
const PREFIX = "itest-cli-";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/openllm";

describe.skipIf(!enabled)("key-creation CLI", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    db = drizzle(pool, { schema });
    await runMigrations(db, silentLogger);
    await db.execute(sql`delete from api_keys where name like ${PREFIX + "%"}`);
  });

  afterAll(async () => {
    await db?.execute(sql`delete from api_keys where name like ${PREFIX + "%"}`);
    await pool?.end();
  });

  function invoke(args: string[], env: Record<string, string> = {}) {
    return run("node", ["--import", "tsx", CLI, ...args], {
      cwd: CWD,
      env: {
        ...process.env,
        DATABASE_URL,
        REDIS_URL: process.env["REDIS_URL"] ?? "redis://localhost:6379",
        ...env,
      },
    });
  }

  it("prints ONLY the key on stdout, so it can be captured", async () => {
    // The documented usage is KEY=$(pnpm -s key:create ci). Anything else on
    // stdout would end up inside the variable.
    const { stdout, stderr } = await invoke([`${PREFIX}capture`]);

    expect(stdout.trim()).toMatch(/^olgm_live_[A-Za-z0-9_-]{43}$/);
    // Everything human-facing goes to stderr.
    expect(stderr).toContain("only time it will be shown");
  });

  it("stores only the hash, never the key", async () => {
    const { stdout } = await invoke([`${PREFIX}hash-check`]);
    const key = stdout.trim();

    const rows = await db.execute<{ key_hash: string; name: string }>(
      sql`select key_hash, name from api_keys where name = ${`${PREFIX}hash-check`}`,
    );

    expect(rows.rows[0]?.key_hash).toBe(hashApiKey(key));
    // The raw value appears nowhere in the row.
    expect(JSON.stringify(rows.rows[0])).not.toContain(key);
  });

  it("creates a key that actually authenticates", async () => {
    // The bootstrap loop closed: CLI output → working credential.
    const { stdout } = await invoke([`${PREFIX}usable`]);

    const rows = await db.execute<{ status: string }>(
      sql`select status from api_keys where key_hash = ${hashApiKey(stdout.trim())}`,
    );

    expect(rows.rows[0]?.status).toBe("active");
  });

  it("exits non-zero with usage when given no name", async () => {
    await expect(invoke([])).rejects.toMatchObject({ code: 2 });
  });

  it("fails clearly on bad configuration rather than a stack trace", async () => {
    // An operator who mistypes DATABASE_URL should get the config error, not a
    // Postgres driver exception.
    let failure: { code: number; stderr: string } | undefined;
    try {
      await invoke([`${PREFIX}bad-config`], { DATABASE_URL: "" });
    } catch (error) {
      failure = error as { code: number; stderr: string };
    }

    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain("DATABASE_URL");
  });
});
