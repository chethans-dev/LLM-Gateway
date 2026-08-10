import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/observability/logger.js";
import { createTestConfig } from "../helpers/build-test-server.js";

/**
 * Redaction, asserted rather than assumed.
 *
 * "Secrets are never logged" is claimed in the README, the architecture doc and
 * the plan, and it is the kind of guarantee that quietly stops being true the
 * first time someone reorders the pino options. Until now nothing checked it —
 * a coverage pass found this file at 0%.
 */
function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });

  const logger = createLogger(
    createTestConfig({ logging: { level: "info", pretty: false } }),
    stream,
  );

  return {
    logger,
    /** Everything written, as one string — the thing an attacker would grep. */
    output: () => lines.join(""),
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("logger redaction", () => {
  it("strips the Authorization header", async () => {
    const { logger, output } = captureLogs();

    logger.info(
      { req: { method: "POST", headers: { authorization: "Bearer olgm_live_SECRETVALUE" } } },
      "request",
    );

    expect(output()).not.toContain("olgm_live_SECRETVALUE");
    expect(output()).not.toContain("Bearer");
  });

  it("strips x-api-key", async () => {
    const { logger, output } = captureLogs();

    logger.info({ req: { headers: { "x-api-key": "olgm_live_ANOTHERSECRET" } } }, "request");

    expect(output()).not.toContain("olgm_live_ANOTHERSECRET");
  });

  it("strips cookies and proxy credentials", async () => {
    const { logger, output } = captureLogs();

    logger.info(
      {
        req: {
          headers: {
            cookie: "session=SECRETCOOKIE",
            "proxy-authorization": "Basic SECRETPROXY",
          },
        },
      },
      "request",
    );

    expect(output()).not.toContain("SECRETCOOKIE");
    expect(output()).not.toContain("SECRETPROXY");
  });

  it("strips credential-shaped fields wherever they appear", async () => {
    // The `*.` paths exist so a provider config object logged by accident does
    // not leak. This is the case that would otherwise slip through.
    const { logger, output } = captureLogs();

    logger.info({ provider: { apiKey: "sk-SECRETKEY", baseUrl: "https://api.example" } }, "config");
    logger.info({ nested: { api_key: "SECRETSNAKE" } }, "config");
    logger.info({ thing: { password: "SECRETPW", secret: "SECRETS", token: "SECRETTOKEN" } }, "x");

    expect(output()).not.toContain("sk-SECRETKEY");
    expect(output()).not.toContain("SECRETSNAKE");
    expect(output()).not.toContain("SECRETPW");
    expect(output()).not.toContain("SECRETS");
    expect(output()).not.toContain("SECRETTOKEN");
    // Non-secret context on the same object survives, or redaction would be
    // useless for debugging.
    expect(output()).toContain("https://api.example");
  });

  it("REMOVES credential fields rather than substituting a placeholder", async () => {
    // "[Redacted]" still confirms the field was present, and there is no
    // debugging value in knowing that an Authorization header existed.
    const { logger, output, parsed } = captureLogs();

    logger.info({ config: { apiKey: "sk-SECRET" } }, "config");

    expect(output()).not.toContain("Redacted");
    expect(parsed()[0]?.["config"]).not.toHaveProperty("apiKey");
  });

  it("has two independent defenses on request headers", async () => {
    // The `req` serializer keeps only method/url/userAgent, so headers never
    // reach the redaction stage at all — and the redaction paths still exist in
    // case something logs a raw request object outside that serializer.
    const { logger, parsed } = captureLogs();

    logger.info({ req: { method: "GET", headers: { authorization: "Bearer x" } } }, "request");

    expect(parsed()[0]?.["req"]).not.toHaveProperty("headers");
  });
});

describe("logger shape", () => {
  it("emits ISO timestamps rather than epoch milliseconds", () => {
    // A human reading `docker compose logs` should not have to convert in their head.
    const { logger, parsed } = captureLogs();

    logger.info({}, "hello");

    expect(String(parsed()[0]?.["time"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("labels the level by name, not by number", () => {
    const { logger, parsed } = captureLogs();

    logger.warn({}, "careful");

    expect(parsed()[0]?.["level"]).toBe("warn");
  });

  it("tags every line with the service and environment", () => {
    const { logger, parsed } = captureLogs();

    logger.info({}, "hello");

    expect(parsed()[0]).toMatchObject({ service: "openllm-gateway", env: "test" });
  });

  it("serializes requests small rather than dumping the whole object", () => {
    // Fastify's default attaches the entire request; that is how a body ends up
    // in a log line.
    const { logger, parsed } = captureLogs();

    logger.info(
      {
        req: {
          method: "POST",
          url: "/v1/chat/completions",
          headers: { "user-agent": "curl/8" },
          body: { messages: [{ content: "SENSITIVE" }] },
        },
      },
      "request",
    );

    const req = parsed()[0]?.["req"] as Record<string, unknown>;
    expect(req).toEqual({
      method: "POST",
      url: "/v1/chat/completions",
      userAgent: "curl/8",
    });
    expect(JSON.stringify(parsed()[0])).not.toContain("SENSITIVE");
  });
});
