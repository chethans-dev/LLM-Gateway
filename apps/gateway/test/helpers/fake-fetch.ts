import type { FetchLike } from "../../src/providers/transport.js";

/**
 * Test doubles for the provider transport.
 *
 * Every adapter takes its `fetch` by injection, so the whole Phase 3 suite runs
 * with no network and no API keys — spec §21 requires a contributor with no
 * provider accounts to be able to run everything.
 */

export interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** The parsed JSON request body, for asserting the translation was correct. */
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
  /** Convenience for the common single-call assertion. */
  lastCall(): RecordedCall;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

export function fakeFetch(responder: Responder | Response): FakeFetch {
  const calls: RecordedCall[] = [];

  const respond: Responder = typeof responder === "function" ? responder : () => responder;

  const fetch: FetchLike = async (url, init) => {
    const call: RecordedCall = {
      url,
      headers: normalizeHeaders(init.headers),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    return respond(call);
  };

  return {
    fetch,
    calls,
    lastCall() {
      const call = calls[calls.length - 1];
      if (call === undefined) throw new Error("fetch was never called");
      return call;
    },
  };
}

function normalizeHeaders(headers: RequestInit["headers"]): Record<string, string> {
  if (headers === undefined) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

/**
 * A response whose body arrives as the given raw chunks.
 *
 * Chunks are enqueued exactly as written, so a test can deliberately split a
 * line — or a multi-byte character — across a boundary and prove the parser
 * reassembles it.
 */
export function chunkedResponse(chunks: readonly (string | Uint8Array)[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });

  return new Response(stream, { status });
}

/** The raw byte stream, for testing the parsers directly. */
export function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const body = chunkedResponse(chunks).body;
  if (body === null) throw new Error("expected a response body");
  return body;
}

/** SSE response from a list of `data:` payloads, each properly terminated. */
export function sseResponse(events: readonly string[]): Response {
  return chunkedResponse(events.map((data) => `data: ${data}\n\n`));
}

/** SSE response with explicit `event:` names (Anthropic's framing). */
export function namedSseResponse(events: readonly { event: string; data: string }[]): Response {
  return chunkedResponse(events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n\n`));
}

export function ndjsonResponse(lines: readonly unknown[]): Response {
  return chunkedResponse(lines.map((line) => `${JSON.stringify(line)}\n`));
}

export function neverAbortedOptions(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}
