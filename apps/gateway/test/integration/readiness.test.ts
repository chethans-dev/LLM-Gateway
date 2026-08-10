import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "../../src/config/index.js";
import { createPostgresClient, type PostgresClient } from "../../src/infra/postgres.js";
import { connectRedis, createRedisClient, type RedisClient } from "../../src/infra/redis.js";
import { buildServer } from "../../src/http/server.js";
import { fakeLifecycle, silentLogger } from "../helpers/build-test-server.js";

/**
 * Runs the real infra clients against the docker-compose Redis and Postgres.
 *
 * Skipped by default so `pnpm test` stays runnable with no Docker daemon:
 *   docker compose up -d postgres redis
 *   INTEGRATION_TESTS=1 pnpm test:integration
 */
const enabled = process.env["INTEGRATION_TESTS"] === "1";

describe.skipIf(!enabled)("readiness against real infrastructure", () => {
  let config: AppConfig;
  let postgres: PostgresClient;
  let redis: RedisClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    config = loadConfig({
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/openllm",
      REDIS_URL: process.env["REDIS_URL"] ?? "redis://localhost:6379",
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      READINESS_CACHE_MS: "0",
    });

    postgres = createPostgresClient(config, silentLogger);
    redis = createRedisClient(config, silentLogger);
    await connectRedis(redis, silentLogger);

    app = await buildServer({
      config,
      logger: silentLogger,
      lifecycle: fakeLifecycle("ready"),
      checks: [redis, postgres],
      version: "0.1.0-integration",
    });
  });

  afterAll(async () => {
    await app?.close();
    await redis?.close();
    await postgres?.close();
  });

  it("pings Postgres", async () => {
    await expect(postgres.ping(5_000)).resolves.toBeUndefined();
  });

  it("pings Redis", async () => {
    await expect(redis.ping(5_000)).resolves.toBeUndefined();
  });

  it("reports ready with both dependencies up", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.checks.postgres.status).toBe("up");
    expect(body.checks.redis.status).toBe("up");
  });

  it("returns 503 when pointed at a Postgres that is not there", async () => {
    const brokenConfig = loadConfig({
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/nope",
      REDIS_URL: config.redis.url,
      POSTGRES_CONNECTION_TIMEOUT_MS: "500",
      READINESS_CHECK_TIMEOUT_MS: "1000",
      READINESS_CACHE_MS: "0",
      LOG_LEVEL: "silent",
    });
    const brokenPostgres = createPostgresClient(brokenConfig, silentLogger);

    const brokenApp = await buildServer({
      config: brokenConfig,
      logger: silentLogger,
      lifecycle: fakeLifecycle("ready"),
      checks: [brokenPostgres],
      version: "0.1.0-integration",
    });

    try {
      const response = await brokenApp.inject({ method: "GET", url: "/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.json().checks.postgres.status).toBe("down");
    } finally {
      await brokenApp.close();
      await brokenPostgres.close();
    }
  });
});
