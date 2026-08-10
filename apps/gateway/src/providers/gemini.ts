import { splitSystemMessages, mergeConsecutiveMessages } from "./messages.js";
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
  ChatMessage,
  ChatRequest,
  ChatResponse,
  FinishReason,
  ProviderCallOptions,
  ProviderCapabilities,
  TokenUsage,
} from "./types.js";

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
}

interface GeminiPart {
  readonly text?: string;
}

interface GeminiResponse {
  readonly responseId?: string;
  readonly modelVersion?: string;
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly GeminiPart[] };
    readonly finishReason?: string;
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
}

/**
 * Google Gemini (generateContent).
 *
 * The furthest from OpenAI's shape of the four: messages are `contents` with
 * `parts`, the assistant role is called `model`, the system prompt is a separate
 * `systemInstruction`, and sampling parameters live under `generationConfig`.
 * The model name goes in the URL path rather than the body.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = "gemini" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
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
      url: this.url(request.model, false),
      headers: this.headers(),
      body: this.buildBody(request),
      signal: options.signal,
      fetch: this.fetch,
    });

    const payload = await readJson<GeminiResponse>(response, this.id, request.model);
    const candidate = payload.candidates?.[0];

    return {
      id: payload.responseId ?? "",
      provider: this.id,
      model: payload.modelVersion ?? request.model,
      // `parts` is absent when generation was blocked by a safety filter, which
      // is a legitimate empty completion rather than a malformed response.
      content: joinParts(candidate?.content?.parts),
      finishReason: mapFinishReason(candidate?.finishReason),
      usage: usageFrom(payload),
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  async *stream(request: ChatRequest, options: ProviderCallOptions): AsyncIterable<ChatChunk> {
    const response = await postJson({
      provider: this.id,
      model: request.model,
      url: this.url(request.model, true),
      headers: this.headers(),
      body: this.buildBody(request),
      signal: options.signal,
      fetch: this.fetch,
    });

    const body = requireBody(response, this.id, request.model);

    let started = false;
    let finishReason: FinishReason = "unknown";
    let usage: TokenUsage | undefined;

    try {
      for await (const event of parseSSE(body)) {
        const payload = JSON.parse(event.data) as GeminiResponse;

        if (!started) {
          started = true;
          yield {
            type: "start",
            id: payload.responseId ?? "",
            provider: this.id,
            model: payload.modelVersion ?? request.model,
          };
        }

        const candidate = payload.candidates?.[0];
        const text = joinParts(candidate?.content?.parts);
        if (text.length > 0) yield { type: "delta", content: text };

        if (candidate?.finishReason !== undefined) {
          finishReason = mapFinishReason(candidate.finishReason);
        }
        // Gemini repeats cumulative usage on each event; the last one wins.
        const chunkUsage = usageFrom(payload);
        if (chunkUsage !== undefined) usage = chunkUsage;
      }
    } catch (error) {
      throw normalizeStreamError(error, this.id, request.model);
    }

    if (!started) {
      yield { type: "start", id: "", provider: this.id, model: request.model };
    }

    yield { type: "finish", finishReason, usage };
  }

  private headers(): Record<string, string> {
    // Header rather than the `?key=` query parameter Google's quickstarts show:
    // a key in a URL ends up in access logs, proxy logs, and error messages.
    return { "x-goog-api-key": this.apiKey };
  }

  private url(model: string, stream: boolean): string {
    const name = model.startsWith("models/") ? model.slice("models/".length) : model;
    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${this.baseUrl}/models/${encodeURIComponent(name)}:${method}`;
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const { system, conversation } = splitSystemMessages(request.messages);
    const messages = mergeConsecutiveMessages(conversation);

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig["temperature"] = request.temperature;
    if (request.topP !== undefined) generationConfig["topP"] = request.topP;
    if (request.maxOutputTokens !== undefined) {
      generationConfig["maxOutputTokens"] = request.maxOutputTokens;
    }
    if (request.stop !== undefined && request.stop.length > 0) {
      generationConfig["stopSequences"] = [...request.stop];
    }

    const body: Record<string, unknown> = {
      contents: messages.map((message) => ({
        role: geminiRole(message),
        parts: [{ text: message.content }],
      })),
    };

    if (system !== undefined) body["systemInstruction"] = { parts: [{ text: system }] };
    if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;

    return body;
  }
}

/** Gemini calls the assistant "model". */
function geminiRole(message: ChatMessage): string {
  return message.role === "assistant" ? "model" : "user";
}

function joinParts(parts: readonly GeminiPart[] | undefined): string {
  if (parts === undefined) return "";
  return parts.map((part) => part.text ?? "").join("");
}

export function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
      return "content_filter";
    default:
      return "unknown";
  }
}

function usageFrom(payload: GeminiResponse): TokenUsage | undefined {
  return createTokenUsage(
    payload.usageMetadata?.promptTokenCount,
    payload.usageMetadata?.candidatesTokenCount,
  );
}
