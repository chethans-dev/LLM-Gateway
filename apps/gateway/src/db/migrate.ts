import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema.js";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Logger } from "../observability/logger.js";

/**
 * Arbitrary but fixed: any concurrent gateway instance must pick the same
 * number for the lock to mean anything.
 */
const MIGRATION_LOCK_ID = 8_312_004;

/** Resolves from both src/ (tsx) and dist/ (node). */
function migrationsFolder(): string {
  const requireFromHere = createRequire(import.meta.url);
  const packageJson = requireFromHere.resolve("../../package.json");
  return resolve(dirname(packageJson), "drizzle");
}

/**
 * Apply pending migrations, safely under concurrency.
 *
 * Running migrations at boot is the right default for a self-hosted gateway:
 * the alternative is a deploy that starts, serves 500s against a table that does
 * not exist yet, and waits for someone to remember the manual step.
 *
 * The risk it introduces is several replicas migrating at once, so this takes a
 * Postgres **advisory lock** first. Instances serialize: the first migrates, the
 * rest wait and then find nothing to do. The lock is session-scoped and released
 * explicitly, and Postgres drops it if the connection dies mid-migration.
 *
 * Set `SKIP_MIGRATIONS=true` where migrations are run by a separate deploy step.
 */
export async function runMigrations(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
): Promise<void> {
  const startedAt = performance.now();

  // Blocks until acquired rather than failing — a replica losing the race
  // should wait for the winner, not crash.
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);

  try {
    await migrate(db, { migrationsFolder: migrationsFolder() });
    logger.info(
      { durationMs: Math.round(performance.now() - startedAt) },
      "database migrations applied",
    );
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
  }
}
