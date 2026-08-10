import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createChatService } from "../../src/chat/chat-service.js";
import type {
  ApiKeyIdentity,
  ApiKeyRepository,
  ApiKeySummary,
  CreatedApiKey,
} from "../../src/auth/api-key-repository.js";
import { generateApiKey } from "../../src/auth/api-key.js";
import type { AppConfig } from "../../src/config/index.js";
import { buildServer } from "../../src/http/server.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { createTestConfig, fakeLifecycle, silentLogger } from "../helpers/build-test-server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** In-memory stand-in for the Postgres-backed repository. */
function fakeRepository(keys: { key: string; identity: ApiKeyIdentity }[] = []) {
  const touched: string[] = [];
  const revoked = new Set<string>();

  const repository: ApiKeyRepository = {
    findActiveByKey: async (raw) => {
      const match = keys.find((entry) => entry.key === raw);
      if (match === undefined || revoked.has(match.identity.id)) return undefined;
      return match.identity;
    },
    create: async (name) => {
      const generated = generateApiKey();
      // Real UUIDs: the admin route validates the id, and a fake that ignores
      // that would hide a genuine 400.
      const identity = { id: randomUUID(), name, keyPrefix: generated.keyPrefix };
      keys.push({ key: generated.key, identity });
      return {
        ...identity,
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastUsedAt: null,
        revokedAt: null,
        key: generated.key,
      } satisfies CreatedApiKey;
    },
    list: async () =>
      keys.map(
        (entry): ApiKeySummary => ({
          ...entry.identity,
          status: revoked.has(entry.identity.id) ? "revoked" : "active",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          lastUsedAt: null,
          revokedAt: null,
        }),
      ),
    revoke: async (id) => {
      if (revoked.has(id) || !keys.some((entry) => entry.identity.id === id)) return false;
      revoked.add(id);
      return true;
    },
    touch: (id) => touched.push(id),
  };

  return { repository, touched, revoked, keys };
}

async function buildAuthServer(options: {
  authRequired?: boolean;
  adminApiKey?: string | undefined;
  dashboardApiKey?: string | undefined;
  repository?: ApiKeyRepository;
}): Promise<FastifyInstance> {
  const config: AppConfig = createTestConfig({
    auth: {
      required: options.authRequired ?? true,
      adminApiKey: options.adminApiKey,
      dashboardApiKey: options.dashboardApiKey,
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
    apiKeys: options.repository ?? fakeRepository().repository,
  });
}

const chatBody = { model: "mock", messages: [{ role: "user", content: "hi" }] };

function chat(instance: FastifyInstance, headers: Record<string, string> = {}) {
  return instance.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: chatBody,
  });
}

describe("probe endpoints are always public", () => {
  it("serves /health and /ready without a credential", async () => {
    // An orchestrator cannot hold an API key. If liveness needed one, a
    // misconfigured secret would make Kubernetes kill every pod — an auth
    // problem escalated into a total outage.
    app = await buildAuthServer({ authRequired: true, adminApiKey: "admin-secret-value" });

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });

  it("ignores a query string when deciding what is public", async () => {
    app = await buildAuthServer({ authRequired: true });

    expect((await app.inject({ method: "GET", url: "/health?probe=1" })).statusCode).toBe(200);
  });
});

describe("API key authentication", () => {
  it("rejects a request with no credential", async () => {
    app = await buildAuthServer({ authRequired: true });

    const response = await chat(app);

    expect(response.statusCode).toBe(401);
    expect(response.json().error.type).toBe("authentication_error");
    expect(response.json().error.message).toContain("olgm_live_");
  });

  it("accepts a valid key via Authorization: Bearer", async () => {
    const fake = fakeRepository();
    const created = await fake.repository.create("test");
    app = await buildAuthServer({ authRequired: true, repository: fake.repository });

    const response = await chat(app, { authorization: `Bearer ${created.key}` });

    expect(response.statusCode).toBe(200);
  });

  it("accepts a valid key via x-api-key", async () => {
    const fake = fakeRepository();
    const created = await fake.repository.create("test");
    app = await buildAuthServer({ authRequired: true, repository: fake.repository });

    expect((await chat(app, { "x-api-key": created.key })).statusCode).toBe(200);
  });

  it("rejects an unknown key", async () => {
    app = await buildAuthServer({ authRequired: true });

    const response = await chat(app, { authorization: `Bearer ${generateApiKey().key}` });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a revoked key immediately", async () => {
    // No cache on the auth path, precisely so revocation takes effect now. One
    // indexed lookup is ~1ms against an LLM call measured in hundreds.
    const fake = fakeRepository();
    const created = await fake.repository.create("test");
    app = await buildAuthServer({ authRequired: true, repository: fake.repository });

    expect((await chat(app, { authorization: `Bearer ${created.key}` })).statusCode).toBe(200);

    await fake.repository.revoke(created.id);

    expect((await chat(app, { authorization: `Bearer ${created.key}` })).statusCode).toBe(401);
  });

  it("gives the same message for unknown and revoked keys", async () => {
    // Distinguishing them would confirm to an attacker that a value was once
    // valid. The distinction lives in the server-side logs.
    const fake = fakeRepository();
    const created = await fake.repository.create("test");
    app = await buildAuthServer({ authRequired: true, repository: fake.repository });
    await fake.repository.revoke(created.id);

    const revokedResponse = await chat(app, { authorization: `Bearer ${created.key}` });
    const unknownResponse = await chat(app, { authorization: `Bearer ${generateApiKey().key}` });

    expect(revokedResponse.json().error.message).toBe(unknownResponse.json().error.message);
  });

  it("does not query the database for a malformed credential", async () => {
    const fake = fakeRepository();
    const spy = vi.spyOn(fake.repository, "findActiveByKey");
    app = await buildAuthServer({ authRequired: true, repository: fake.repository });

    const response = await chat(app, { authorization: "Bearer hunter2" });

    expect(response.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("records usage without blocking the request", async () => {
    const fake = fakeRepository();
    const created = await fake.repository.create("test");
    app = await buildAuthServer({ authRequired: true, repository: fake.repository });

    await chat(app, { authorization: `Bearer ${created.key}` });

    expect(fake.touched).toEqual([created.id]);
  });

  it("serves requests unauthenticated when auth is disabled", async () => {
    app = await buildAuthServer({ authRequired: false });

    expect((await chat(app)).statusCode).toBe(200);
  });
});

describe("admin key management", () => {
  const admin = { authorization: "Bearer admin-secret-value" };

  it("404s when no admin secret is configured", async () => {
    // "Disabled" rather than "unauthorized" — an operator debugging a
    // credential they never set is a worse outcome than an honest 404.
    app = await buildAuthServer({ adminApiKey: undefined });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/keys",
      headers: admin,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("ADMIN_API_KEY");
  });

  it("rejects a missing or wrong admin secret", async () => {
    app = await buildAuthServer({ adminApiKey: "admin-secret-value" });

    expect((await app.inject({ method: "GET", url: "/v1/admin/keys" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/keys",
          headers: { authorization: "Bearer wrong-secret-value" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("does NOT accept a user API key for admin routes", async () => {
    // The two credentials are separate on purpose: the admin secret is
    // environment-only, so a database compromise cannot mint new keys.
    const fake = fakeRepository();
    const created = await fake.repository.create("test");
    app = await buildAuthServer({ adminApiKey: "admin-secret-value", repository: fake.repository });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/keys",
      headers: { authorization: `Bearer ${created.key}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns the raw key exactly once, at creation", async () => {
    const fake = fakeRepository();
    app = await buildAuthServer({ adminApiKey: "admin-secret-value", repository: fake.repository });

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/keys",
      headers: admin,
      payload: { name: "staging-backend" },
    });
    const body = created.json();

    expect(created.statusCode).toBe(201);
    expect(body.key).toMatch(/^olgm_live_/);
    expect(body.key_prefix).toBeTruthy();

    // ...and never again, from any other endpoint.
    const listed = await app.inject({ method: "GET", url: "/v1/admin/keys", headers: admin });
    expect(listed.payload).not.toContain(body.key);
    expect(listed.json().data[0]).not.toHaveProperty("key");
  });

  it("never exposes the stored hash", async () => {
    const fake = fakeRepository();
    app = await buildAuthServer({ adminApiKey: "admin-secret-value", repository: fake.repository });
    await app.inject({
      method: "POST",
      url: "/v1/admin/keys",
      headers: admin,
      payload: { name: "test" },
    });

    const listed = await app.inject({ method: "GET", url: "/v1/admin/keys", headers: admin });

    expect(listed.payload).not.toContain("key_hash");
    expect(listed.json().data[0]).not.toHaveProperty("key_hash");
  });

  it("revokes a key", async () => {
    const fake = fakeRepository();
    app = await buildAuthServer({ adminApiKey: "admin-secret-value", repository: fake.repository });
    const created = await fake.repository.create("test");

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/admin/keys/${created.id}`,
      headers: admin,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("revoked");
  });

  it("404s when revoking something that is not an active key", async () => {
    app = await buildAuthServer({ adminApiKey: "admin-secret-value" });

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/admin/keys/2f1d6b6e-1f6b-4c1e-9a3a-9d5a2f5c6b7e",
      headers: admin,
    });

    expect(response.statusCode).toBe(404);
  });

  it("validates the key name", async () => {
    app = await buildAuthServer({ adminApiKey: "admin-secret-value" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/keys",
      headers: admin,
      payload: { name: "" },
    });

    expect(response.statusCode).toBe(400);
  });
});
