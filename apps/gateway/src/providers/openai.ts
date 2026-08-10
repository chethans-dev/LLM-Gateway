import { LLMError } from "@openllm/core";
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

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: FetchLike;
}

interface OpenAIUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
}

interface OpenAIChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly created?: number;
  readonly usage?: OpenAIUsage;
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
}

interface OpenAIStreamChunk {
  readonly id?: string;
  readonly model?: string;
  readonly usage?: OpenAIUsage | null;
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
}

/**
 * OpenAI Chat Completions.
 *
 * Also the adapter to point at any OpenAI-compatible server (vLLM, LM Studio,
 * Together, an internal proxy) by overriding `OPENAI_BASE_URL` — which is why
 * the base URL is configuration rather than a constant.
 */
export class OpenAIProvider implements LLMProvider {
  readonly id = "openai" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(options: OpenAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  getCapabilities(): ProviderCapabilities {
    return {
      provider: this.id,
      streaming: true,
      // OpenAI carries the system prompt inside the message array, so this
      // adapter is the one that does NOT need splitSystemMessages.
      systemPrompt: true,
      maxOutputTokens: undefined,
      usageReporting: {
        nonStreaming: true,
        // Only because we send stream_options.include_usage below. Without it
        // OpenAI streams no usage at all and cost would be unknowable.
        streaming: true,
      },
    };
  }

  async chat(request: ChatRequest, options: ProviderCallOptions): Promise<ChatResponse> {
    const response = await postJson({
      provider: this.id,
      model: request.model,
      url: `${this.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: this.buildBody(request, false),
      signal: options.signal,
      fetch: this.fetch,
    });

    const payload = await readJson<OpenAIChatResponse>(response, this.id, request.model);
    const choice = payload.choices?.[0];

    if (choice === undefined) {
      throw LLMError.provider("openai returned no choices", {
        provider: this.id,
        model: request.model,
      });
    }

    return {
      id: payload.id ?? "",
      provider: this.id,
      model: payload.model ?? request.model,
      content: choice.message?.content ?? "",
      finishReason: mapFinishReason(choice.finish_reason),
      usage: usageFrom(payload.usage),
      createdAt: payload.created ?? Math.floor(Date.now() / 1000),
    };
  }

  async *stream(request: ChatRequest, options: ProviderCallOptions): AsyncIterable<ChatChunk> {
    const response = await postJson({
      provider: this.id,
      model: request.model,
      url: `${this.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: this.buildBody(request, true),
      signal: options.signal,
      fetch: this.fetch,
    });

    const body = requireBody(response, this.id, request.model);

    let started = false;
    let finishReason: FinishReason = "unknown";
    let usage: TokenUsage | undefined;

    try {
      for await (const event of parseSSE(body)) {
        // OpenAI's sentinel. Not JSON, so it must be checked before parsing.
        if (event.data === "[DONE]") break;

        const chunk = JSON.parse(event.data) as OpenAIStreamChunk;

        if (!started) {
          started = true;
          yield {
            type: "start",
            id: chunk.id ?? "",
            provider: this.id,
            model: chunk.model ?? request.model,
          };
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield { type: "delta", content: delta };
        }

        if (choice?.finish_reason != null) {
          finishReason = mapFinishReason(choice.finish_reason);
        }

        // Arrives in a final chunk whose `choices` array is empty.
        if (chunk.usage != null) usage = usageFrom(chunk.usage);
      }
    } catch (error) {
      throw normalizeStreamError(error, this.id, request.model);
    }

    // Contract: exactly one start, even if the provider sent nothing usable.
    if (!started) {
      yield { type: "start", id: "", provider: this.id, model: request.model };
    }

    yield { type: "finish", finishReason, usage };
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream,
    };

    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.topP !== undefined) body["top_p"] = request.topP;
    if (request.stop !== undefined && request.stop.length > 0) body["stop"] = [...request.stop];
    // `max_completion_tokens`, not the older `max_tokens`: OpenAI rejects
    // `max_tokens` outright on reasoning models, and the old name was always
    // misleading since it never counted input tokens.
    if (request.maxOutputTokens !== undefined) {
      body["max_completion_tokens"] = request.maxOutputTokens;
    }
    // Without this OpenAI reports no usage on streamed responses, and every
    // streamed request becomes uncosted.
    if (stream) body["stream_options"] = { include_usage: true };

    return body;
  }
}

export function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

function usageFrom(usage: OpenAIUsage | null | undefined): TokenUsage | undefined {
  if (usage == null) return undefined;
  return createTokenUsage(usage.prompt_tokens, usage.completion_tokens);
}
