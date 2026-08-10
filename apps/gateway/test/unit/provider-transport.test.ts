import { describe, expect, it } from "vitest";
import { LLMError } from "@openllm/core";
import {
  errorCodeFromStatus,
  extractErrorMessage,
  normalizeFetchError,
  normalizeStreamError,
  parseRetryAfter,
  postJson,
} from "../../src/providers/transport.js";
import { rejection } from "../helpers/expect-error.js";
import { errorResponse, fakeFetch, jsonResponse } from "../helpers/fake-fetch.js";

describe("errorCodeFromStatus", () => {
  it("maps auth failures to a non-retryable code", () => {
    // Credentials do not become valid on the second attempt, and failing over
    // to another provider will not fix our own misconfiguration.
    for (const status of [401, 403]) {
      expect(errorCodeFromStatus(status)).toBe("AUTHENTICATION_ERROR");
      expect(new LLMError(errorCodeFromStatus(status), { message: "x" }).retryable).toBe(false);
    }
  });

  it("treats 404 as an unknown model", () => {
    // The paths are fixed and we build them ourselves, so a 404 from an LLM API
    // is about the model, not the route.
    expect(errorCodeFromStatus(404)).toBe("MODEL_NOT_FOUND");
  });

  it("maps 429 to a retryable rate limit", () => {
    expect(errorCodeFromStatus(429)).toBe("RATE_LIMITED");
    expect(new LLMError("RATE_LIMITED", { message: "x" }).retryable).toBe(true);
  });

  it("separates capacity signals from generic server errors", () => {
    // 502/503/504 mean "try somewhere else"; a bare 500 means the provider broke.
    expect(errorCodeFromStatus(502)).toBe("UNAVAILABLE");
    expect(errorCodeFromStatus(503)).toBe("UNAVAILABLE");
    expect(errorCodeFromStatus(504)).toBe("UNAVAILABLE");
    expect(errorCodeFromStatus(500)).toBe("PROVIDER_ERROR");
  });

  it("maps client errors to a non-retryable code", () => {
    expect(errorCodeFromStatus(400)).toBe("INVALID_REQUEST");
    expect(errorCodeFromStatus(422)).toBe("INVALID_REQUEST");
    expect(new LLMError("INVALID_REQUEST", { message: "x" }).retryable).toBe(false);
  });
});

describe("extractErrorMessage", () => {
  it("reads the OpenAI and Anthropic shape", () => {
    expect(extractErrorMessage(JSON.stringify({ error: { message: "Rate limit reached" } }))).toBe(
      "Rate limit reached",
    );
  });

  it("reads Ollama's bare string shape", () => {
    expect(extractErrorMessage(JSON.stringify({ error: "model not found" }))).toBe(
      "model not found",
    );
  });

  it("falls back to raw text when the body is not JSON", () => {
    expect(extractErrorMessage("502 Bad Gateway")).toBe("502 Bad Gateway");
  });

  it("returns undefined for an empty body", () => {
    expect(extractErrorMessage("   ")).toBeUndefined();
  });

  it("truncates long bodies", () => {
    // Provider error bodies can echo the prompt back; we must not paste an
    // unbounded amount of it into logs and client responses.
    const message = extractErrorMessage("x".repeat(5_000));

    expect(message).toBeDefined();
    expect(message!.length).toBeLessThanOrEqual(301);
    expect(message!.endsWith("…")).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
  });

  it("parses an HTTP date", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();

    expect(parseRetryAfter(future)).toBeGreaterThan(3_000);
  });

  it("returns undefined when absent or unparseable", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("normalizeFetchError", () => {
  it("maps an abort to TIMEOUT, not a provider error", () => {
    // Phase 7 applies a different policy to "we stopped waiting" than to
    // "the provider broke", so these must not collapse together.
    const abort = new Error("aborted");
    abort.name = "AbortError";

    expect(normalizeFetchError(abort, "openai", "gpt-4").code).toBe("TIMEOUT");
  });

  it("maps a timeout signal to TIMEOUT", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";

    expect(normalizeFetchError(timeout, "openai", "gpt-4").code).toBe("TIMEOUT");
  });

  it("maps a connection failure to a retryable UNAVAILABLE", () => {
    const error = normalizeFetchError(new TypeError("fetch failed"), "gemini", "flash");

    expect(error.code).toBe("UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.provider).toBe("gemini");
  });

  it("passes an already-normalized error straight through", () => {
    const original = LLMError.rateLimited("slow down");

    expect(normalizeFetchError(original, "openai", "gpt-4")).toBe(original);
  });
});

describe("normalizeStreamError", () => {
  it("treats malformed events as the provider's fault, not unreachability", () => {
    const error = normalizeStreamError(new SyntaxError("Unexpected token"), "openai", "gpt-4");

    expect(error.code).toBe("PROVIDER_ERROR");
  });

  it("treats a mid-stream disconnect as retryable", () => {
    expect(normalizeStreamError(new TypeError("terminated"), "openai", "gpt-4").code).toBe(
      "UNAVAILABLE",
    );
  });
});

describe("postJson", () => {
  it("sends JSON and returns the response", async () => {
    const http = fakeFetch(jsonResponse({ ok: true }));

    const response = await postJson({
      provider: "openai",
      model: "gpt-4",
      url: "https://example.test/v1/chat/completions",
      headers: { authorization: "Bearer sk-test" },
      body: { model: "gpt-4" },
      signal: new AbortController().signal,
      fetch: http.fetch,
    });

    expect(response.status).toBe(200);
    expect(http.lastCall().headers["content-type"]).toBe("application/json");
    expect(http.lastCall().body).toEqual({ model: "gpt-4" });
  });

  it("throws a normalized error on a non-OK status, with the provider's message", async () => {
    const http = fakeFetch(
      errorResponse({ error: { message: "Rate limit reached for gpt-4" } }, 429, {
        "retry-after": "3",
      }),
    );

    const error = await rejection(
      postJson({
        provider: "openai",
        model: "gpt-4",
        url: "https://example.test/v1/chat/completions",
        headers: {},
        body: {},
        signal: new AbortController().signal,
        fetch: http.fetch,
      }),
    );

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("Rate limit reached for gpt-4");
    // Phase 7 should prefer the provider's own backoff hint over guessing.
    expect(error.details).toMatchObject({ status: 429, retryAfterMs: 3_000 });
  });

  it("normalizes a thrown network failure", async () => {
    const http = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(
      postJson({
        provider: "ollama",
        model: "qwen3",
        url: "http://localhost:11434/api/chat",
        headers: {},
        body: {},
        signal: new AbortController().signal,
        fetch: http.fetch,
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
