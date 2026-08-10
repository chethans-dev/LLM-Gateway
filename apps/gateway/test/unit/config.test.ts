import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.js";

const minimalEnv = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/openllm",
  REDIS_URL: "redis://localhost:6379",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("applies documented defaults when only required vars are present", () => {
    const config = loadConfig(minimalEnv);

    expect(config.env).toBe("development");
    expect(config.http.port).toBe(4000);
    expect(config.http.host).toBe("0.0.0.0");
    expect(config.http.bodyLimitBytes).toBe(1_048_576);
    expect(config.logging.level).toBe("info");
    expect(config.shutdown.drainMs).toBe(5_000);
    expect(config.shutdown.timeoutMs).toBe(15_000);
    expect(config.readiness.checkTimeoutMs).toBe(2_000);
  });

  it("coerces numeric strings, since every env var arrives as a string", () => {
    const config = loadConfig({ ...minimalEnv, PORT: "8080", SHUTDOWN_DRAIN_MS: "250" });

    expect(config.http.port).toBe(8080);
    expect(config.shutdown.drainMs).toBe(250);
  });

  it("reports EVERY invalid variable at once, not just the first", () => {
    // Fixing one bad var, redeploying, and discovering the next is a loop we
    // should never inflict on an operator.
    let thrown: unknown;
    try {
      loadConfig({ PORT: "not-a-number" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const issues = (thrown as ConfigError).issues.join("\n");
    expect(issues).toContain("DATABASE_URL");
    expect(issues).toContain("REDIS_URL");
    expect(issues).toContain("PORT");
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig({ ...minimalEnv, PORT: "70000" })).toThrow(ConfigError);
  });

  it("rejects an unknown log level rather than silently defaulting", () => {
    expect(() => loadConfig({ ...minimalEnv, LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });

  it("parses CORS origins, trimming whitespace and dropping empty entries", () => {
    const config = loadConfig({
      ...minimalEnv,
      CORS_ORIGINS: " https://app.example.com , https://admin.example.com ,, ",
    });

    expect(config.http.corsOrigins).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });

  it("treats an unset CORS_ORIGINS as 'CORS disabled', not 'allow everything'", () => {
    expect(loadConfig(minimalEnv).http.corsOrigins).toEqual([]);
  });

  it("marks production explicitly and turns off pretty logging there", () => {
    const config = loadConfig({ ...minimalEnv, NODE_ENV: "production" });

    expect(config.isProduction).toBe(true);
    expect(config.logging.pretty).toBe(false);
  });

  it("accepts provider keys but does not require any of them", () => {
    expect(() => loadConfig(minimalEnv)).not.toThrow();
  });
});

describe("blank environment variables", () => {
  // Regression: `.env.example` ships `OPENAI_API_KEY=`, and a compose env_file
  // produces an empty string for every key the operator has not filled in.
  // Rejecting those made following the quickstart a crash loop.
  it("treats a present-but-blank optional variable as unset", () => {
    const config = loadConfig({
      ...minimalEnv,
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "   ",
      ANTHROPIC_API_KEY: "",
      OLLAMA_BASE_URL: "",
    });

    expect(config.providers.openai.enabled).toBe(false);
    expect(config.providers.gemini.enabled).toBe(false);
    expect(config.providers.anthropic.enabled).toBe(false);
    expect(config.providers.ollama.enabled).toBe(false);
  });

  it("falls back to the default when a variable with a default is blank", () => {
    const config = loadConfig({ ...minimalEnv, PORT: "", OPENAI_BASE_URL: "" });

    expect(config.http.port).toBe(4000);
    expect(config.providers.openai.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("still rejects a blank REQUIRED variable, with an accurate message", () => {
    const error = (() => {
      try {
        loadConfig({ DATABASE_URL: "", REDIS_URL: "redis://localhost:6379" });
        return undefined;
      } catch (caught) {
        return caught as ConfigError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.issues.join("\n")).toContain("DATABASE_URL");
  });
});
