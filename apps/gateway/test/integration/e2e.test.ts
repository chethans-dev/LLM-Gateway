import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createApiKeyRepository } from "../../src/auth/api-key-repository.js";
import { createChatService } from "../../src/chat/chat-service.js";
import { loadConfig, type AppConfig } from "../../src/config/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { buildServer } from "../../src/http/server.js";
import { createActiveStreams } from "../../src/http/active-streams.js";
import { createPostgresClient, type PostgresClient } from "../../src/infra/postgres.js";
import { connectRedis, createRedisClient, type RedisClient } from "../../src/infra/redis.js";
import { createRequestRecorder } from "../../src/observability/request-recorder.js";
import { createRequestRepository } from "../../src/observability/request-repository.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createRedisKeys } from "../../src/redis/keys.js";
import { createRateLimiter } from "../../src/redis/rate-limiter.js";
import { silentLogger } from "../helpers/build-test-server.js";

/**
 * End-to-end over a REAL socket (spec §21).
 *
 * Every other suite uses `app.inject()`, which is fast and hermetic but skips
 * the HTTP stack entirely: no sockets, no keep-alive, no incremental flushing,
 * no client that can hang up. That gap is not theoretical — the Phase 5
 * disconnect bug passed 251 injected tests and only appeared once bytes crossed
 * a real connection.
 *
 * So this suite starts the server on a real port and drives it with `fetch`,
 * against real Postgres and Redis, through the mock provider:
 *
 *     fetch → HTTP → gateway → router → MockProvider → OpenAI-shaped response
 *
 *   docker compose up -d postgres redis
 *   INTEGRATION_TESTS=1 pnpm test:integration
 *
 * No provider API key is involved at any point.
 */
const enabled = process.env["INTEGRATION_TESTS"] === "1";

const ADMIN_KEY = "e2e-admin-secret-key-000000";
const DASHBOARD_KEY = "e2e-dashboard-read-key-0000";
const KEY_NAME = "itest-e2e-key";

describe.skipIf(!enabled)("end-to-end over real HTTP", () => {
  let app: FastifyInstance;
  let postgres: PostgresClient;
  let redis: RedisClient;
  let baseUrl: string;
  let apiKey: string;
  let config: AppConfig;

  beforeAll(async () => {
    config = loadConfig({
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/openllm",
      REDIS_URL: process.env["REDIS_URL"] ?? "redis://localhost:6379",
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MOCK_PROVIDER_ENABLED: "true",
      MOCK_CHUNK_DELAY_MS: "40",
      AUTH_REQUIRED: "true",
      ADMIN_API_KEY: ADMIN_KEY,
      DASHBOARD_API_KEY: DASHBOARD_KEY,
      REDIS_KEY_PREFIX: "openllm-e2e",
      RATE_LIMIT_REQUESTS_PER_MINUTE: "1000",
      REQUEST_RECORDING_FLUSH_MS: "100",
      READINESS_CACHE_MS: "0",
    });

    postgres = createPostgresClient(config, silentLogger);
    redis = createRedisClient(config, silentLogger);
    await connectRedis(redis, silentLogger);
    await runMigrations(postgres.db, silentLogger);
    // Deliberately does NOT clear the requests table. Its assertions are
    // "greater than zero", so pre-existing rows are harmless — and a blanket
    // delete would stomp on the other integration suites, or on real data if
    // DATABASE_URL ever pointed somewhere that mattered.

    const apiKeys = createApiKeyRepository({ db: postgres.db, logger: silentLogger });
    const registry = createProviderRegistry(config, silentLogger);
    const keys = createRedisKeys(config.redis.keyPrefix);

    app = await buildServer({
      config,
      logger: silentLogger,
      lifecycle: { getState: () => "ready" },
      checks: [redis, postgres],
      version: "0.1.0-e2e",
      chatService: createChatService({ registry, config }),
      activeStreams: createActiveStreams(),
      apiKeys,
      rateLimiter: createRateLimiter({
        redis: redis.redis,
        keys,
        policy: { requestsPerMinute: 1_000, burst: 1_000 },
        logger: silentLogger,
      }),
      recorder: createRequestRecorder({
        db: postgres.db,
        logger: silentLogger,
        flushIntervalMs: 100,
      }),
      requestRepository: createRequestRepository(postgres.db),
    });

    // Port 0: the OS picks a free one, so parallel CI jobs cannot collide.
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await apiKeys.create(KEY_NAME);
    apiKey = created.key;
  });

  afterAll(async () => {
    await app?.close();
    // Only the key this suite minted.
    await postgres?.db.execute(sql`delete from api_keys where name = ${KEY_NAME}`);
    await redis?.close();
    await postgres?.close();
  });

  const authHeaders = () => ({
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  });

  async function chat(body: Record<string, unknown>, headers?: Record<string, string>) {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers ?? authHeaders(),
      body: JSON.stringify(body),
    });
  }

  describe("the compatibility promise", () => {
    it("returns an OpenAI-shaped completion over the wire", async () => {
      const response = await chat({
        model: "mock/echo",
        messages: [{ role: "user", content: "over a real socket" }],
      });
      const body = (await response.json()) as {
        object: string;
        choices: { message: { role: string; content: string }; finish_reason: string }[];
        usage: { total_tokens: number };
      };

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0]?.message.role).toBe("assistant");
      expect(body.choices[0]?.message.content).toBe("over a real socket");
      expect(body.usage.total_tokens).toBeGreaterThan(0);
    });

    it("carries correlation and routing headers", async () => {
      const response = await chat({ model: "mock", messages: [{ role: "user", content: "hi" }] });

      expect(response.headers.get("x-request-id")).toMatch(/^req_/);
      expect(response.headers.get("x-trace-id")).toMatch(/^tr_/);
      expect(response.headers.get("x-openllm-provider")).toBe("mock");
      expect(response.headers.get("x-ratelimit-limit-requests")).toBe("1000");
    });

    it("adopts a caller-supplied trace id across the real transport", async () => {
      const response = await chat(
        { model: "mock", messages: [{ role: "user", content: "hi" }] },
        { ...authHeaders(), "x-trace-id": "tr_e2e_supplied" },
      );

      expect(response.headers.get("x-trace-id")).toBe("tr_e2e_supplied");
    });
  });

  describe("authentication over the wire", () => {
    it("rejects an unauthenticated request", async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hi" }] }),
      });

      expect(response.status).toBe(401);
    });

    it("serves probes without a credential", async () => {
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/ready`)).status).toBe(200);
    });
  });

  describe("streaming over a real connection", () => {
    /** Read an SSE body incrementally, recording when each event arrived. */
    async function readStream(response: Response) {
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("no body");

      const decoder = new TextDecoder();
      const events: { data: string; atMs: number }[] = [];
      const startedAt = Date.now();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith("data: ")) {
            events.push({ data: block.slice(6), atMs: Date.now() - startedAt });
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      return events;
    }

    it("delivers chunks INCREMENTALLY, not as one buffered blob", async () => {
      // The property `inject()` cannot demonstrate: with a 40ms inter-chunk
      // delay, a buffering bug anywhere in the stack collapses these arrival
      // times to roughly identical values.
      const response = await chat({
        model: "mock/echo",
        stream: true,
        messages: [{ role: "user", content: "one two three four five" }],
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-accel-buffering")).toBe("no");

      const events = await readStream(response);
      const contentEvents = events.filter((event) => event.data !== "[DONE]");

      expect(events[events.length - 1]?.data).toBe("[DONE]");
      expect(contentEvents.length).toBeGreaterThan(3);

      const spread =
        (contentEvents[contentEvents.length - 1]?.atMs ?? 0) - (contentEvents[0]?.atMs ?? 0);
      expect(spread).toBeGreaterThan(60);
    });

    it("reassembles to exactly the completion", async () => {
      const response = await chat({
        model: "mock/echo",
        stream: true,
        messages: [{ role: "user", content: "reassembled exactly" }],
      });

      const text = (await readStream(response))
        .filter((event) => event.data !== "[DONE]")
        .map((event) => JSON.parse(event.data) as { choices: { delta: { content?: string } }[] })
        .map((chunk) => chunk.choices[0]?.delta.content ?? "")
        .join("");

      expect(text).toBe("reassembled exactly");
    });

    it("returns a real status code when the provider fails before streaming", async () => {
      // Not a 200 whose body contains an error — the whole point of pulling the
      // first chunk before committing.
      const response = await chat({
        model: "mock/rate-limited",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toContain("application/json");
    });

    it("survives a client hanging up mid-stream", async () => {
      // The exact scenario the Phase 5 bug broke, now automated: a real socket
      // closing early must abort the upstream call and leave the gateway healthy.
      const controller = new AbortController();

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: "mock/echo",
          stream: true,
          messages: [{ role: "user", content: "a b c d e f g h i j k l" }],
        }),
      });

      const reader = response.body?.getReader();
      await reader?.read();
      controller.abort();
      await reader?.cancel().catch(() => {});

      // The gateway must still be serving.
      const after = await chat({ model: "mock", messages: [{ role: "user", content: "still up" }] });
      expect(after.status).toBe(200);
    });
  });

  describe("errors over the wire", () => {
    it("returns the OpenAI error envelope with the request id", async () => {
      const response = await chat({ model: "mock/invalid", messages: [{ role: "user", content: "x" }] });
      const body = (await response.json()) as {
        error: { message: string; type: string; code: string; request_id: string };
      };

      expect(response.status).toBe(400);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("INVALID_REQUEST");
      expect(body.error.request_id).toMatch(/^req_/);
    });

    it("rejects a malformed body", async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: "{not json",
      });

      expect(response.status).toBe(400);
    });
  });

  describe("the full loop: request in, statistics out", () => {
    it("persists what happened and serves it back through the stats API", async () => {
      // Everything since Phase 1 in one assertion path: HTTP → auth → rate limit
      // → routing → provider → recording → aggregation → dashboard API.
      await chat({ model: "mock/echo", messages: [{ role: "user", content: "loop closes here" }] });

      // The recorder buffers; give it more than one flush interval.
      await new Promise((resolve) => setTimeout(resolve, 400));

      const summary = await fetch(`${baseUrl}/v1/admin/stats/summary?window=1h`, {
        headers: { authorization: `Bearer ${DASHBOARD_KEY}` },
      });
      const body = (await summary.json()) as { total_requests: number; success_rate: number | null };

      expect(summary.status).toBe(200);
      expect(body.total_requests).toBeGreaterThan(0);
      expect(body.success_rate).not.toBeNull();

      const recent = await fetch(`${baseUrl}/v1/admin/requests?window=1h&limit=50`, {
        headers: { authorization: `Bearer ${DASHBOARD_KEY}` },
      });
      const payload = await recent.text();

      expect(recent.status).toBe(200);
      // The privacy guarantee, asserted against a live database rather than a fake.
      expect(payload).not.toContain("loop closes here");
    });

    it("refuses to mint a key with the dashboard credential", async () => {
      const response = await fetch(`${baseUrl}/v1/admin/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${DASHBOARD_KEY}` },
        body: JSON.stringify({ name: "should-not-work" }),
      });

      expect(response.status).toBe(401);
    });
  });
});
