import { sql } from "drizzle-orm";
import type { Database } from "../auth/api-key-repository.js";
import { abortableSleep, type Sleep } from "../infra/sleep.js";
import type { Logger } from "./logger.js";

/**
 * Deletes request records past their retention window.
 *
 * Without this the `requests` table grows forever: at 100 req/s that is roughly
 * 260 million rows a year, and every dashboard query gets slower until somebody
 * notices. Unbounded growth in a table nothing ever deletes from is not a
 * feature gap, it is a latent outage.
 *
 * Three things make this safe to run against a live database:
 *
 * 1. **Batched.** One `DELETE ... WHERE created_at < X` over millions of rows
 *    holds locks for the whole statement, writes an enormous WAL record, and
 *    bloats the table. Deleting in small chunks lets autovacuum keep up and lets
 *    ordinary traffic interleave.
 *
 * 2. **Lock-guarded.** Replicas all run this timer. A `pg_try_advisory_lock`
 *    means exactly one prunes per round and the rest skip immediately — `try`
 *    rather than the blocking variant used for migrations, because a skipped
 *    prune costs nothing and will happen on the next tick.
 *
 * 3. **Bounded per run.** A capped number of batches, so a first run against a
 *    table with a year of history does not turn into an hours-long transaction
 *    storm. It simply makes progress and continues next time.
 *
 * Nothing here is on the request path, and a failure is logged rather than
 * propagated — losing a prune round is not worth failing traffic over.
 */

/** Distinct from the migration lock; the two must never block each other. */
const PRUNE_LOCK_ID = 8_312_005;

export interface RequestPruner {
  /** Run one prune pass now. Returns rows deleted. Exposed for tests and ops. */
  prune(): Promise<number>;
  /** Begin the periodic timer. */
  start(): void;
  stop(): void;
}

export interface RequestPrunerOptions {
  readonly db: Database;
  readonly logger: Logger;
  /** Days of history to keep. Must be > 0; retention is disabled upstream. */
  readonly retentionDays: number;
  readonly intervalMs?: number;
  /** Rows per DELETE statement. */
  readonly batchSize?: number;
  /** Ceiling on batches per run, so one pass cannot run unbounded. */
  readonly maxBatchesPerRun?: number;
  /** Injected in tests. */
  readonly sleep?: Sleep;
}

export function createRequestPruner(options: RequestPrunerOptions): RequestPruner {
  const { db, logger, retentionDays } = options;
  const intervalMs = options.intervalMs ?? 3_600_000;
  const batchSize = options.batchSize ?? 5_000;
  const maxBatchesPerRun = options.maxBatchesPerRun ?? 200;
  const sleep = options.sleep ?? abortableSleep;

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const stopper = new AbortController();

  async function deleteOneBatch(): Promise<number> {
    // Delete by primary key from a bounded subquery rather than by predicate
    // directly: it keeps each statement's lock footprint small and predictable,
    // and lets the created_at index drive the selection.
    const result = await db.execute(sql`
      delete from requests
      where id in (
        select id from requests
        where created_at < now() - (${retentionDays} * interval '1 day')
        order by created_at
        limit ${batchSize}
      )
    `);

    return result.rowCount ?? 0;
  }

  async function prune(): Promise<number> {
    // Only one instance prunes per round. `try` rather than blocking: a replica
    // that loses the race should get on with serving traffic, not queue behind
    // another replica's delete loop.
    const lock = await db.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_lock(${PRUNE_LOCK_ID}) as acquired`,
    );

    if (lock.rows[0]?.acquired !== true) {
      logger.debug({}, "another instance is pruning request records; skipping this round");
      return 0;
    }

    const startedAt = performance.now();
    let deleted = 0;

    try {
      for (let batch = 0; batch < maxBatchesPerRun; batch += 1) {
        if (stopper.signal.aborted) break;

        const removed = await deleteOneBatch();
        deleted += removed;

        // A short batch means we have caught up.
        if (removed < batchSize) break;

        // Breathe between batches so pruning cannot monopolise the pool or
        // outrun autovacuum.
        try {
          await sleep(100, stopper.signal);
        } catch {
          break; // shutting down
        }
      }

      if (deleted > 0) {
        logger.info(
          { deleted, retentionDays, durationMs: Math.round(performance.now() - startedAt) },
          "pruned request records past their retention window",
        );
      }
    } finally {
      await db
        .execute(sql`select pg_advisory_unlock(${PRUNE_LOCK_ID})`)
        .catch((error: unknown) => {
          // The lock is session-scoped; Postgres releases it if the connection
          // drops, so this is worth logging but not worth failing over.
          logger.warn({ err: error }, "failed to release the prune advisory lock");
        });
    }

    return deleted;
  }

  return {
    prune,

    start(): void {
      if (timer !== undefined) return;

      timer = setInterval(() => {
        // Never overlap runs: a pass that is still working through a backlog
        // should finish before another starts.
        if (running) return;
        running = true;

        void prune()
          .catch((error: unknown) => {
            // Retention is housekeeping. A failure here must never affect
            // traffic; the next tick will try again.
            logger.error({ err: error }, "failed to prune request records");
          })
          .finally(() => {
            running = false;
          });
      }, intervalMs);

      // Never hold the process open for housekeeping.
      timer.unref();
    },

    stop(): void {
      stopper.abort();
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
