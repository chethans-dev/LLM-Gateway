import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../src/auth/api-key-repository.js";
import { createRequestPruner } from "../../src/observability/request-pruner.js";
import { silentLogger } from "../helpers/build-test-server.js";

/**
 * A fake Postgres that answers the advisory-lock probe and then reports a
 * scripted number of deleted rows per batch.
 */
function fakeDb(options: {
  lockAcquired?: boolean;
  batches?: number[];
  failOn?: number;
}) {
  const statements: string[] = [];
  let deleteCall = 0;

  const db = {
    execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(query);
      statements.push(text);

      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: options.lockAcquired ?? true }] };
      }
      if (text.includes("pg_advisory_unlock")) {
        return { rows: [] };
      }

      // A delete batch.
      const index = deleteCall++;
      if (options.failOn === index) throw new Error("deadlock detected");
      return { rowCount: options.batches?.[index] ?? 0 };
    }),
  } as unknown as Database;

  return {
    db,
    statements,
    deleteCount: () => deleteCall,
    lockCalls: () => statements.filter((s) => s.includes("pg_try_advisory_lock")).length,
    unlockCalls: () => statements.filter((s) => s.includes("pg_advisory_unlock")).length,
  };
}

const noSleep = async () => {};

describe("request pruner", () => {
  it("deletes in batches until it catches up", async () => {
    // A short batch means there is nothing older left; stopping there avoids a
    // pointless extra round trip.
    const fake = fakeDb({ batches: [100, 100, 40] });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 90,
      batchSize: 100,
      sleep: noSleep,
    });

    expect(await pruner.prune()).toBe(240);
    expect(fake.deleteCount()).toBe(3);
  });

  it("stops at the per-run ceiling rather than running unbounded", async () => {
    // A first run against a year of history must make progress and hand control
    // back, not turn into an hours-long transaction storm.
    const fake = fakeDb({ batches: Array.from({ length: 50 }, () => 100) });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 90,
      batchSize: 100,
      maxBatchesPerRun: 5,
      sleep: noSleep,
    });

    expect(await pruner.prune()).toBe(500);
    expect(fake.deleteCount()).toBe(5);
  });

  it("does nothing when there is nothing to delete", async () => {
    const fake = fakeDb({ batches: [0] });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 90,
      sleep: noSleep,
    });

    expect(await pruner.prune()).toBe(0);
    expect(fake.deleteCount()).toBe(1);
  });

  it("SKIPS entirely when another instance holds the lock", async () => {
    // Every replica runs this timer. Without the lock they would all delete the
    // same rows concurrently and contend for the same pages.
    const fake = fakeDb({ lockAcquired: false, batches: [100] });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 90,
      sleep: noSleep,
    });

    expect(await pruner.prune()).toBe(0);
    expect(fake.deleteCount()).toBe(0);
  });

  it("uses try-lock, not the blocking variant", async () => {
    // A replica that loses the race should serve traffic, not queue behind
    // another replica's delete loop. Blocking here would tie up a pool
    // connection for the length of someone else's prune.
    const fake = fakeDb({ batches: [0] });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 90,
      sleep: noSleep,
    });

    await pruner.prune();

    expect(fake.lockCalls()).toBe(1);
    expect(fake.statements.some((s) => s.includes("pg_advisory_lock("))).toBe(false);
  });

  it("releases the lock even when a batch fails", async () => {
    // A held lock would stop every future prune on every replica.
    const fake = fakeDb({ batches: [100, 100], failOn: 1 });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 90,
      batchSize: 100,
      sleep: noSleep,
    });

    await expect(pruner.prune()).rejects.toThrow("deadlock");
    expect(fake.unlockCalls()).toBe(1);
  });

  it("scopes the delete by the configured retention window", async () => {
    const fake = fakeDb({ batches: [0] });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 7,
      sleep: noSleep,
    });

    await pruner.prune();

    const deleteStatement = fake.statements.find((s) => s.includes("delete from requests"));
    expect(deleteStatement).toContain("7");
    expect(deleteStatement).toContain("created_at");
  });

  it("deletes by primary key from a bounded subquery", async () => {
    // Keeps each statement's lock footprint small and predictable, instead of
    // one predicate delete sweeping an unknown number of rows.
    const fake = fakeDb({ batches: [0] });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 90,
      sleep: noSleep,
    });

    await pruner.prune();

    const deleteStatement = fake.statements.find((s) => s.includes("delete from requests")) ?? "";
    expect(deleteStatement).toContain("where id in");
    expect(deleteStatement).toContain("limit");
  });

  it("never overlaps runs on the timer", async () => {
    // A pass still working through a backlog must finish before another starts,
    // or two loops fight over the same rows.
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;

    const db = {
      execute: vi.fn(async (query: unknown) => {
        const text = JSON.stringify(query);
        if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        if (text.includes("pg_advisory_unlock")) return { rows: [] };
        calls += 1;
        await gate;
        return { rowCount: 0 };
      }),
    } as unknown as Database;

    const pruner = createRequestPruner({
      db,
      logger: silentLogger,
      retentionDays: 90,
      intervalMs: 5,
      sleep: noSleep,
    });

    pruner.start();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Many ticks elapsed, but only one delete is in flight.
    expect(calls).toBe(1);

    resolveFirst?.();
    pruner.stop();
  });

  it("swallows a failure on the timer rather than crashing the process", async () => {
    // Retention is housekeeping. A failure must never take traffic down; the
    // next tick tries again.
    const db = {
      execute: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    } as unknown as Database;

    const pruner = createRequestPruner({
      db,
      logger: silentLogger,
      retentionDays: 90,
      intervalMs: 5,
      sleep: noSleep,
    });

    pruner.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    pruner.stop();

    // Reaching here without an unhandled rejection is the assertion.
    expect(db.execute).toHaveBeenCalled();
  });

  it("stops cleanly mid-run", async () => {
    const fake = fakeDb({ batches: Array.from({ length: 50 }, () => 100) });
    const pruner = createRequestPruner({
      db: fake.db,
      logger: silentLogger,
      retentionDays: 90,
      batchSize: 100,
      sleep: noSleep,
    });

    pruner.stop();

    // The abort is observed on the first loop check, so no batches run.
    expect(await pruner.prune()).toBe(0);
  });
});
