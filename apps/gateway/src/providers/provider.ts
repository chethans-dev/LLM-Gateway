import type { ProviderId } from "@openllm/core";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ProviderCallOptions,
  ProviderCapabilities,
} from "./types.js";

/**
 * The contract every provider implements.
 *
 * Nothing above this interface knows that OpenAI, Gemini, Anthropic or Ollama
 * exist. That is the point of the whole layer: the router picks a provider and
 * calls it, and adding a fifth provider changes no routing, retry, or
 * observability code (spec §3).
 *
 * Implementations MUST:
 *
 *  - Translate every failure into an `LLMError` with a normalized
 *    `LLMErrorCode`. Retry and fallback decisions are made from that code, so a
 *    provider that leaks a raw `fetch` TypeError makes itself unroutable.
 *  - Honour `options.signal` and stop work when it aborts.
 *  - Never log or embed credentials in errors.
 *  - Be stateless per call. One instance serves concurrent requests.
 */
export interface LLMProvider {
  readonly id: ProviderId;

  /** Single-shot completion. */
  chat(request: ChatRequest, options: ProviderCallOptions): Promise<ChatResponse>;

  /**
   * Streamed completion.
   *
   * Yields exactly one `start` chunk, then zero or more `delta` chunks, then
   * exactly one `finish` chunk. Errors are thrown from the iterator, so a
   * consumer's `for await` sees them as ordinary exceptions.
   *
   * Returning `AsyncIterable` rather than a Node stream keeps the contract
   * runtime-agnostic and makes consumption a plain `for await` loop with
   * automatic cleanup — when the consumer breaks out early, the generator's
   * `finally` runs and the upstream connection is closed.
   */
  stream(request: ChatRequest, options: ProviderCallOptions): AsyncIterable<ChatChunk>;

  /**
   * Static description of what this provider can do.
   *
   * Synchronous and cheap: it is read on hot paths (deciding whether a streaming
   * request can be served, deciding whether usage will be reported) and must
   * never make a network call. Dynamic facts — is the provider up right now,
   * which models are pulled into this Ollama — belong to health checks and
   * routing configuration, not here.
   */
  getCapabilities(): ProviderCapabilities;
}
