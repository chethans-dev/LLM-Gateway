import { LLMError } from "@openllm/core";
import { mergeConsecutiveMessages, splitSystemMessages } from "./messages.js";
import type { LLMProvider } from "./provider.js";
import { parseSSE } from "./stream-parsers.js";
import {
  normalizeStreamError,
  postJson,
  readJson,
  requireBody,
  type FetchLike,
} from "./transport.js";
import { createTokenUsage } from "./usage.js";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  FinishReason,
  ProviderCallOptions,
  ProviderCapabilities,
  TokenUsage,
} from "./types.js";

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly version: string;
  readonly fetch?: FetchLike;
  /** Anthropic requires max_tokens; this is used when the caller omitted it. */
  readonly defaultMaxOutputTokens?: number;
}

interface AnthropicMessageResponse {
  readonly id?: string;
  readonly model?: string;
  readonly stop_reason?: string | null;
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/**
 * Anthropic Messages API.
 *
 * Three shape differences from OpenAI that this adapter absorbs:
 *
 *  - The system prompt is a top-level `system` field, not a message.
 *  - `max_tokens` is REQUIRED, where every other provider treats it as optional.
 *  - Turns must alternate, so consecutive same-role messages are merged.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly fetch: FetchLike;
  private readonly defaultMaxOutputTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.version = options.version;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 4096;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      provider: this.id,
      streaming: true,
      systemPrompt: true,
      maxOutputTokens: undefined,
      usageReporting: { nonStreaming: true, streaming: true },
    };
  }

  async chat(request: ChatRequest, options: ProviderCallOptions): Promise<ChatResponse> {
    const response = await postJson({
      provider: this.id,
      model: request.model,
      url: `${this.baseUrl}/messages`,
      headers: this.headers(),
      body: this.buildBody(request, false),
      signal: options.signal,
      fetch: this.fetch,
    });

    const payload = await readJson<AnthropicMessageResponse>(response, this.id, request.model);

    // Content is an array of blocks; only text blocks are meaningful to us.
    const content = (payload.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    return {
      id: payload.id ?? "",
      provider: this.id,
      model: payload.model ?? request.model,
      content,
      finishReason: mapStopReason(payload.stop_reason),
      usage: createTokenUsage(payload.usage?.input_tokens, payload.usage?.output_tokens),
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  async *stream(request: ChatRequest, options: ProviderCallOptions): AsyncIterable<ChatChunk> {
    const response = await postJson({
      provider: this.id,
      model: request.model,
      url: `${this.baseUrl}/messages`,
      headers: this.headers(),
      body: this.buildBody(request, true),
      signal: options.signal,
      fetch: this.fetch,
    });

    const body = requireBody(response, this.id, request.model);

    let started = false;
    let finishReason: FinishReason = "unknown";
    // Anthropic splits usage across two events: input tokens arrive with
    // message_start, output tokens with message_delta at the end.
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      for await (const event of parseSSE(body)) {
        const payload = JSON.parse(event.data) as Record<string, unknown>;
        const type = (payload["type"] as string | undefined) ?? event.event;

        if (type === "error") {
          throw this.streamError(payload, request.model);
        }

        if (type === "message_start") {
          const message = payload["message"] as
            | { id?: string; model?: string; usage?: { input_tokens?: number } }
            | undefined;
          started = true;
          inputTokens = message?.usage?.input_tokens;
          yield {
            type: "start",
            id: message?.id ?? "",
            provider: this.id,
            model: message?.model ?? request.model,
          };
          continue;
        }

        if (type === "content_block_delta") {
          const delta = payload["delta"] as { type?: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
            yield { type: "delta", content: delta.text };
          }
          continue;
        }

        if (type === "message_delta") {
          const delta = payload["delta"] as { stop_reason?: string | null } | undefined;
          const usage = payload["usage"] as { output_tokens?: number } | undefined;
          if (delta?.stop_reason != null) finishReason = mapStopReason(delta.stop_reason);
          if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
        }
        // ping, content_block_start/stop and message_stop carry nothing we need.
      }
    } catch (error) {
      throw normalizeStreamError(error, this.id, request.model);
    }

    if (!started) {
      yield { type: "start", id: "", provider: this.id, model: request.model };
    }

    yield { type: "finish", finishReason, usage: usageFrom(inputTokens, outputTokens) };
  }

  private streamError(payload: Record<string, unknown>, model: string): LLMError {
    const error = payload["error"] as { type?: string; message?: string } | undefined;
    const message = error?.message ?? "anthropic reported a stream error";

    // Anthropic signals overload mid-stream; that is a retryable capacity
    // problem, not a malformed response.
    if (error?.type === "overloaded_error") {
      return LLMError.unavailable(message, { provider: this.id, model });
    }
    if (error?.type === "rate_limit_error") {
      return LLMError.rateLimited(message, { provider: this.id, model });
    }
    return LLMError.provider(message, { provider: this.id, model });
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": this.version,
    };
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const { system, conversation } = splitSystemMessages(request.messages);
    const messages = mergeConsecutiveMessages(conversation);

    const body: Record<string, unknown> = {
      model: request.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      // Required by the API. Defaulting rather than erroring keeps an
      // OpenAI-shaped request (where it is optional) working unchanged.
      max_tokens: request.maxOutputTokens ?? this.defaultMaxOutputTokens,
      stream,
    };

    if (system !== undefined) body["system"] = system;
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.topP !== undefined) body["top_p"] = request.topP;
    if (request.stop !== undefined && request.stop.length > 0) {
      body["stop_sequences"] = [...request.stop];
    }

    return body;
  }
}

export function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "unknown";
  }
}

function usageFrom(input: number | undefined, output: number | undefined): TokenUsage | undefined {
  return createTokenUsage(input, output);
}
