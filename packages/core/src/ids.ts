import { randomBytes } from "node:crypto";

/**
 * Correlation identifiers.
 *
 * `requestId` identifies a single inbound HTTP request to this gateway.
 * `traceId` identifies a logical operation that may span several requests or
 * hops; when a caller supplies one we adopt it, so their trace and ours join up.
 *
 * Both are branded so a TraceId can never be passed where a RequestId belongs.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RequestId = Brand<string, "RequestId">;
export type TraceId = Brand<string, "TraceId">;

/** 16 URL-safe characters: ~96 bits of entropy, short enough to eyeball in a log. */
function randomSuffix(): string {
  return randomBytes(12).toString("base64url");
}

export function newRequestId(): RequestId {
  return `req_${randomSuffix()}` as RequestId;
}

export function newTraceId(): TraceId {
  return `tr_${randomSuffix()}` as TraceId;
}

/**
 * Adopt a caller-supplied trace ID. Length-capped and character-restricted
 * because this value reaches logs and (from Phase 9) the database — an
 * unbounded header is an injection and log-flooding vector.
 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseTraceId(value: string | undefined): TraceId | undefined {
  if (value === undefined || !TRACE_ID_PATTERN.test(value)) return undefined;
  return value as TraceId;
}
