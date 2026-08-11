import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createChatService } from "../../src/chat/chat-service.js";
import { buildServer } from "../../src/http/server.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createRequestRecorder } from "../../src/observability/request-recorder.js";
import type {
  RequestObservation,
  RequestRecorder,
} from "../../src/observability/request-recorder.js";
import type { Database } from "../../src/auth/api-key-repository.js";
import { createTestConfig, fakeLifecycle, silentLogger } from "../helpers/build-test-server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function collectingRecorder(): RequestRecorder & { records: RequestObservation[] } {
  const records: RequestObservation[] = [];
  return {
    records,
    record: (observation) => records.push(observation),
    flush: async () => {},
    droppedCount: () => 0,
    stop: () => {},
  };
}

async function build(recorder: RequestRecorder): Promise<FastifyInstance> {
  const config = createTestConfig({
    observability: {
      recording: { enabled: true, batchSize: 10, flushIntervalMs: 50, maxBufferSize: 100 },
      retention: { retentionDays: 90, intervalMs: 3_600_000, batchSize: 100 },
      pricing: { mock: { inputPerMillionTokens: 1_000, outputPerMillionTokens: 2_000 } },
    },
  });
  const registry = createProviderRegistry(config, silentLogger);

  return buildServer({
    config,
    logger: silentLogger,
    lifecycle: fakeLifecycle("ready"),
    checks: [],
    version: "0.1.0-test",
    chatService: createChatService({ registry, config }),
    recorder,
  });
}

const body = { model: "mock", messages: [{ role: "user", content: "Explain Redis Pub/Sub" }] };

function post(instance: FastifyInstance, payload: Record<string, unknown> = body) {
  return instance.inject({ method: "POST", url: "/v1/chat/completions", payload });
}

describe("what gets recorded", () => {
  it("records a successful request with the facts spec §15 asks for", async () => {
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app);
    const record = recorder.records[0];

    expect(record).toMatchObject({
      requestedModel: "mock",
      provider: "mock",
      model: "mock",
      status: "success",
      httpStatus: 200,
      streamed: false,
      cached: false,
      providerCalls: 1,
    });
    expect(record?.requestId).toMatch(/^req_/);
    expect(record?.traceId).toMatch(/^tr_/);
    expect(record?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(record?.totalTokens).toBeGreaterThan(0);
  });

  it("records failures with a normalized error code", async () => {
    // A failed request that leaves no trace is the one you most need to see.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app, { model: "mock/server-error", messages: body.messages });

    expect(recorder.records[0]).toMatchObject({
      status: "error",
      httpStatus: 502,
      errorCode: "PROVIDER_ERROR",
    });
  });

  it("records a request rejected before it reached a provider", async () => {
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app, { ...body, tools: [{ type: "function" }] });

    expect(recorder.records[0]).toMatchObject({
      status: "error",
      httpStatus: 400,
      provider: undefined,
    });
  });

  it("records streamed requests, which never reach onResponse", async () => {
    // reply.hijack() means Fastify's response lifecycle does not run, so the
    // streaming path has to record itself.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app, { ...body, stream: true });

    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]).toMatchObject({ streamed: true, status: "success" });
    expect(recorder.records[0]?.totalTokens).toBeGreaterThan(0);
  });

  it("records each request exactly once", async () => {
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app);
    await post(app, { ...body, stream: true });

    expect(recorder.records).toHaveLength(2);
  });

  it("does NOT record health probes", async () => {
    // They would bury real traffic in the table the dashboard reads.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/ready" });
    await app.inject({ method: "GET", url: "/nope" });

    expect(recorder.records).toEqual([]);
  });

  it("estimates cost from usage and pricing", async () => {
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app);

    // Pricing in this test is deliberately huge so the figure is unmistakable.
    expect(recorder.records[0]?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("leaves cost undefined for a model with no pricing", async () => {
    const recorder = collectingRecorder();
    const config = createTestConfig({
      observability: {
        recording: { enabled: true, batchSize: 10, flushIntervalMs: 50, maxBufferSize: 100 },
      retention: { retentionDays: 90, intervalMs: 3_600_000, batchSize: 100 },
        pricing: {},
      },
    });
    const registry = createProviderRegistry(config, silentLogger);
    app = await buildServer({
      config,
      logger: silentLogger,
      lifecycle: fakeLifecycle("ready"),
      checks: [],
      version: "0.1.0-test",
      chatService: createChatService({ registry, config }),
      recorder,
    });

    await post(app);

    // Undefined, not zero — the same honesty rule as token usage.
    expect(recorder.records[0]?.estimatedCostUsd).toBeUndefined();
  });
});

describe("what must NEVER be recorded", () => {
  it("has no field for message content anywhere in the record", async () => {
    // The strongest form of "prompts are not stored": the shape has nowhere to
    // put them, so no call site can, accidentally or otherwise.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app, {
      model: "mock/echo",
      messages: [{ role: "user", content: "SENSITIVE-PROMPT-CONTENT" }],
    });

    const serialized = JSON.stringify(recorder.records[0]);
    expect(serialized).not.toContain("SENSITIVE-PROMPT-CONTENT");
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("content");
  });

  it("does not record the completion either", async () => {
    const recorder = collectingRecorder();
    app = await build(recorder);

    const response = await post(app, {
      model: "mock/echo",
      messages: [{ role: "user", content: "UNIQUE-ECHOED-STRING" }],
    });

    // The completion echoes the prompt back...
    expect(response.json().choices[0].message.content).toBe("UNIQUE-ECHOED-STRING");
    // ...and none of it reaches the record.
    expect(JSON.stringify(recorder.records[0])).not.toContain("UNIQUE-ECHOED-STRING");
  });
});

describe("request recorder buffering", () => {
  function fakeDb(onInsert: (rows: unknown[]) => void, fail = false) {
    return {
      insert: () => ({
        values: async (rows: unknown[]) => {
          if (fail) throw new Error("connection terminated");
          onInsert(rows);
        },
      }),
    } as unknown as Database;
  }

  const observation: RequestObservation = {
    requestId: "req_1",
    traceId: "tr_1",
    apiKeyId: undefined,
    requestedModel: "mock",
    route: undefined,
    provider: "mock",
    model: "mock",
    status: "success",
    errorCode: undefined,
    httpStatus: 200,
    latencyMs: 12,
    providerCalls: 1,
    cached: false,
    streamed: false,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    estimatedCostUsd: 0.000012,
  };

  it("buffers rather than writing per request", async () => {
    // An awaited INSERT per request puts Postgres in the critical path of an
    // API whose whole job is proxying somebody else's.
    const batches: unknown[][] = [];
    const recorder = createRequestRecorder({
      db: fakeDb((rows) => batches.push(rows)),
      logger: silentLogger,
      batchSize: 5,
      flushIntervalMs: 10_000,
    });

    recorder.record(observation);
    recorder.record(observation);
    expect(batches).toEqual([]);

    await recorder.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    recorder.stop();
  });

  it("flushes automatically once the batch is full", async () => {
    const batches: unknown[][] = [];
    const recorder = createRequestRecorder({
      db: fakeDb((rows) => batches.push(rows)),
      logger: silentLogger,
      batchSize: 3,
      flushIntervalMs: 10_000,
    });

    for (let i = 0; i < 3; i += 1) recorder.record(observation);
    await recorder.flush();

    expect(batches[0]).toHaveLength(3);
    recorder.stop();
  });

  it("keeps cost exact by passing numeric as a string", async () => {
    // Summing millions of floats accumulates error exactly where the number
    // matters most — the monthly total.
    const batches: Record<string, unknown>[][] = [];
    const recorder = createRequestRecorder({
      db: fakeDb((rows) => batches.push(rows as Record<string, unknown>[])),
      logger: silentLogger,
      batchSize: 1,
      flushIntervalMs: 10_000,
    });

    recorder.record(observation);
    await recorder.flush();

    expect(typeof batches[0]?.[0]?.["estimatedCostUsd"]).toBe("string");
    recorder.stop();
  });

  it("stores null, not zero, for unknown cost and usage", async () => {
    const batches: Record<string, unknown>[][] = [];
    const recorder = createRequestRecorder({
      db: fakeDb((rows) => batches.push(rows as Record<string, unknown>[])),
      logger: silentLogger,
      batchSize: 1,
      flushIntervalMs: 10_000,
    });

    recorder.record({
      ...observation,
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      estimatedCostUsd: undefined,
    });
    await recorder.flush();

    expect(batches[0]?.[0]?.["estimatedCostUsd"]).toBeNull();
    expect(batches[0]?.[0]?.["inputTokens"]).toBeNull();
    recorder.stop();
  });

  it("swallows a write failure — metrics are the right thing to lose", async () => {
    // If recording can fail a request, Postgres being down makes the gateway
    // down, to save data nobody is reading right now.
    const recorder = createRequestRecorder({
      db: fakeDb(() => {}, true),
      logger: silentLogger,
      batchSize: 1,
      flushIntervalMs: 10_000,
    });

    recorder.record(observation);

    await expect(recorder.flush()).resolves.toBeUndefined();
    recorder.stop();
  });

  it("drops the oldest records rather than growing without bound", async () => {
    // An unbounded buffer during a Postgres outage is just a slower crash — and
    // an OOM loses everything buffered, not merely the oldest.
    const batches: unknown[][] = [];
    const recorder = createRequestRecorder({
      db: fakeDb((rows) => batches.push(rows)),
      logger: silentLogger,
      batchSize: 1_000,
      flushIntervalMs: 10_000,
      maxBufferSize: 3,
    });

    for (let i = 0; i < 10; i += 1) recorder.record(observation);

    expect(recorder.droppedCount()).toBe(7);
    await recorder.flush();
    expect(batches[0]).toHaveLength(3);
    recorder.stop();
  });

  it("ignores records after stop, so shutdown does not buffer forever", () => {
    const recorder = createRequestRecorder({
      db: fakeDb(() => {}),
      logger: silentLogger,
    });

    recorder.stop();
    recorder.record(observation);

    expect(recorder.droppedCount()).toBe(0);
  });

  it("flushes on an interval without being asked", async () => {
    const batches: unknown[][] = [];
    const recorder = createRequestRecorder({
      db: fakeDb((rows) => batches.push(rows)),
      logger: silentLogger,
      batchSize: 1_000,
      flushIntervalMs: 20,
    });

    recorder.record(observation);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(batches).toHaveLength(1);
    recorder.stop();
  });
});

describe("recording can be switched off", () => {
  it("serves requests normally with no recorder", async () => {
    const config = createTestConfig();
    const registry = createProviderRegistry(config, silentLogger);
    app = await buildServer({
      config,
      logger: silentLogger,
      lifecycle: fakeLifecycle("ready"),
      checks: [],
      version: "0.1.0-test",
      chatService: createChatService({ registry, config }),
    });

    expect((await post(app)).statusCode).toBe(200);
  });
});

describe("observation draft isolation", () => {
  it("does not share one draft between concurrent requests", async () => {
    // Fastify shares a decorator's value; an object literal there would let one
    // request's provider overwrite another's.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await Promise.all([
      post(app, { model: "mock", messages: body.messages }),
      post(app, { model: "mock/echo", messages: body.messages }),
      post(app, { model: "mock/server-error", messages: body.messages }),
    ]);

    const models = recorder.records.map((record) => record.requestedModel).sort();
    expect(models).toEqual(["mock", "mock/echo", "mock/server-error"]);
  });
});

describe("recorder is not called for probes even under load", () => {
  it("stays quiet", async () => {
    const recorder = collectingRecorder();
    const spy = vi.spyOn(recorder, "record");
    app = await build(recorder);

    await Promise.all(
      Array.from({ length: 10 }, () => app!.inject({ method: "GET", url: "/health" })),
    );

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("failures record which provider was attempted", () => {
  it("attributes a provider error to that provider, not to 'unrouted'", async () => {
    // "Which provider failed?" is the single most useful question a dashboard
    // answers. The success path records the provider; a failure never reaches
    // it, so the error handler fills it in from the normalized error.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app, { model: "mock/server-error", messages: body.messages });

    expect(recorder.records[0]).toMatchObject({
      provider: "mock",
      status: "error",
      errorCode: "PROVIDER_ERROR",
    });
  });

  it("leaves provider unset when the request never reached one", async () => {
    // An unresolvable model genuinely has no provider — inventing one would be
    // worse than the honest null.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app, { model: "no-such-vendor-model", messages: body.messages });

    expect(recorder.records[0]).toMatchObject({
      provider: undefined,
      errorCode: "MODEL_NOT_FOUND",
    });
  });
});

describe("a streamed failure is recorded like any other failure", () => {
  /**
   * The bug these cover: the streaming path recorded itself from a `finally`
   * block that ran BEFORE the rethrown error reached the error handler. It wrote
   * a hardcoded 500 with no error code and no provider, then marked the draft
   * recorded — so the correct values the handler set microseconds later were
   * discarded, and `onResponse` skipped the row as already written.
   *
   * The client always got the right status. Only the history was wrong, which is
   * the worst place for it to be wrong: the dashboard showed 5xx that never
   * happened and filed every streamed failure under `unrouted`.
   *
   * Nothing asserted what a STREAM records, only what the client receives, which
   * is exactly how it survived.
   */
  async function streamOf(model: string) {
    const recorder = collectingRecorder();
    app = await build(recorder);

    const response = await post(app, {
      model,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    return { response, record: recorder.records[0] };
  }

  it.each([
    ["mock/rate-limited", 429, "RATE_LIMITED"],
    ["mock/model-not-found", 404, "MODEL_NOT_FOUND"],
    ["mock/auth-error", 401, "AUTHENTICATION_ERROR"],
    ["mock/invalid", 400, "INVALID_REQUEST"],
  ])(
    "records %s as %i, matching what the client was told",
    async (model, expectedStatus, expectedCode) => {
      const { response, record } = await streamOf(model);

      // The client's view was always correct; the record has to agree with it.
      expect(response.statusCode).toBe(expectedStatus);
      expect(record?.httpStatus).toBe(expectedStatus);
      expect(record?.errorCode).toBe(expectedCode);
      expect(record?.status).toBe("error");
      expect(record?.streamed).toBe(true);
    },
  );

  it("attributes the failure to a provider rather than dumping it in unrouted", async () => {
    // "Which provider is failing?" is the single most useful question the
    // dashboard answers, and a null provider silently removes a request from it.
    const { record } = await streamOf("mock/server-error");

    expect(record?.provider).toBe("mock");
  });

  it("agrees with the non-streamed record for the same failure", async () => {
    // The two paths diverging is the whole defect. Comparing them directly means
    // a future change to one has to keep the other honest.
    const streamed = await streamOf("mock/rate-limited");

    const recorder = collectingRecorder();
    app = await build(recorder);
    await post(app, { model: "mock/rate-limited", messages: [{ role: "user", content: "hi" }] });
    const buffered = recorder.records[0];

    expect(streamed.record?.httpStatus).toBe(buffered?.httpStatus);
    expect(streamed.record?.errorCode).toBe(buffered?.errorCode);
    expect(streamed.record?.status).toBe(buffered?.status);
    expect(streamed.record?.provider).toBe(buffered?.provider);
  });

  it("records exactly one row, not two", async () => {
    // Both the streaming path and onResponse can reach the recorder; `recorded`
    // is what keeps that from double-counting every streamed request.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app, {
      model: "mock/rate-limited",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    expect(recorder.records).toHaveLength(1);
  });

  it("still records a SUCCESSFUL stream as a 200", async () => {
    // The fix must not have moved success off the hijacked path, where
    // onResponse genuinely never fires.
    const recorder = collectingRecorder();
    app = await build(recorder);

    await post(app, {
      model: "mock/echo",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    expect(recorder.records[0]).toMatchObject({
      status: "success",
      httpStatus: 200,
      streamed: true,
    });
  });
});
