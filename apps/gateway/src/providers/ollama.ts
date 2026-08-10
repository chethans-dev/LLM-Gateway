import type { LLMProvider } from "./provider.js";
import { parseNdjson } from "./stream-parsers.js";
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

export interface OllamaProviderOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
}

interface OllamaChatResponse {
  readonly model?: string;
  readonly created_at?: string;
  readonly message?: { readonly content?: string };
  readonly done?: boolean;
  readonly done_reason?: string;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

/**
 * Ollama, for locally hosted models.
 *
 * Two differences from the hosted providers:
 *
 *  - **No authentication.** Ollama binds to localhost and has no key. That is
 *    also why it is enabled only when `OLLAMA_BASE_URL` is explicitly set —
 *    there is no credential whose presence could imply intent.
 *  - **Streams newline-delimited JSON, not SSE.** Same chunk-boundary problem,
 *    different framing; `parseNdjson` handles it over the shared line reader.
 */
export class OllamaProvider implements LLMProvider {
  readonly id = "ollama" as const;

  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  getCapabilities(): ProviderCapabilities {
    return {
      provider: this.id,
      streaming: true,
      // Ollama passes a system role straight through to the model's template.
      systemPrompt: true,
      maxOutputTokens: undefined,
      usageReporting: { nonStreaming: true, streaming: true },
    };
  }

  async chat(request: ChatRequest, options: ProviderCallOptions): Promise<ChatResponse> {
    const response = await postJson({
      provider: this.id,
      model: request.model,
      url: `${this.baseUrl}/api/chat`,
      headers: {},
      body: this.buildBody(request, false),
      signal: options.signal,
      fetch: this.fetch,
    });

    const payload = await readJson<OllamaChatResponse>(response, this.id, request.model);

    return {
      // Ollama issues no response id, so there is nothing honest to put here.
      id: "",
      provider: this.id,
      model: payload.model ?? request.model,
      content: payload.message?.content ?? "",
      finishReason: mapDoneReason(payload.done_reason),
      usage: usageFrom(payload),
      createdAt: parseCreatedAt(payload.created_at),
    };
  }

  async *stream(request: ChatRequest, options: ProviderCallOptions): AsyncIterable<ChatChunk> {
    const response = await postJson({
      provider: this.id,
      model: request.model,
      url: `${this.baseUrl}/api/chat`,
      headers: {},
      body: this.buildBody(request, true),
      signal: options.signal,
      fetch: this.fetch,
    });

    const body = requireBody(response, this.id, request.model);

    let started = false;
    let finishReason: FinishReason = "unknown";
    let usage: TokenUsage | undefined;

    try {
      for await (const line of parseNdjson(body)) {
        const payload = line as OllamaChatResponse;

        if (!started) {
          started = true;
          yield {
            type: "start",
            id: "",
            provider: this.id,
            model: payload.model ?? request.model,
          };
        }

        const delta = payload.message?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield { type: "delta", content: delta };
        }

        // The final line carries done: true plus the token counts.
        if (payload.done === true) {
          finishReason = mapDoneReason(payload.done_reason);
          usage = usageFrom(payload);
        }
      }
    } catch (error) {
      throw normalizeStreamError(error, this.id, request.model);
    }

    if (!started) {
      yield { type: "start", id: "", provider: this.id, model: request.model };
    }

    yield { type: "finish", finishReason, usage };
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const modelOptions: Record<string, unknown> = {};
    if (request.temperature !== undefined) modelOptions["temperature"] = request.temperature;
    if (request.topP !== undefined) modelOptions["top_p"] = request.topP;
    if (request.maxOutputTokens !== undefined) {
      modelOptions["num_predict"] = request.maxOutputTokens;
    }
    if (request.stop !== undefined && request.stop.length > 0) {
      modelOptions["stop"] = [...request.stop];
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream,
    };

    if (Object.keys(modelOptions).length > 0) body["options"] = modelOptions;

    return body;
  }
}

export function mapDoneReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    default:
      return "unknown";
  }
}

function usageFrom(payload: OllamaChatResponse): TokenUsage | undefined {
  return createTokenUsage(payload.prompt_eval_count, payload.eval_count);
}

function parseCreatedAt(value: string | undefined): number {
  if (value === undefined) return Math.floor(Date.now() / 1000);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000);
}
