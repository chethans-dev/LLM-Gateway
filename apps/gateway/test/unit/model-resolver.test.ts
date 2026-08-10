import { describe, expect, it } from "vitest";
import { resolveModel } from "../../src/routing/model-resolver.js";
import { thrown } from "../helpers/expect-error.js";

describe("explicit provider/model prefix", () => {
  it("routes on a known provider prefix and strips it", () => {
    // The adapter receives the model as the provider itself knows it, so no
    // adapter has to understand our routing syntax.
    expect(resolveModel("openai/gpt-4.1-mini")).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
      source: "explicit-prefix",
    });
  });

  it("is the only way to reach Ollama, whose model names are arbitrary", () => {
    expect(resolveModel("ollama/qwen3")).toMatchObject({ provider: "ollama", model: "qwen3" });
  });

  it("splits on the first slash only, preserving namespaced model names", () => {
    // vLLM and friends serve models like `meta-llama/Llama-3-70B`.
    expect(resolveModel("openai/meta-llama/Llama-3-70B")).toMatchObject({
      provider: "openai",
      model: "meta-llama/Llama-3-70B",
    });
  });

  it("treats a non-provider prefix as part of the model name", () => {
    // `meta-llama/...` must not be read as a routing instruction — but with no
    // provider to attribute it to, it is unresolvable rather than misrouted.
    const error = thrown(() => resolveModel("meta-llama/Llama-3-70B"));

    expect(error.code).toBe("MODEL_NOT_FOUND");
  });
});

describe("known model-name prefixes", () => {
  const cases = [
    { model: "gpt-4.1-mini", provider: "openai" },
    { model: "gpt-5", provider: "openai" },
    { model: "chatgpt-4o-latest", provider: "openai" },
    { model: "o3-mini", provider: "openai" },
    { model: "claude-sonnet-4", provider: "anthropic" },
    { model: "gemini-2.5-flash", provider: "gemini" },
    { model: "mock", provider: "mock" },
  ] as const;

  for (const { model, provider } of cases) {
    it(`routes ${model} to ${provider}`, () => {
      // This is the compatibility promise: an unchanged OpenAI client sending
      // `gpt-4.1-mini` must just work.
      expect(resolveModel(model)).toMatchObject({ provider, model, source: "known-prefix" });
    });
  }

  it("matches case-insensitively", () => {
    expect(resolveModel("GPT-4.1-mini")).toMatchObject({ provider: "openai" });
  });
});

describe("unresolvable models", () => {
  it("refuses rather than guessing, and explains the qualified form", () => {
    // Guessing would send the request — and the money — to a provider the
    // caller never asked for.
    const error = thrown(() => resolveModel("llama3.2"));

    expect(error.code).toBe("MODEL_NOT_FOUND");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("ollama/llama3.2");
  });

  it("rejects an empty model", () => {
    expect(thrown(() => resolveModel("   ")).code).toBe("INVALID_REQUEST");
  });

  it("rejects a bare provider prefix with no model", () => {
    expect(thrown(() => resolveModel("openai/")).code).toBe("MODEL_NOT_FOUND");
  });
});
