import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/http/server.js";
import type {
  ProviderStats,
  RequestDetail,
  RequestListItem,
  RequestRepository,
  StatsSummary,
} from "../../src/observability/request-repository.js";
import { createTestConfig, fakeLifecycle, silentLogger } from "../helpers/build-test-server.js";
import type { ApiKeyRepository } from "../../src/auth/api-key-repository.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const summary: StatsSummary = {
  totalRequests: 10,
  successfulRequests: 8,
  failedRequests: 2,
  successRate: 0.8,
  averageLatencyMs: 240,
  p95LatencyMs: 900,
  totalTokens: 5_000,
  inputTokens: 4_000,
  outputTokens: 1_000,
  estimatedCostUsd: 0.0123,
  requestsWithoutCost: 3,
  cachedRequests: 1,
};

const item: RequestListItem = {
  id: "2f1d6b6e-1f6b-4c1e-9a3a-9d5a2f5c6b7e",
  requestId: "req_abc",
  traceId: "tr_abc",
  createdAt: new Date("2026-08-01T12:00:00Z"),
  provider: "mock",
  model: "echo",
  requestedModel: "fast",
  status: "success",
  errorCode: null,
  httpStatus: 200,
  latencyMs: 42,
  totalTokens: 18,
  estimatedCostUsd: 0.000018,
  cached: false,
  streamed: false,
};

const detail: RequestDetail = {
  ...item,
  route: "fast",
  apiKeyId: null,
  providerCalls: 2,
  inputTokens: 12,
  outputTokens: 6,
};

const providers: ProviderStats[] = [
  {
    provider: "mock",
    requests: 10,
    successfulRequests: 8,
    averageLatencyMs: 240,
    totalTokens: 5_000,
    estimatedCostUsd: 0.0123,
  },
];

function fakeRepository(): RequestRepository {
  return {
    summary: async () => summary,
    byProvider: async () => providers,
    recent: async () => [item],
    find: async (id) => (id === item.id || id === item.requestId ? detail : undefined),
    byTrace: async () => [item],
  };
}

const noKeys: ApiKeyRepository = {
  findActiveByKey: async () => undefined,
  create: async () => {
    throw new Error("not used");
  },
  list: async () => [],
  revoke: async () => false,
  touch: () => {},
};

async function build(options: { adminApiKey?: string; dashboardApiKey?: string } = {}) {
  const config = createTestConfig({
    auth: {
      required: false,
      adminApiKey: options.adminApiKey,
      dashboardApiKey: options.dashboardApiKey,
    },
  });

  return buildServer({
    config,
    logger: silentLogger,
    lifecycle: fakeLifecycle("ready"),
    checks: [],
    version: "0.1.0-test",
    apiKeys: noKeys,
    requestRepository: fakeRepository(),
  });
}

const dashboard = { authorization: "Bearer dashboard-read-only-key-1234" };
const admin = { authorization: "Bearer admin-secret-value-1234567" };

describe("stats endpoints accept the read-only dashboard credential", () => {
  it("serves the summary", async () => {
    app = await build({ dashboardApiKey: "dashboard-read-only-key-1234" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/stats/summary?window=24h",
      headers: dashboard,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total_requests: 10,
      success_rate: 0.8,
      p95_latency_ms: 900,
      requests_without_cost: 3,
    });
  });

  it("also accepts the admin credential, for curl and scripts", async () => {
    app = await build({
      adminApiKey: "admin-secret-value-1234567",
      dashboardApiKey: "dashboard-read-only-key-1234",
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/stats/summary",
          headers: admin,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects a wrong credential", async () => {
    app = await build({ dashboardApiKey: "dashboard-read-only-key-1234" });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/stats/summary",
          headers: { authorization: "Bearer nope-nope-nope-nope" },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("the dashboard credential CANNOT mint keys", () => {
  it("is refused on key creation", async () => {
    // The whole reason the two credentials are separate: a browser app's key is
    // one XSS away from being someone else's, and this one's blast radius is
    // "can read request metadata".
    app = await build({
      adminApiKey: "admin-secret-value-1234567",
      dashboardApiKey: "dashboard-read-only-key-1234",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/keys",
      headers: dashboard,
      payload: { name: "should-not-work" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("is refused on key revocation", async () => {
    app = await build({
      adminApiKey: "admin-secret-value-1234567",
      dashboardApiKey: "dashboard-read-only-key-1234",
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/admin/keys/2f1d6b6e-1f6b-4c1e-9a3a-9d5a2f5c6b7e",
      headers: dashboard,
    });

    expect(response.statusCode).toBe(401);
  });

  it("is refused on listing keys", async () => {
    app = await build({
      adminApiKey: "admin-secret-value-1234567",
      dashboardApiKey: "dashboard-read-only-key-1234",
    });

    expect(
      (await app.inject({ method: "GET", url: "/v1/admin/keys", headers: dashboard })).statusCode,
    ).toBe(401);
  });
});

describe("stats payloads", () => {
  it("returns the provider breakdown", async () => {
    app = await build({ dashboardApiKey: "dashboard-read-only-key-1234" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/stats/providers",
      headers: dashboard,
    });

    expect(response.json().data[0]).toMatchObject({ provider: "mock", requests: 10 });
  });

  it("returns recent requests with no message content", async () => {
    // Nothing here can leak a prompt, because none is stored — spec §18's
    // requirement satisfied by construction rather than by a filter.
    app = await build({ dashboardApiKey: "dashboard-read-only-key-1234" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/requests?window=1h&limit=10",
      headers: dashboard,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).not.toContain("messages");
    expect(response.payload).not.toContain("\"content\"");
    expect(response.json().data[0]).toMatchObject({ request_id: "req_abc", provider: "mock" });
  });

  it("caps the page size", async () => {
    // An unbounded limit is a way to make the gateway read its whole history
    // into memory on somebody's behalf.
    app = await build({ dashboardApiKey: "dashboard-read-only-key-1234" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/requests?limit=100000",
      headers: dashboard,
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown window rather than silently defaulting", async () => {
    app = await build({ dashboardApiKey: "dashboard-read-only-key-1234" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/stats/summary?window=all-time",
      headers: dashboard,
    });

    expect(response.statusCode).toBe(400);
  });

  it("looks a request up by its req_ id as well as its uuid", async () => {
    // Operators quote the req_ from a client's error report; the UUID is what a
    // link carries. Accepting both means nobody has to care which they have.
    app = await build({ dashboardApiKey: "dashboard-read-only-key-1234" });

    for (const id of [item.id, item.requestId]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/admin/requests/${id}`,
        headers: dashboard,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().provider_calls).toBe(2);
    }
  });

  it("404s for an unknown request", async () => {
    app = await build({ dashboardApiKey: "dashboard-read-only-key-1234" });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/requests/req_missing",
          headers: dashboard,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("stats are disabled when no credential is configured", () => {
  it("404s rather than 401s, so the reason is obvious", async () => {
    app = await build({});

    const response = await app.inject({ method: "GET", url: "/v1/admin/stats/summary" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("DASHBOARD_API_KEY");
  });
});
