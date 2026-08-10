import type { LLMErrorCode } from "@openllm/core";
import type { Database } from "../auth/api-key-repository.js";
import { requests, type NewRequestRow } from "../db/schema.js";
import type { Logger } from "./logger.js";

/**
 * What we record about a request (spec §15).
 *
 * Note what is absent: message content, in any form. The type has no field for
 * it, so no call site can supply one.
 */
export interface RequestObservation {
  readonly requestId: string;
  readonly traceId: string;
  readonly apiKeyId: string | undefined;
  readonly requestedModel: string;
  readonly route: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly status: "success" | "error";
  readonly errorCode: LLMErrorCode | undefined;
  readonly httpStatus: number;
  readonly latencyMs: number;
  readonly providerCalls: number;
  readonly cached: boolean;
  readonly streamed: boolean;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  readonly estimatedCostUsd: number | undefined;
}

export interface RequestRecorder {
  /** Enqueue a record. Returns immediately; never throws. */
  record(observation: RequestObservation): void;
  /** Write everything buffered. Called on shutdown, and by tests. */
  flush(): Promise<void>;
  /** Records dropped because the buffer was full. */
  droppedCount(): number;
  stop(): void;
}

export interface RequestRecorderOptions {
  readonly db: Database;
  readonly logger: Logger;
  /** Rows per INSERT. */
  readonly batchSize?: number;
  /** Maximum time a record waits before being written. */
  readonly flushIntervalMs?: number;
  /** Hard cap on buffered records. */
  readonly maxBufferSize?: number;
}

/**
 * Buffered, batched writer for request records.
 *
 * ## Why not just insert a row per request
 *
 * Two reasons, and both are the difference between a metrics feature and an
 * outage:
 *
 *  1. **Latency.** An awaited INSERT on the response path adds a database
 *     round-trip to every request, and puts Postgres in the critical path of an
 *     API whose whole job is proxying somebody else's.
 *  2. **Failure coupling.** If recording can fail a request, then Postgres being
 *     slow makes the gateway slow, and Postgres being down makes the gateway
 *     down — to save data nobody is reading right now.
 *
 * So records are buffered and written in batches, entirely off the request path.
 * A write failure loses metrics, which is the correct thing to lose.
 *
 * ## Bounded, because unbounded buffers are just slower crashes
 *
 * If Postgres is unavailable, the buffer would otherwise grow until the process
 * runs out of memory — turning a recoverable dependency outage into a hard
 * crash that also loses everything already buffered. Instead the buffer has a
 * ceiling, oldest records are dropped, and the drop count is logged and
 * exposed. Losing the oldest metrics under sustained failure is a known,
 * visible cost; an OOM is not.
 */
export function createRequestRecorder(options: RequestRecorderOptions): RequestRecorder {
  const { db, logger } = options;
  const batchSize = options.batchSize ?? 50;
  const flushIntervalMs = options.flushIntervalMs ?? 1_000;
  const maxBufferSize = options.maxBufferSize ?? 10_000;

  let buffer: NewRequestRow[] = [];
  let dropped = 0;
  let flushing: Promise<void> | undefined;
  let stopped = false;

  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  // Never hold the process open for a metrics flush.
  timer.unref();

  async function writeBatch(rows: NewRequestRow[]): Promise<void> {
    try {
      await db.insert(requests).values(rows);
    } catch (error) {
      // Metrics are the right thing to lose. Re-queueing on failure would grow
      // the buffer during exactly the outage that caused the failure.
      logger.error(
        { err: error, rows: rows.length },
        "failed to persist request records; metrics for these requests are lost",
      );
    }
  }

  async function flush(): Promise<void> {
    if (flushing !== undefined) return flushing;
    if (buffer.length === 0) return;

    const batch = buffer;
    buffer = [];

    flushing = (async () => {
      // Chunked so one flush of a large backlog does not build a single
      // enormous statement.
      for (let index = 0; index < batch.length; index += batchSize) {
        await writeBatch(batch.slice(index, index + batchSize));
      }
    })().finally(() => {
      flushing = undefined;
    });

    return flushing;
  }

  return {
    record(observation: RequestObservation): void {
      if (stopped) return;

      if (buffer.length >= maxBufferSize) {
        buffer.shift();
        dropped += 1;
        // Once per hundred, so a sustained outage does not itself become a log
        // flood on top of a database problem.
        if (dropped % 100 === 1) {
          logger.warn(
            { dropped, maxBufferSize },
            "request record buffer full; dropping oldest records",
          );
        }
      }

      buffer.push({
        requestId: observation.requestId,
        traceId: observation.traceId,
        apiKeyId: observation.apiKeyId ?? null,
        requestedModel: observation.requestedModel,
        route: observation.route ?? null,
        provider: observation.provider ?? null,
        model: observation.model ?? null,
        status: observation.status,
        errorCode: observation.errorCode ?? null,
        httpStatus: observation.httpStatus,
        latencyMs: observation.latencyMs,
        providerCalls: observation.providerCalls,
        cached: observation.cached,
        streamed: observation.streamed,
        inputTokens: observation.inputTokens ?? null,
        outputTokens: observation.outputTokens ?? null,
        totalTokens: observation.totalTokens ?? null,
        // Drizzle takes numeric as a string, which is also what keeps the value
        // exact rather than round-tripping through a float.
        estimatedCostUsd:
          observation.estimatedCostUsd === undefined
            ? null
            : observation.estimatedCostUsd.toFixed(10),
      });

      if (buffer.length >= batchSize) void flush();
    },

    flush,
    droppedCount: () => dropped,

    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
