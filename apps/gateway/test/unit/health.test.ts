import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestServer, fakeCheck } from "../helpers/build-test-server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /health (liveness)", () => {
  it("returns 200 while serving traffic", async () => {
    app = await buildTestServer({ state: "ready" });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", state: "ready" });
  });

  it("returns 200 while still starting up", async () => {
    // A container that fails liveness during boot gets killed mid-boot.
    app = await buildTestServer({ state: "starting" });

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("returns 503 once draining", async () => {
    app = await buildTestServer({ state: "draining" });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "shutting_down" });
  });

  it("NEVER touches dependencies, even when every one of them is down", async () => {
    // This is the whole point of splitting liveness from readiness (decision D4).
    // If a Redis outage could fail liveness, the orchestrator would kill and
    // restart every instance, escalating a degradation into a total outage.
    const redis = fakeCheck("redis", "down");
    const postgres = fakeCheck("postgres", "down");
    app = await buildTestServer({ state: "ready", checks: [redis, postgres] });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(redis.calls()).toBe(0);
    expect(postgres.calls()).toBe(0);
  });
});

describe("GET /ready (readiness)", () => {
  it("returns 200 with per-dependency latencies when everything is up", async () => {
    app = await buildTestServer({ state: "ready" });

    const response = await app.inject({ method: "GET", url: "/ready" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.checks.redis.status).toBe("up");
    expect(body.checks.postgres.status).toBe("up");
    expect(typeof body.checks.redis.latencyMs).toBe("number");
  });

  it("returns 503 and names the failing dependency", async () => {
    app = await buildTestServer({
      state: "ready",
      checks: [fakeCheck("redis", "down"), fakeCheck("postgres", "up")],
    });

    const response = await app.inject({ method: "GET", url: "/ready" });
    const body = response.json();

    expect(response.statusCode).toBe(503);
    expect(body.status).toBe("not_ready");
    expect(body.checks.redis.status).toBe("down");
    expect(body.checks.redis.error).toContain("unreachable");
    // The healthy dependency is still reported — an operator needs to see which
    // one is actually broken, not just that something is.
    expect(body.checks.postgres.status).toBe("up");
  });

  it("times out a hanging dependency instead of hanging the probe", async () => {
    app = await buildTestServer({
      state: "ready",
      checks: [fakeCheck("postgres", "hang")],
      config: { readiness: { checkTimeoutMs: 30, cacheTtlMs: 0 } },
    });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json().checks.postgres.error).toContain("timed out");
  });

  it("returns 503 while draining even though dependencies are healthy", async () => {
    // This is what makes a rolling deploy zero-downtime: readiness fails first,
    // the load balancer stops routing, and only then does the server close.
    app = await buildTestServer({ state: "draining" });

    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
  });

  it("caches results so a polling load balancer does not hammer the database", async () => {
    const postgres = fakeCheck("postgres", "up");
    app = await buildTestServer({
      state: "ready",
      checks: [postgres],
      config: { readiness: { checkTimeoutMs: 50, cacheTtlMs: 5_000 } },
    });

    await app.inject({ method: "GET", url: "/ready" });
    await app.inject({ method: "GET", url: "/ready" });
    await app.inject({ method: "GET", url: "/ready" });

    expect(postgres.calls()).toBe(1);
  });

  it("re-checks once the cache window has elapsed", async () => {
    const postgres = fakeCheck("postgres", "up");
    app = await buildTestServer({
      state: "ready",
      checks: [postgres],
      config: { readiness: { checkTimeoutMs: 50, cacheTtlMs: 0 } },
    });

    await app.inject({ method: "GET", url: "/ready" });
    await app.inject({ method: "GET", url: "/ready" });

    expect(postgres.calls()).toBe(2);
  });
});

describe("correlation identifiers", () => {
  it("returns a request ID and a trace ID on every response", async () => {
    app = await buildTestServer();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["x-request-id"]).toMatch(/^req_/);
    expect(response.headers["x-trace-id"]).toMatch(/^tr_/);
  });

  it("adopts a caller-supplied trace ID so upstream traces stay joined", async () => {
    app = await buildTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-trace-id": "tr_caller_supplied" },
    });

    expect(response.headers["x-trace-id"]).toBe("tr_caller_supplied");
  });

  it("rejects a malformed trace ID rather than propagating it into logs", async () => {
    app = await buildTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-trace-id": "not a valid id!!" },
    });

    expect(response.headers["x-trace-id"]).toMatch(/^tr_/);
    expect(response.headers["x-trace-id"]).not.toBe("not a valid id!!");
  });

  it("gives each request a distinct request ID", async () => {
    app = await buildTestServer();

    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });

    expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"]);
  });
});

describe("error envelope", () => {
  it("returns an OpenAI-shaped error for an unknown route", async () => {
    app = await buildTestServer();

    const response = await app.inject({ method: "GET", url: "/nope" });
    const body = response.json();

    expect(response.statusCode).toBe(404);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.request_id).toMatch(/^req_/);
  });
});
