import { describe, expect, it, vi } from "vitest";
import { LLMError } from "@openllm/core";
import {
  runWithFallback,
  streamWithFallback,
  type StartedStream,
} from "../../src/routing/fallback.js";
import type { RouteTarget } from "../../src/routing/route-table.js";
import type { ChatChunk } from "../../src/providers/types.js";
import { rejection } from "../helpers/expect-error.js";

const targets: readonly RouteTarget[] = [
  { provider: "gemini", model: "gemini-2.5-flash", requested: "gemini-2.5-flash" },
  { provider: "openai", model: "gpt-4.1-mini", requested: "gpt-4.1-mini" },
  { provider: "anthropic", model: "claude-sonnet-4", requested: "claude-sonnet-4" },
];

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("runWithFallback", () => {
  it("returns the first success without touching later targets", async () => {
    const run = vi.fn(async () => "ok");

    const outcome = await runWithFallback(targets, run);

    expect(outcome.value).toBe("ok");
    expect(outcome.target.provider).toBe("gemini");
    expect(outcome.failed).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("moves to the next provider on a failoverable error", async () => {
    const run = vi.fn(async (target: RouteTarget) => {
      if (target.provider === "gemini") throw LLMError.rateLimited("429");
      return target.provider;
    });

    const outcome = await runWithFallback(targets, run);

    expect(outcome.value).toBe("openai");
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]).toMatchObject({ provider: "gemini", code: "RATE_LIMITED" });
  });

  it("STOPS immediately on a non-failoverable error", async () => {
    // Spec §8: do not fall back on every error. Replaying a malformed request
    // across four providers means four charges for four identical 400s.
    const run = vi.fn(async () => {
      throw LLMError.invalidRequest("temperature must be <= 2");
    });

    const error = await rejection(runWithFallback(targets, run));

    expect(error.code).toBe("INVALID_REQUEST");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls over on MODEL_NOT_FOUND even though it is not retryable", async () => {
    // The two axes differ: retrying the same provider is pointless, but another
    // provider may well have an equivalent model.
    const run = vi.fn(async (target: RouteTarget) => {
      if (target.provider === "gemini") throw LLMError.modelNotFound("no such model");
      return target.provider;
    });

    expect((await runWithFallback(targets, run)).value).toBe("openai");
  });

  it("falls over on AUTHENTICATION_ERROR — a different provider has a different key", async () => {
    const run = vi.fn(async (target: RouteTarget) => {
      if (target.provider === "gemini") throw LLMError.authentication("bad key");
      return target.provider;
    });

    expect((await runWithFallback(targets, run)).value).toBe("openai");
  });

  it("reports the last error but attaches the full history when all fail", async () => {
    // "All four rate-limited" and "three misconfigured, the fourth rate-limited"
    // look identical from the final error alone.
    const run = vi.fn(async (target: RouteTarget) => {
      if (target.provider === "gemini") throw LLMError.authentication("bad gemini key");
      if (target.provider === "openai") throw LLMError.unavailable("openai down");
      throw LLMError.rateLimited("anthropic 429");
    });

    const error = await rejection(runWithFallback(targets, run));

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toContain("All 3 providers failed");
    const attempts = (error.details as { attempts: { provider: string; code: string }[] }).attempts;
    expect(attempts.map((a) => a.provider)).toEqual(["gemini", "openai", "anthropic"]);
    expect(attempts.map((a) => a.code)).toEqual([
      "AUTHENTICATION_ERROR",
      "UNAVAILABLE",
      "RATE_LIMITED",
    ]);
  });

  it("keeps a single failure's error untouched", async () => {
    const single = [targets[0]!];
    const original = LLMError.rateLimited("429 from gemini");

    const error = await rejection(
      runWithFallback(single, async () => {
        throw original;
      }),
    );

    expect(error).toBe(original);
  });

  it("notifies on each failover so the operator sees a masked misconfiguration", async () => {
    const onFailover = vi.fn();

    await runWithFallback(
      targets,
      async (target) => {
        if (target.provider === "gemini") throw LLMError.authentication("bad key");
        return "ok";
      },
      { onFailover },
    );

    expect(onFailover).toHaveBeenCalledTimes(1);
    expect(onFailover.mock.calls[0]?.[0]).toMatchObject({ code: "AUTHENTICATION_ERROR" });
    expect(onFailover.mock.calls[0]?.[1]).toMatchObject({ provider: "openai" });
  });

  it("normalizes a non-LLMError into INTERNAL_ERROR and does not fall over", async () => {
    // An unexpected crash is our bug; it would fail the same way everywhere.
    const run = vi.fn(async () => {
      throw new TypeError("cannot read property of undefined");
    });

    const error = await rejection(runWithFallback(targets, run));

    expect(error.code).toBe("INTERNAL_ERROR");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty target list", async () => {
    await expect(runWithFallback([], async () => "x")).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
    });
  });
});

describe("streamWithFallback", () => {
  /**
   * `start` opens the stream AND pulls its first chunk — the caller layers retry
   * inside it, so fallback only ever sees one final outcome per target.
   */
  async function started(provider: string, ...contents: string[]): Promise<StartedStream> {
    const iterator = (async function* (): AsyncGenerator<ChatChunk> {
      yield { type: "start", id: "r", provider: provider as never, model: "m" };
      for (const content of contents) yield { type: "delta", content };
      yield { type: "finish", finishReason: "stop", usage: undefined };
    })()[Symbol.asyncIterator]();

    return { iterator, first: await iterator.next() };
  }

  /** A target whose stream never produced a first chunk. */
  function failsToStart(error: unknown): Promise<StartedStream> {
    return Promise.reject(error);
  }

  /** A stream that dies partway through, after the first chunk was delivered. */
  async function diesAfterFirstChunk(provider: string): Promise<StartedStream> {
    const iterator = (async function* (): AsyncGenerator<ChatChunk> {
      yield { type: "start", id: "r", provider: provider as never, model: "m" };
      yield { type: "delta", content: "partial" };
      throw LLMError.unavailable("connection dropped");
    })()[Symbol.asyncIterator]();

    return { iterator, first: await iterator.next() };
  }

  it("swaps providers when the first fails BEFORE any chunk", async () => {
    // This is Phase 5's design paying off: the route pulls one chunk before
    // committing to a 200, so a rate-limited first provider can still be swapped
    // with the client none the wiser.
    const open = vi.fn((target: RouteTarget) => {
      if (target.provider === "gemini") return failsToStart(LLMError.rateLimited("429"));
      return started(target.provider, "hello");
    });

    const chunks = await collect(streamWithFallback(targets, open));

    expect(chunks[0]).toMatchObject({ type: "start", provider: "openai" });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does NOT fall back once a chunk has been delivered", async () => {
    // Those tokens are already on the wire. Restarting on another provider would
    // produce a response that contradicts itself mid-sentence.
    const open = vi.fn((target: RouteTarget) => {
      if (target.provider === "gemini") return diesAfterFirstChunk("gemini");
      return started(target.provider, "hello");
    });

    const received: ChatChunk[] = [];
    await expect(async () => {
      for await (const chunk of streamWithFallback(targets, open)) received.push(chunk);
    }).rejects.toMatchObject({ code: "UNAVAILABLE" });

    expect(received.map((c) => c.type)).toEqual(["start", "delta"]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("stops on a non-failoverable error without trying the next provider", async () => {
    const open = vi.fn(() => failsToStart(LLMError.invalidRequest("bad body")));

    await expect(collect(streamWithFallback(targets, open))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("handles `open` itself throwing, e.g. an unconfigured provider", async () => {
    // The registry rejects an unconfigured provider synchronously. If that were
    // raised outside the guarded region it would escape fallback entirely.
    const open = vi.fn((target: RouteTarget) => {
      if (target.provider === "gemini") throw LLMError.modelNotFound("gemini not configured");
      return started(target.provider, "hi");
    });

    const chunks = await collect(streamWithFallback(targets, open));

    expect(chunks[0]).toMatchObject({ provider: "openai" });
  });

  it("aggregates attempts when every provider fails", async () => {
    const open = vi.fn(() => failsToStart(LLMError.unavailable("down")));

    const error = await rejection(collect(streamWithFallback(targets, open)));

    expect(error.message).toContain("All 3 providers failed");
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("closes the committed stream when the consumer breaks out early", async () => {
    // Client disconnect or shutdown: the provider connection must be released
    // rather than left generating tokens nobody will read.
    let released = false;
    const open = vi.fn(async (target: RouteTarget): Promise<StartedStream> => {
      const inner = (async function* (): AsyncGenerator<ChatChunk> {
        try {
          yield { type: "start", id: "r", provider: target.provider, model: "m" };
          yield { type: "delta", content: "a" };
          yield { type: "delta", content: "b" };
        } finally {
          released = true;
        }
      })()[Symbol.asyncIterator]();
      return { iterator: inner, first: await inner.next() };
    });

    for await (const chunk of streamWithFallback(targets, open)) {
      if (chunk.type === "delta") break;
    }

    expect(released).toBe(true);
  });
});
