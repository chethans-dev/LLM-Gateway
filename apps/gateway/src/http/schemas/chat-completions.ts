import { LLMError } from "@openllm/core";
import { z } from "zod";
import type { ChatMessage, ChatRequest, ChatResponse } from "../../providers/types.js";

/**
 * The OpenAI-compatible wire contract for `POST /v1/chat/completions`.
 *
 * This is the boundary where an OpenAI-shaped body becomes our internal
 * `ChatRequest`, and a `ChatResponse` becomes an OpenAI-shaped body. Nothing
 * below this file knows what OpenAI's JSON looks like.
 */

/** OpenAI renamed `system` to `developer`; both must work. */
const roleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);

const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * `content` is a string or an array of parts.
 *
 * Text parts are accepted and joined — a client sending the array form for
 * plain text should not be rejected just because it chose the richer encoding.
 * Image and audio parts are refused explicitly rather than silently dropped,
 * because a silently text-only answer to a question about an image is worse
 * than an error.
 */
const contentSchema = z.union([z.string(), z.array(textPartSchema).min(1)]);

const messageSchema = z.object({
  role: roleSchema,
  content: contentSchema,
  name: z.string().optional(),
});

/**
 * Unknown fields are ignored rather than rejected.
 *
 * Real OpenAI SDKs send `user`, `seed`, `presence_penalty`, `logit_bias` and
 * more. Rejecting them would break the "change only your baseURL" promise for
 * clients that are doing nothing wrong.
 *
 * But a handful of fields cannot be ignored safely: silently dropping `tools`
 * or `response_format` produces a confidently wrong answer, which is worse than
 * a clear 400. Those are validated explicitly below.
 */
export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    stream: z.boolean().optional(),
    // OpenAI only emits a usage chunk when explicitly asked. We mirror that
    // rather than always sending one: a client parsing chunks positionally
    // should not receive an extra event it never requested.
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .optional(),
    n: z.number().int().optional(),
  })
  .loose();

export type ChatCompletionRequestBody = z.infer<typeof chatCompletionRequestSchema>;

/**
 * Features we do not implement yet, refused loudly.
 *
 * Each of these changes what a correct answer looks like, so quietly proceeding
 * without them would return output the caller would reasonably treat as valid.
 */
export function assertSupported(body: ChatCompletionRequestBody): void {
  if (body.n !== undefined && body.n !== 1) {
    throw LLMError.invalidRequest(
      "Only n=1 is supported. This gateway returns a single choice per request.",
    );
  }

  if ("tools" in body || "functions" in body || "tool_choice" in body) {
    throw LLMError.invalidRequest(
      "Tool and function calling are not supported yet. Remove 'tools'/'functions' from the request.",
    );
  }

  if ("response_format" in body) {
    throw LLMError.invalidRequest(
      "'response_format' is not supported yet. Remove it, or constrain the output through your prompt.",
    );
  }

  for (const message of body.messages) {
    if (message.role === "tool") {
      throw LLMError.invalidRequest(
        "Messages with role 'tool' are not supported yet, because tool calling is not implemented.",
      );
    }
  }
}

/** OpenAI body → internal ChatRequest. */
export function toChatRequest(body: ChatCompletionRequestBody, model: string): ChatRequest {
  const messages: ChatMessage[] = body.messages.map((message) => ({
    // `developer` is OpenAI's newer name for the same thing.
    role: message.role === "developer" ? "system" : (message.role as ChatMessage["role"]),
    content: typeof message.content === "string" ? message.content : joinTextParts(message.content),
  }));

  const request: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stop?: readonly string[];
  } = { model, messages };

  if (body.temperature !== undefined) request.temperature = body.temperature;
  if (body.top_p !== undefined) request.topP = body.top_p;
  // `max_completion_tokens` is the current field; `max_tokens` is the legacy
  // alias. Honour the newer one when a client sends both.
  const maxOutput = body.max_completion_tokens ?? body.max_tokens;
  if (maxOutput !== undefined) request.maxOutputTokens = maxOutput;
  if (body.stop !== undefined) {
    request.stop = typeof body.stop === "string" ? [body.stop] : body.stop;
  }

  return request;
}

function joinTextParts(parts: readonly z.infer<typeof textPartSchema>[]): string {
  return parts.map((part) => part.text).join("");
}

/**
 * The response body.
 *
 * Declared as a schema so Fastify serializes through it: anything not listed
 * here cannot leak into a response, whatever a future refactor puts on the
 * object being returned.
 */
export const chatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string(),
      }),
      finish_reason: z.string(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
      total_tokens: z.number().int(),
    })
    .optional(),
});

export type ChatCompletionResponseBody = z.infer<typeof chatCompletionResponseSchema>;

/**
 * Streamed chunk bodies (`object: "chat.completion.chunk"`).
 *
 * Not a Zod schema like the non-streaming response, because chunks are written
 * straight to the socket rather than through Fastify's serializer — there is no
 * reply lifecycle to hang a response schema off once the connection is hijacked.
 */
export interface ChatCompletionChunkBody {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: { readonly role?: "assistant"; readonly content?: string };
    readonly finish_reason: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

export interface ChunkContext {
  readonly id: string;
  readonly model: string;
  readonly created: number;
}

/**
 * The opening chunk carries the assistant role and no content, matching OpenAI.
 * Clients use it to open a message before any tokens arrive.
 */
export function toRoleChunk(context: ChunkContext): ChatCompletionChunkBody {
  return {
    ...base(context),
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
}

export function toContentChunk(context: ChunkContext, content: string): ChatCompletionChunkBody {
  return {
    ...base(context),
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

export function toFinishChunk(
  context: ChunkContext,
  finishReason: string,
): ChatCompletionChunkBody {
  return {
    ...base(context),
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

/**
 * Usage arrives in a trailing chunk with an EMPTY choices array — that is
 * OpenAI's shape, and clients that index into `choices[0]` will crash on
 * anything else.
 */
export function toUsageChunk(
  context: ChunkContext,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number },
): ChatCompletionChunkBody {
  return {
    ...base(context),
    choices: [],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

function base(context: ChunkContext) {
  return {
    id: context.id,
    object: "chat.completion.chunk" as const,
    created: context.created,
    model: context.model,
  };
}

/** Internal ChatResponse → OpenAI body. */
export function toChatCompletionResponse(response: ChatResponse): ChatCompletionResponseBody {
  const body: ChatCompletionResponseBody = {
    // Providers that issue no id of their own (Ollama) get a generated one, so
    // the field is always present and always usable as a correlation key.
    id: response.id !== "" ? response.id : `chatcmpl_${Math.random().toString(36).slice(2, 14)}`,
    object: "chat.completion",
    created: response.createdAt,
    model: response.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: response.content },
        finish_reason: response.finishReason,
      },
    ],
  };

  // Omitted entirely when the provider reported nothing. OpenAI always sends
  // usage, so this is a deliberate deviation — but reporting zeroes would be a
  // lie that silently understates cost, and spec §16 requires honesty here.
  if (response.usage === undefined) return body;

  return {
    ...body,
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.totalTokens,
    },
  };
}
