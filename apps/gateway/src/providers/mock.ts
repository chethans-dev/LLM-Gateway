import { LLMError } from "@openllm/core";
import type { LLMProvider } from "./provider.js";
import { abortableSleep, MAX_TIMEOUT_MS } from "../infra/sleep.js";
import { normalizeFetchError } from "./transport.js";
import { splitSystemMessages } from "./messages.js";
import { createTokenUsage } from "./usage.js";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ProviderCallOptions,
  ProviderCapabilities,
} from "./types.js";

/**
 * Deterministic provider for testing (spec §17).
 *
 * This is the most heavily used provider in the repository. Retry backoff,
 * fallback ordering, timeout handling, streaming teardown and rate limiting all
 * need to be provable against failures that occur *on demand* — waiting for a
 * real provider to rate-limit you is not a test strategy, and paying for tokens
 * to assert a 429 is worse.
 *
 * Two ways to drive it:
 *
 *  - **Per-request, via the model name.** `mock/rate-limited` fails with a 429,
 *    `mock/timeout` hangs until aborted, and so on. This is what makes
 *    end-to-end fallback tests readable — the scenario is visible in the request
 *    rather than buried in setup.
 *  - **Globally, via options.** `failureRate` and `latencyMs` (spec §17) for
 *    soak-testing behaviour under intermittent failure.
 */
export const MOCK_BEHAVIOURS = [
  "success",
  /** Returns the last user message as the completion. */
  "echo",
  "rate-limited",
  "server-error",
  "unavailable",
  /** Non-retryable: proves the router does NOT fail over on client errors. */
  "invalid",
  "auth-error",
  "model-not-found",
  /** Never responds. Resolves only when the call is aborted. */
  "timeout",
] as const;

export type MockBehaviour = (typeof MOCK_BEHAVIOURS)[number];

export interface MockProviderOptions {
  /** Delay before responding. Applied to both chat and the first stream chunk. */
  readonly latencyMs?: number;
  /** Probability (0–1) that any given call fails with a retryable error. */
  readonly failureRate?: number;
  /** Delay between streamed chunks, for exercising incremental flushing. */
  readonly chunkDelayMs?: number;
  readonly responseText?: string;
  /** Injected so `failureRate` is deterministic under test. */
  readonly random?: () => number;
  /** Injected so tests do not spend real time. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_RESPONSE =
  "This is a mock completion produced by the OpenLLM Gateway mock provider.";

export class MockProvider implements LLMProvider {
  readonly id = "mock" as const;

  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly chunkDelayMs: number;
  private readonly responseText: string;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: MockProviderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.failureRate = options.failureRate ?? 0;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.responseText = options.responseText ?? DEFAULT_RESPONSE;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? abortableSleep;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      provider: this.id,
      streaming: true,
      systemPrompt: true,
      maxOutputTokens: 4096,
      usageReporting: { nonStreaming: true, streaming: true },
    };
  }

  async chat(request: ChatRequest, options: ProviderCallOptions): Promise<ChatResponse> {
    const behaviour = parseBehaviour(request.model);
    await this.simulate(behaviour, request.model, options);

    const content = this.contentFor(behaviour, request);

    return {
      id: `mock_${Date.now().toString(36)}`,
      provider: this.id,
      model: request.model,
      content,
      finishReason: "stop",
      usage: estimateUsage(request, content),
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  async *stream(
    request: ChatRequest,
    options: ProviderCallOptions,
  ): AsyncIterable<ChatChunk> {
    const behaviour = parseBehaviour(request.model);
    // Failures surface before the first chunk, matching real providers: an
    // upstream 429 arrives as a response status, not mid-stream.
    await this.simulate(behaviour, request.model, options);

    const content = this.contentFor(behaviour, request);

    yield {
      type: "start",
      id: `mock_${Date.now().toString(36)}`,
      provider: this.id,
      model: request.model,
    };

    for (const piece of tokenize(content)) {
      options.signal.throwIfAborted();
      if (this.chunkDelayMs > 0) await this.sleep(this.chunkDelayMs, options.signal);
      yield { type: "delta", content: piece };
    }

    yield { type: "finish", finishReason: "stop", usage: estimateUsage(request, content) };
  }

  private contentFor(behaviour: MockBehaviour, request: ChatRequest): string {
    if (behaviour !== "echo") return this.responseText;

    const { conversation } = splitSystemMessages(request.messages);
    const lastUser = [...conversation].reverse().find((message) => message.role === "user");
    return lastUser?.content ?? this.responseText;
  }

  /** Apply configured latency, then the behaviour's failure mode. */
  private async simulate(
    behaviour: MockBehaviour,
    model: string,
    options: ProviderCallOptions,
  ): Promise<void> {
    options.signal.throwIfAborted();

    if (behaviour === "timeout") {
      // Waits until the caller's timeout or client disconnect aborts us —
      // which is exactly the condition Phase 7's timeout policy must handle.
      try {
        await this.sleep(MAX_TIMEOUT_MS, options.signal);
      } catch (error) {
        throw normalizeFetchError(error, this.id, model);
      }
    }

    if (this.latencyMs > 0) {
      try {
        await this.sleep(this.latencyMs, options.signal);
      } catch (error) {
        throw normalizeFetchError(error, this.id, model);
      }
    }

    const failure = failureFor(behaviour);
    if (failure !== undefined) throw failure(model);

    if (this.failureRate > 0 && this.random() < this.failureRate) {
      throw LLMError.provider("mock provider injected a random failure", {
        provider: this.id,
        model,
        details: { injected: true },
      });
    }
  }
}

function failureFor(behaviour: MockBehaviour): ((model: string) => LLMError) | undefined {
  switch (behaviour) {
    case "rate-limited":
      return (model) =>
        LLMError.rateLimited("mock provider is rate limited", {
          provider: "mock",
          model,
          details: { status: 429, retryAfterMs: 1_000 },
        });
    case "server-error":
      return (model) =>
        LLMError.provider("mock provider returned an internal error", {
          provider: "mock",
          model,
          details: { status: 500 },
        });
    case "unavailable":
      return (model) =>
        LLMError.unavailable("mock provider is unavailable", { provider: "mock", model });
    case "invalid":
      return (model) =>
        LLMError.invalidRequest("mock provider rejected the request", { provider: "mock", model });
    case "auth-error":
      return (model) =>
        LLMError.authentication("mock provider rejected the credentials", {
          provider: "mock",
          model,
        });
    case "model-not-found":
      return (model) =>
        LLMError.modelNotFound(`mock provider has no model '${model}'`, {
          provider: "mock",
          model,
        });
    case "success":
    case "echo":
    case "timeout":
      return undefined;
  }
}

/**
 * `mock/rate-limited` → `rate-limited`.
 *
 * Accepts the bare form too (`rate-limited`), because the model resolver strips
 * the `mock/` prefix before handing the name to this provider — the adapter
 * receives the model as the provider itself knows it.
 *
 * An unrecognised name is treated as an ordinary model, so `mock/llama3`
 * succeeds rather than erroring on a name that only looks like a typo.
 */
export function parseBehaviour(model: string): MockBehaviour {
  const slash = model.lastIndexOf("/");
  const name = slash === -1 ? model : model.slice(slash + 1);

  return (MOCK_BEHAVIOURS as readonly string[]).includes(name)
    ? (name as MockBehaviour)
    : "success";
}

/**
 * Rough character-based token estimate.
 *
 * Deliberately not a real tokenizer: the mock exists to give the observability
 * and cost layers plausible non-zero numbers to work with, not to be accurate.
 */
function estimateUsage(request: ChatRequest, content: string) {
  const inputChars = request.messages.reduce((sum, message) => sum + message.content.length, 0);
  return createTokenUsage(Math.ceil(inputChars / 4), Math.ceil(content.length / 4));
}

/** Split into word-ish pieces so streamed output looks like real token deltas. */
function tokenize(content: string): string[] {
  return content.match(/\S+\s*/g) ?? (content.length > 0 ? [content] : []);
}
