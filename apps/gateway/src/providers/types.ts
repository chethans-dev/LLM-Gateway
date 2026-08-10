import type { ProviderId } from "@openllm/core";

/**
 * The gateway's internal, provider-neutral chat contract.
 *
 * This is deliberately NOT the OpenAI wire format, even though the public API
 * speaks it. The flow is:
 *
 *   OpenAI-shaped HTTP body → ChatRequest → provider-native format
 *   provider-native response → ChatResponse → OpenAI-shaped HTTP body
 *
 * Two round trips instead of passing the OpenAI body straight through. That is
 * worth it because:
 *
 *   1. Gemini and Anthropic are not shaped like OpenAI. Gemini uses
 *      `contents`/`parts`, Anthropic hoists the system prompt to a top-level
 *      field. If the OpenAI body were passed around directly, every adapter
 *      would re-parse it and re-derive the same facts.
 *   2. The router needs to reason about a request (which model, how many
 *      tokens, is it streaming) without knowing whose format it is in.
 *   3. It decouples us from OpenAI's API evolution. When they add a field we do
 *      not support, that is a normalization decision in one place, not a leak
 *      through the whole stack.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  /**
   * Text content.
   *
   * Multimodal content (image parts) is intentionally not modelled yet — no
   * provider adapter would consume it in Phase 3. Widening this to a parts array
   * later is an additive change to an internal type, so there is no cost to
   * waiting until something actually needs it.
   */
  readonly content: string;
}

export interface ChatRequest {
  /**
   * The model to serve this with — already resolved. Aliases and routing
   * strategies (Phase 6) are settled before a request reaches a provider, so an
   * adapter never has to ask "what does 'fast' mean".
   */
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  /**
   * Named for what it is rather than following any one provider. OpenAI calls
   * this `max_tokens` (now `max_completion_tokens`), Anthropic `max_tokens`,
   * Gemini `maxOutputTokens` — and OpenAI's original name is actively
   * misleading, since it never counted input tokens.
   */
  readonly maxOutputTokens?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];

  // Note: there is no `stream` flag. Streaming is expressed by calling
  // `stream()` instead of `chat()`. A boolean that changes a method's return
  // type is a design smell, and it would force every adapter to branch
  // internally on a field the caller has already decided.
}

export type FinishReason =
  /** The model stopped on its own, or hit a stop sequence. */
  | "stop"
  /** Output token limit reached — the response is truncated. */
  | "length"
  /** The provider's safety system intervened. */
  | "content_filter"
  /** The provider reported something we have no mapping for. */
  | "unknown";

// `tool_calls` arrives when tool support does. It is deliberately absent rather
// than present-and-unreachable.

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ChatResponse {
  /** The provider's own response identifier, for cross-referencing their logs. */
  readonly id: string;
  readonly provider: ProviderId;
  /**
   * The model that ACTUALLY served this request.
   *
   * Not necessarily what the client asked for: with aliases and fallback the
   * client may have requested `fast` and been served `gpt-4.1-mini` by the
   * second provider we tried. Cost attribution and debugging both depend on
   * recording what really happened.
   */
  readonly model: string;
  readonly content: string;
  readonly finishReason: FinishReason;
  /**
   * Absent when the provider did not report usage.
   *
   * Deliberately `undefined` rather than zeroes: reporting 0 tokens would make
   * Phase 9 silently understate cost, and spec §16 requires cost estimates to be
   * honest about their limits.
   */
  readonly usage: TokenUsage | undefined;
  /** Unix epoch seconds, matching the OpenAI response field. */
  readonly createdAt: number;
}

/**
 * One event in a streamed response.
 *
 * A discriminated union rather than OpenAI's flat delta object. The SSE
 * translation layer in Phase 5 becomes an exhaustive switch — and with
 * `noFallthroughCasesInSwitch` plus a `never` check, adding a variant later
 * fails the build until every consumer handles it.
 */
export type ChatChunk =
  /**
   * Always emitted first. Carries the facts that are only knowable once the
   * provider has accepted the request — chiefly which model actually served it,
   * which under fallback is not something the caller can predict.
   */
  | {
      readonly type: "start";
      readonly id: string;
      readonly provider: ProviderId;
      readonly model: string;
    }
  | { readonly type: "delta"; readonly content: string }
  /**
   * Always emitted last. Usage is frequently absent on streamed responses —
   * several providers only report token counts when explicitly asked, and some
   * not at all. `ProviderCapabilities.usageReporting.streaming` says which.
   */
  | {
      readonly type: "finish";
      readonly finishReason: FinishReason;
      readonly usage: TokenUsage | undefined;
    };

export interface ProviderCapabilities {
  readonly provider: ProviderId;
  readonly streaming: boolean;
  /**
   * Whether the provider has a first-class system prompt. Every provider we
   * target does, but a local model served through Ollama may not, in which case
   * the adapter folds the system prompt into the first user message.
   */
  readonly systemPrompt: boolean;
  /** Hard ceiling the provider enforces, when it publishes one. */
  readonly maxOutputTokens: number | undefined;
  /**
   * Whether token counts come back, split by call style.
   *
   * This is not trivia: it tells the observability layer (Phase 9) whether a
   * given request can produce a real cost figure or only an estimate, so the
   * dashboard can distinguish "this cost $0.004" from "we don't know".
   */
  readonly usageReporting: {
    readonly nonStreaming: boolean;
    readonly streaming: boolean;
  };
}

/**
 * Per-call options, separate from the request itself because they describe how
 * we call the provider rather than what we are asking for.
 */
export interface ProviderCallOptions {
  /**
   * Cancellation. REQUIRED, not optional — spec §10 says every provider request
   * must have a timeout, and making this optional would let a caller silently
   * omit one.
   *
   * An AbortSignal rather than wrapping the call in `Promise.race`: racing a
   * timer only abandons the promise, it does not stop the underlying HTTP
   * request, so the socket stays open and the tokens are still generated and
   * billed. A signal actually cancels. It is also how client disconnect is
   * propagated upstream in Phase 5 — when the browser goes away mid-stream, the
   * provider call should stop, not run to completion for nobody.
   */
  readonly signal: AbortSignal;
}
