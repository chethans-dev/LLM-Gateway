import { describe, expect, it } from "vitest";
import {
  ERROR_CODE_DESCRIPTORS,
  LLM_ERROR_CODES,
  LLMError,
  newRequestId,
  newTraceId,
  parseTraceId,
  toOpenAIErrorEnvelope,
} from "../src/index.js";

describe("error taxonomy", () => {
  it("describes every code", () => {
    for (const code of LLM_ERROR_CODES) {
      expect(ERROR_CODE_DESCRIPTORS[code]).toBeDefined();
    }
  });

  it("never marks a client-caused failure retryable", () => {
    // Spec §8: do not fall back on every error. A malformed request fails
    // identically on every provider, so retrying only multiplies latency and cost.
    expect(ERROR_CODE_DESCRIPTORS.INVALID_REQUEST.retryable).toBe(false);
    expect(ERROR_CODE_DESCRIPTORS.AUTHENTICATION_ERROR.retryable).toBe(false);
    expect(ERROR_CODE_DESCRIPTORS.MODEL_NOT_FOUND.retryable).toBe(false);
    expect(ERROR_CODE_DESCRIPTORS.INTERNAL_ERROR.retryable).toBe(false);
  });

  it("separates 'retry the same provider' from 'try a different one'", () => {
    // The two questions have genuinely different answers, and collapsing them
    // forces a choice between failing requests a fallback could have served and
    // burning attempts on errors that cannot improve.
    //
    // Retrying OpenAI for a model it does not have is pointless; Anthropic may
    // have an equivalent.
    expect(ERROR_CODE_DESCRIPTORS.MODEL_NOT_FOUND.retryable).toBe(false);
    expect(ERROR_CODE_DESCRIPTORS.MODEL_NOT_FOUND.failoverable).toBe(true);

    // Our OpenAI key will not fix itself, but a Gemini key is a different
    // credential entirely.
    expect(ERROR_CODE_DESCRIPTORS.AUTHENTICATION_ERROR.retryable).toBe(false);
    expect(ERROR_CODE_DESCRIPTORS.AUTHENTICATION_ERROR.failoverable).toBe(true);

    // Hammering a slow provider rarely helps; a different one might.
    expect(ERROR_CODE_DESCRIPTORS.TIMEOUT.retryable).toBe(false);
    expect(ERROR_CODE_DESCRIPTORS.TIMEOUT.failoverable).toBe(true);
  });

  it("never fails over on failures that are identical everywhere", () => {
    // A malformed body and our own bug fail the same way on every provider.
    expect(ERROR_CODE_DESCRIPTORS.INVALID_REQUEST.failoverable).toBe(false);
    expect(ERROR_CODE_DESCRIPTORS.INTERNAL_ERROR.failoverable).toBe(false);
  });

  it("describes both axes for every code", () => {
    for (const code of LLM_ERROR_CODES) {
      expect(typeof ERROR_CODE_DESCRIPTORS[code].retryable).toBe("boolean");
      expect(typeof ERROR_CODE_DESCRIPTORS[code].failoverable).toBe("boolean");
    }
  });

  it("lets a call site override failoverability", () => {
    expect(LLMError.invalidRequest("x", { failoverable: true }).failoverable).toBe(true);
  });

  it("marks transient provider-side failures retryable", () => {
    expect(ERROR_CODE_DESCRIPTORS.RATE_LIMITED.retryable).toBe(true);
    expect(ERROR_CODE_DESCRIPTORS.PROVIDER_ERROR.retryable).toBe(true);
    expect(ERROR_CODE_DESCRIPTORS.UNAVAILABLE.retryable).toBe(true);
  });

  it("takes retryability and status from the code by default", () => {
    const error = LLMError.rateLimited("slow down", { provider: "openai" });

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.httpStatus).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.provider).toBe("openai");
  });

  it("allows an explicit override for the cases that need one", () => {
    const error = LLMError.timeout("upstream stalled", { retryable: true });

    expect(error.retryable).toBe(true);
  });

  it("preserves the underlying cause without exposing it", () => {
    const cause = new Error("ECONNREFUSED");
    const error = LLMError.unavailable("provider unreachable", { cause });

    expect(error.cause).toBe(cause);
    expect(error.message).toBe("provider unreachable");
  });

  it("serializes to the OpenAI-compatible envelope", () => {
    const envelope = toOpenAIErrorEnvelope(LLMError.invalidRequest("bad model"), "req_abc");

    expect(envelope).toEqual({
      error: {
        message: "bad model",
        type: "invalid_request_error",
        code: "INVALID_REQUEST",
        request_id: "req_abc",
      },
    });
  });

  it("omits request_id when there is none rather than emitting null", () => {
    expect(toOpenAIErrorEnvelope(LLMError.internal("boom")).error).not.toHaveProperty("request_id");
  });

  it("identifies its own errors", () => {
    expect(LLMError.is(LLMError.internal("x"))).toBe(true);
    expect(LLMError.is(new Error("x"))).toBe(false);
  });
});

describe("correlation ids", () => {
  it("generates prefixed, unique identifiers", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));

    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
    expect(newTraceId()).toMatch(/^tr_/);
  });

  it("accepts a well-formed caller-supplied trace id", () => {
    expect(parseTraceId("tr_abc-123_XYZ")).toBe("tr_abc-123_XYZ");
  });

  it("rejects ids that could poison logs or downstream storage", () => {
    expect(parseTraceId(undefined)).toBeUndefined();
    expect(parseTraceId("")).toBeUndefined();
    expect(parseTraceId("has spaces")).toBeUndefined();
    expect(parseTraceId("newline\ninjection")).toBeUndefined();
    expect(parseTraceId("a".repeat(129))).toBeUndefined();
  });
});
