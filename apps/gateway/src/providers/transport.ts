import { LLMError, type LLMErrorCode, type ProviderId } from "@openllm/core";

/**
 * The `fetch` a provider uses, injected rather than imported.
 *
 * Every adapter takes one of these. That is what lets the entire Phase 3 test
 * suite run with no API keys and no network: tests hand in a function returning
 * canned `Response` objects, and the adapter cannot tell the difference. Spec §21
 * requires the suite to be runnable by a contributor with no accounts anywhere.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Provider error bodies can echo prompt content back. Cap what we propagate. */
const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * Map an HTTP status onto the normalized error taxonomy.
 *
 * This is the single most important function in the provider layer: the router's
 * retry and fallback decisions (Phase 6, 7) read `retryable` off the resulting
 * code. Getting 429 wrong here means either hammering a rate-limited provider or
 * failing over on an error that would fail identically everywhere.
 */
export function errorCodeFromStatus(status: number): LLMErrorCode {
  if (status === 401 || status === 403) return "AUTHENTICATION_ERROR";
  // For an LLM API a 404 is nearly always an unknown model rather than a bad
  // path — the paths are fixed and we build them ourselves.
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 408) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  // 502/503/504 are load-balancer and capacity signals: another provider very
  // likely has room, so these stay distinct from a generic 500.
  if (status === 502 || status === 503 || status === 504) return "UNAVAILABLE";
  if (status >= 500) return "PROVIDER_ERROR";
  if (status >= 400) return "INVALID_REQUEST";
  return "PROVIDER_ERROR";
}

/**
 * Turn a thrown `fetch` rejection into a normalized error.
 *
 * A provider that lets a raw `TypeError: fetch failed` escape makes itself
 * unroutable — the router has no `retryable` flag to make a decision from.
 */
export function normalizeFetchError(error: unknown, provider: ProviderId, model: string): LLMError {
  if (LLMError.is(error)) return error;

  if (error instanceof Error) {
    // AbortSignal.timeout() aborts with a TimeoutError; an explicit
    // controller.abort() gives an AbortError. Both mean "we stopped waiting",
    // and both must be distinguishable from a provider 500 so that Phase 7
    // applies the timeout policy rather than the server-error policy.
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new LLMError("TIMEOUT", {
        message: `${provider} request was aborted before completing`,
        provider,
        model,
        cause: error,
      });
    }

    // DNS failure, connection refused, TLS failure, socket hang up.
    return new LLMError("UNAVAILABLE", {
      message: `${provider} is unreachable: ${error.message}`,
      provider,
      model,
      cause: error,
    });
  }

  return new LLMError("PROVIDER_ERROR", {
    message: `${provider} request failed`,
    provider,
    model,
    cause: error,
  });
}

/**
 * Best-effort extraction of a human-readable message from an error body.
 *
 * Providers disagree on shape: OpenAI and Anthropic use `{ error: { message } }`,
 * Gemini `{ error: { message } }` nested under a status object, Ollama a bare
 * `{ error: "..." }`. Rather than four parsers, probe the handful of shapes and
 * fall back to the raw text.
 */
export function extractErrorMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return truncate(trimmed);
  }

  const candidate = findMessage(parsed);
  return truncate(candidate ?? trimmed);
}

function findMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  if (typeof record["message"] === "string") return record["message"];
  if (record["error"] !== undefined) return findMessage(record["error"]);
  if (typeof record["detail"] === "string") return record["detail"];
  return undefined;
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : text;
}

export interface ProviderRequest {
  readonly provider: ProviderId;
  readonly model: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly fetch: FetchLike;
}

/**
 * POST JSON to a provider and return the raw response, with every failure mode
 * already normalized into an `LLMError`.
 *
 * Returns the `Response` rather than parsed JSON because streaming adapters need
 * the body as a stream. Non-OK responses never reach the caller.
 */
export async function postJson(request: ProviderRequest): Promise<Response> {
  let response: Response;

  try {
    response = await request.fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
  } catch (error) {
    throw normalizeFetchError(error, request.provider, request.model);
  }

  if (!response.ok) {
    throw await toProviderError(response, request.provider, request.model);
  }

  return response;
}

export async function toProviderError(
  response: Response,
  provider: ProviderId,
  model: string,
): Promise<LLMError> {
  let detail: string | undefined;
  try {
    detail = extractErrorMessage(await response.text());
  } catch {
    // A body we cannot read must not mask the status we already have.
    detail = undefined;
  }

  const code = errorCodeFromStatus(response.status);
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));

  return new LLMError(code, {
    message: detail ?? `${provider} returned HTTP ${response.status}`,
    provider,
    model,
    // Surfaced for Phase 7: when a provider tells us how long to wait, honouring
    // it beats our own exponential backoff guess.
    details: retryAfter === undefined ? { status: response.status } : { status: response.status, retryAfterMs: retryAfter },
  });
}

/**
 * Parse a JSON response body, normalizing malformed payloads.
 *
 * A provider that returns 200 with unparseable JSON is broken in a way distinct
 * from being unreachable, and the distinction changes the retry decision.
 */
export async function readJson<T>(
  response: Response,
  provider: ProviderId,
  model: string,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new LLMError("PROVIDER_ERROR", {
      message: `${provider} returned a malformed JSON response`,
      provider,
      model,
      cause: error,
    });
  }
}

/**
 * Normalize a failure raised while consuming a stream.
 *
 * Distinct from `normalizeFetchError` because the failure modes differ once the
 * response has started: a `SyntaxError` here means the provider sent us a
 * malformed event (their bug, PROVIDER_ERROR), whereas the same generic
 * treatment applied to a connection attempt would mean unreachable.
 */
export function normalizeStreamError(error: unknown, provider: ProviderId, model: string): LLMError {
  if (LLMError.is(error)) return error;

  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new LLMError("TIMEOUT", {
        message: `${provider} stream was aborted before completing`,
        provider,
        model,
        cause: error,
      });
    }

    if (error instanceof SyntaxError) {
      return new LLMError("PROVIDER_ERROR", {
        message: `${provider} sent a malformed stream event`,
        provider,
        model,
        cause: error,
      });
    }

    // Connection dropped part-way through the response.
    return new LLMError("UNAVAILABLE", {
      message: `${provider} stream failed: ${error.message}`,
      provider,
      model,
      cause: error,
    });
  }

  return new LLMError("PROVIDER_ERROR", {
    message: `${provider} stream failed`,
    provider,
    model,
    cause: error,
  });
}

/**
 * A streaming response must have a body. A 200 with a null body is a protocol
 * violation, and failing loudly beats yielding an empty completion.
 */
export function requireBody(
  response: Response,
  provider: ProviderId,
  model: string,
): ReadableStream<Uint8Array> {
  if (response.body === null) {
    throw new LLMError("PROVIDER_ERROR", {
      message: `${provider} returned a streaming response with no body`,
      provider,
      model,
    });
  }
  return response.body;
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, date - Date.now());
}
