/**
 * Normalized internal error model (spec §23).
 *
 * Every provider translates its native failures into one of these codes. The
 * router depends on that normalization: retry and fallback decisions are made
 * from `retryable`, never from a provider's own status codes or message text.
 *
 * Phase 1 defines the taxonomy so the HTTP error handler has something concrete
 * to map. Providers begin producing these in Phase 3.
 */

export const LLM_ERROR_CODES = [
  "INVALID_REQUEST",
  "AUTHENTICATION_ERROR",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "TIMEOUT",
  "MODEL_NOT_FOUND",
  "UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type LLMErrorCode = (typeof LLM_ERROR_CODES)[number];

export interface ErrorCodeDescriptor {
  /** Status returned to the client when this error is terminal. */
  readonly httpStatus: number;
  /** `error.type` in the OpenAI-compatible error envelope. */
  readonly openAIType: string;
  /**
   * Whether retrying the SAME provider is worthwhile.
   *
   * Spec §8: do NOT retry every error. A malformed request fails identically on
   * every attempt, so retrying just multiplies latency and cost.
   */
  readonly retryable: boolean;
  /**
   * Whether trying a DIFFERENT provider is worthwhile.
   *
   * A deliberately separate axis from `retryable`, because the two questions
   * have genuinely different answers:
   *
   *  - `MODEL_NOT_FOUND` — retrying OpenAI for a model it does not have is
   *    pointless, but Anthropic may well have an equivalent. Not retryable,
   *    IS failoverable.
   *  - `AUTHENTICATION_ERROR` — our OpenAI key will not fix itself on a second
   *    attempt, but a Gemini key is a different credential entirely.
   *  - `INVALID_REQUEST` — a malformed body fails identically everywhere.
   *    Neither.
   *
   * Collapsing these into one flag forces a choice between failing requests that
   * a configured fallback could have served, and burning attempts on errors that
   * cannot improve.
   */
  readonly failoverable: boolean;
}

export const ERROR_CODE_DESCRIPTORS: Readonly<Record<LLMErrorCode, ErrorCodeDescriptor>> = {
  // Client's fault — identical failure everywhere. Neither axis applies.
  INVALID_REQUEST: {
    httpStatus: 400,
    openAIType: "invalid_request_error",
    retryable: false,
    failoverable: false,
  },
  // Our key for THIS provider is wrong. Another provider has its own credential,
  // so a configured fallback can still serve the request — the misconfiguration
  // is surfaced by a warning log rather than by failing the caller.
  AUTHENTICATION_ERROR: {
    httpStatus: 401,
    openAIType: "authentication_error",
    retryable: false,
    failoverable: true,
  },
  // Transient by definition; another provider very likely has capacity.
  RATE_LIMITED: {
    httpStatus: 429,
    openAIType: "rate_limit_error",
    retryable: true,
    failoverable: true,
  },
  // Provider-side 5xx. Transient often enough to be worth another attempt.
  PROVIDER_ERROR: {
    httpStatus: 502,
    openAIType: "server_error",
    retryable: true,
    failoverable: true,
  },
  // We gave up waiting. Hammering the same slow provider rarely helps; a
  // different one is the better move.
  TIMEOUT: { httpStatus: 504, openAIType: "server_error", retryable: false, failoverable: true },
  // Retrying the SAME provider for a model it does not have is pointless, but
  // another provider may well have an equivalent.
  MODEL_NOT_FOUND: {
    httpStatus: 404,
    openAIType: "invalid_request_error",
    retryable: false,
    failoverable: true,
  },
  // Provider unreachable: DNS, connection refused, circuit open.
  UNAVAILABLE: {
    httpStatus: 503,
    openAIType: "server_error",
    retryable: true,
    failoverable: true,
  },
  // Our own bug. It would fail the same way anywhere.
  INTERNAL_ERROR: {
    httpStatus: 500,
    openAIType: "server_error",
    retryable: false,
    failoverable: false,
  },
} as const;

export interface LLMErrorOptions {
  readonly message: string;
  readonly provider?: string;
  readonly model?: string;
  /** Overrides the code's default retryability (e.g. a TIMEOUT the router may retry). */
  readonly retryable?: boolean;
  /** Overrides whether a different provider should be tried for this failure. */
  readonly failoverable?: boolean;
  readonly httpStatus?: number;
  readonly cause?: unknown;
  /** Safe, non-sensitive context. Never put prompts or credentials here. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export class LLMError extends Error {
  override readonly name = "LLMError";
  readonly code: LLMErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly failoverable: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: LLMErrorCode, options: LLMErrorOptions) {
    super(
      options.message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    const descriptor = ERROR_CODE_DESCRIPTORS[code];
    this.code = code;
    this.httpStatus = options.httpStatus ?? descriptor.httpStatus;
    this.retryable = options.retryable ?? descriptor.retryable;
    this.failoverable = options.failoverable ?? descriptor.failoverable;
    this.provider = options.provider;
    this.model = options.model;
    this.details = options.details;
    Error.captureStackTrace?.(this, LLMError);
  }

  get openAIType(): string {
    return ERROR_CODE_DESCRIPTORS[this.code].openAIType;
  }

  static is(value: unknown): value is LLMError {
    return value instanceof LLMError;
  }

  static invalidRequest(message: string, options: Omit<LLMErrorOptions, "message"> = {}) {
    return new LLMError("INVALID_REQUEST", { ...options, message });
  }

  static authentication(message: string, options: Omit<LLMErrorOptions, "message"> = {}) {
    return new LLMError("AUTHENTICATION_ERROR", { ...options, message });
  }

  static rateLimited(message: string, options: Omit<LLMErrorOptions, "message"> = {}) {
    return new LLMError("RATE_LIMITED", { ...options, message });
  }

  static provider(message: string, options: Omit<LLMErrorOptions, "message"> = {}) {
    return new LLMError("PROVIDER_ERROR", { ...options, message });
  }

  static timeout(message: string, options: Omit<LLMErrorOptions, "message"> = {}) {
    return new LLMError("TIMEOUT", { ...options, message });
  }

  static modelNotFound(message: string, options: Omit<LLMErrorOptions, "message"> = {}) {
    return new LLMError("MODEL_NOT_FOUND", { ...options, message });
  }

  static unavailable(message: string, options: Omit<LLMErrorOptions, "message"> = {}) {
    return new LLMError("UNAVAILABLE", { ...options, message });
  }

  static internal(message: string, options: Omit<LLMErrorOptions, "message"> = {}) {
    return new LLMError("INTERNAL_ERROR", { ...options, message });
  }
}

/** OpenAI-compatible error envelope (spec §4). */
export interface OpenAIErrorEnvelope {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly code: LLMErrorCode;
    readonly request_id?: string;
  };
}

export function toOpenAIErrorEnvelope(error: LLMError, requestId?: string): OpenAIErrorEnvelope {
  return {
    error: {
      message: error.message,
      type: error.openAIType,
      code: error.code,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
    },
  };
}
