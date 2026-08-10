import { describe, expect, it } from "vitest";
import { thrown } from "../helpers/expect-error.js";
import { loadConfig } from "../../src/config/index.js";
import { createProviderRegistry } from "../../src/providers/registry.js";
import { silentLogger } from "../helpers/build-test-server.js";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost:5432/openllm",
  REDIS_URL: "redis://localhost:6379",
  LOG_LEVEL: "silent",
} satisfies NodeJS.ProcessEnv;

function registryFor(env: NodeJS.ProcessEnv) {
  return createProviderRegistry(loadConfig({ ...baseEnv, ...env }), silentLogger);
}

describe("provider enablement", () => {
  it("enables a provider when its credential is configured", () => {
    // "Configured" and "usable" must not drift apart — a provider enabled with
    // no way to authenticate is not a state worth being able to express.
    const registry = registryFor({ OPENAI_API_KEY: "sk-test" });

    expect(registry.has("openai")).toBe(true);
    expect(registry.get("openai")?.id).toBe("openai");
  });

  it("leaves a provider disabled when its credential is absent", () => {
    expect(registryFor({}).has("openai")).toBe(false);
    expect(registryFor({}).has("anthropic")).toBe(false);
    expect(registryFor({}).has("gemini")).toBe(false);
  });

  it("enables Ollama only when a base URL is set", () => {
    // Spec §19: Ollama is optional. A default base URL would enable it on every
    // machine and make provider health checks fail where it was never installed.
    expect(registryFor({}).has("ollama")).toBe(false);
    expect(registryFor({ OLLAMA_BASE_URL: "http://localhost:11434" }).has("ollama")).toBe(true);
  });

  it("enables the mock provider outside production", () => {
    expect(registryFor({ NODE_ENV: "development" }).has("mock")).toBe(true);
    expect(registryFor({ NODE_ENV: "test" }).has("mock")).toBe(true);
  });

  it("disables the mock provider in production by default", () => {
    // A mock silently reachable in production would let a misconfiguration
    // return fabricated completions to real users.
    expect(registryFor({ NODE_ENV: "production" }).has("mock")).toBe(false);
  });

  it("allows the mock provider to be turned on explicitly in production", () => {
    expect(
      registryFor({ NODE_ENV: "production", MOCK_PROVIDER_ENABLED: "true" }).has("mock"),
    ).toBe(true);
  });

  it("treats MOCK_PROVIDER_ENABLED=false as off, not as a truthy string", () => {
    // z.coerce.boolean() would make the string "false" become true.
    expect(registryFor({ NODE_ENV: "development", MOCK_PROVIDER_ENABLED: "false" }).has("mock")).toBe(
      false,
    );
  });

  it("lists exactly the enabled providers", () => {
    const registry = registryFor({
      NODE_ENV: "production",
      OPENAI_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });

    expect([...registry.enabledIds()].sort()).toEqual(["anthropic", "openai"]);
    expect(registry.list()).toHaveLength(2);
  });
});

describe("require()", () => {
  it("returns a configured provider", () => {
    const registry = registryFor({ OPENAI_API_KEY: "sk-test" });

    expect(registry.require("openai").id).toBe("openai");
  });

  it("fails with an actionable error naming the missing setting", () => {
    // From the caller's side the model genuinely is not available here, so 404
    // is the honest answer — and the operator should not have to read source to
    // find out which variable to set.
    const registry = registryFor({ NODE_ENV: "production" });

    const error = thrown(() => registry.require("gemini"));

    expect(error.code).toBe("MODEL_NOT_FOUND");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("GEMINI_API_KEY");
  });
});

describe("configuration hygiene", () => {
  it("strips a trailing slash from base URLs", () => {
    // Otherwise `${baseUrl}/chat/completions` becomes a double slash, which some
    // proxies 404 on.
    const config = loadConfig({ ...baseEnv, OPENAI_BASE_URL: "https://proxy.internal/v1/" });

    expect(config.providers.openai.baseUrl).toBe("https://proxy.internal/v1");
  });

  it("keeps provider base URLs overridable for OpenAI-compatible servers", () => {
    const config = loadConfig({ ...baseEnv, OPENAI_BASE_URL: "http://localhost:8000/v1" });

    expect(config.providers.openai.baseUrl).toBe("http://localhost:8000/v1");
  });

  it("rejects a failure rate outside 0..1", () => {
    expect(() => loadConfig({ ...baseEnv, MOCK_FAILURE_RATE: "2" })).toThrow();
  });
});
