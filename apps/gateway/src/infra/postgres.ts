import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import * as schema from "../db/schema.js";
import { withTimeout, type Closable, type DependencyCheck } from "./dependency.js";

const { Pool } = pg;

export interface PostgresClient extends DependencyCheck, Closable {
  readonly db: NodePgDatabase<typeof schema>;
  readonly pool: pg.Pool;
}

/**
 * Postgres connection pool + Drizzle handle.
 *
 * The pool is bounded on purpose. An unbounded pool under load does not fail
 * fast — it opens connections until Postgres itself refuses them, converting a
 * traffic spike into a database-wide outage affecting every client.
 *
 * No connection is opened here. `pg.Pool` connects lazily, which means a Postgres
 * outage at boot does not prevent the gateway from starting and correctly
 * reporting itself as not-ready.
 */
export function createPostgresClient(config: AppConfig, logger: Logger): PostgresClient {
  const pool = new Pool({
    connectionString: config.postgres.url,
    max: config.postgres.poolMax,
    connectionTimeoutMillis: config.postgres.connectionTimeoutMs,
    idleTimeoutMillis: config.postgres.idleTimeoutMs,
  });

  // An idle client erroring (server restart, network drop) emits on the pool.
  // Without a listener Node treats it as an unhandled 'error' event and exits.
  pool.on("error", (error) => {
    logger.error({ err: error, dependency: "postgres" }, "idle postgres client error");
  });

  const db = drizzle(pool, { schema });

  return {
    name: "postgres",
    db,
    pool,
    async ping(timeoutMs: number): Promise<void> {
      await withTimeout(pool.query("SELECT 1"), timeoutMs, "postgres ping");
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
