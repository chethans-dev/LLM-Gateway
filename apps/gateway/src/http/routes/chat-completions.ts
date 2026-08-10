import { LLMError, toOpenAIErrorEnvelope } from "@openllm/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { ChatService } from "../../chat/chat-service.js";
import type { ChatChunk, TokenUsage } from "../../providers/types.js";
import type { ActiveStreams } from "../active-streams.js";
import { watchForDisconnect } from "../disconnect.js";
import { normalizeError } from "../plugins/error-handler.js";
import { SSEWriter } from "../sse.js";
import {
  assertSupported,
  chatCompletionRequestSchema,
  chatCompletionResponseSchema,
  toChatCompletionResponse,
  toChatRequest,
  toContentChunk,
  toFinishChunk,
  toRoleChunk,
  toUsageChunk,
  type ChatCompletionRequestBody,
  type ChunkContext,
} from "../schemas/chat-completions.js";

export interface ChatCompletionRouteOptions {
  readonly chatService: ChatService;
  readonly activeStreams: ActiveStreams;
  /** Records a hijacked streaming response, which onResponse cannot see. */
  readonly observation?: (request: FastifyRequest, httpStatus: number) => void;
}

/**
 * `POST /v1/chat/completions` — the OpenAI-compatible entry point.
 *
 * The handler does translation and nothing else: validate, hand to the service,
 * serialize. Provider selection, timeouts and (from Phase 7) retry all live
 * behind `ChatService`, so this file never learns that OpenAI or Gemini exist.
 */
export function registerChatCompletionRoutes(
  app: FastifyInstance,
  options: ChatCompletionRouteOptions,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/chat/completions",
    {
      schema: {
        body: chatCompletionRequestSchema,
        // Applies to the buffered path only. Streamed responses bypass Fastify's
        // serializer entirely — see SSEWriter.
        response: { 200: chatCompletionResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      // Set before validation of unsupported features, so a rejected request is
      // still recorded — a 400 nobody can see is a support ticket.
      request.observation.requestedModel = body.model;
      assertSupported(body);

      if (body.stream === true) {
        await handleStream(request, reply, body, options);
        return reply;
      }

      return handleBuffered(request, reply, body, options);
    },
  );
}

async function handleBuffered(
  request: FastifyRequest,
  reply: FastifyReply,
  body: ChatCompletionRequestBody,
  options: ChatCompletionRouteOptions,
) {
  const controller = watchForDisconnect(reply.raw);

  try {
    const outcome = await options.chatService.complete(
      toChatRequest(body, body.model),
      controller.signal,
      { apiKeyId: request.apiKey?.id },
    );

    // Routing facts go in headers, not the body: an OpenAI-shaped response must
    // stay exactly that shape for strict clients, but an operator still needs to
    // know who actually served the request.
    void reply.header("x-openllm-provider", outcome.provider);
    void reply.header("x-openllm-model", outcome.response.model);

    // Total provider calls, counting retries as well as failovers — the number
    // an operator asking "why did this take 4 seconds?" actually needs.
    if (outcome.providerCalls > 1) {
      void reply.header("x-openllm-attempts", String(outcome.providerCalls));
    }
    // Explicit on every response, not only on hits: "no header" is ambiguous
    // between a miss and caching being switched off.
    void reply.header("x-openllm-cache", outcome.cached ? "hit" : "miss");

    Object.assign(request.observation, {
      route: outcome.route,
      provider: outcome.provider,
      model: outcome.response.model,
      providerCalls: outcome.providerCalls,
      cached: outcome.cached,
      usage: outcome.response.usage,
    });

    request.log.info(
      {
        provider: outcome.provider,
        model: outcome.response.model,
        requestedModel: body.model,
        route: outcome.route,
        failedAttempts: outcome.failedAttempts.length,
        providerCalls: outcome.providerCalls,
        cached: outcome.cached,
        streaming: false,
        latencyMs: outcome.latencyMs,
        inputTokens: outcome.response.usage?.inputTokens,
        outputTokens: outcome.response.usage?.outputTokens,
        finishReason: outcome.response.finishReason,
      },
      "chat completion served",
    );

    return toChatCompletionResponse(outcome.response);
  } catch (error) {
    if (controller.signal.aborted) {
      // The caller is gone; there is nobody to send an error to, and this is
      // not a fault worth logging at error level.
      request.log.info({ requestedModel: body.model }, "request aborted by client");
    }
    throw error;
  }
}

async function handleStream(
  request: FastifyRequest,
  reply: FastifyReply,
  body: ChatCompletionRequestBody,
  options: ChatCompletionRouteOptions,
): Promise<void> {
  const controller = watchForDisconnect(reply.raw);
  const release = options.activeStreams.add(controller);
  const startedAt = performance.now();
  request.observation.streamed = true;

  // Resolution and provider lookup throw synchronously, before any network call,
  // so an unknown model still produces a normal 404 rather than a 200 whose body
  // happens to contain an error.
  const stream = options.chatService.stream(toChatRequest(body, body.model), controller.signal);
  const iterator = stream.chunks[Symbol.asyncIterator]();

  let writer: SSEWriter | undefined;
  let context: ChunkContext | undefined;
  let finishReason = "stop";
  let usage: TokenUsage | undefined;
  let deltas = 0;

  try {
    /**
     * Pull the FIRST chunk before committing to a 200.
     *
     * This is the pivot of the whole streaming design. Once a byte of the
     * response body is written the status code is fixed, so a provider 429 after
     * that point can only be reported as an event inside a "successful"
     * response. Every adapter's `stream()` performs its HTTP request and throws
     * on a non-OK status before yielding anything, so awaiting one chunk here
     * converts the common failures — rate limits, auth, unknown model — back
     * into ordinary status codes a client already knows how to handle.
     */
    const first = await iterator.next();

    if (first.done === true) {
      throw LLMError.provider("provider produced an empty stream", { model: body.model });
    }

    const startChunk = first.value;
    if (startChunk.type !== "start") {
      throw LLMError.provider("provider stream did not begin with a start chunk", {
        model: body.model,
      });
    }

    context = {
      id: startChunk.id !== "" ? startChunk.id : `chatcmpl_${request.id.slice(4)}`,
      model: startChunk.model,
      created: Math.floor(Date.now() / 1000),
    };

    Object.assign(request.observation, {
      route: stream.route,
      provider: startChunk.provider,
      model: startChunk.model,
    });

    writer = new SSEWriter(reply);
    // Hijacking bypasses reply.header(), so correlation headers are set here.
    writer.start({
      "x-request-id": request.id,
      "x-trace-id": request.traceId,
      // Under fallback the serving provider is only known once an attempt has
      // actually succeeded, which is precisely what the start chunk reports.
      "x-openllm-provider": startChunk.provider,
      "x-openllm-model": startChunk.model,
    });

    await writer.send(toRoleChunk(context));

    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;

      const chunk: ChatChunk = next.value;

      if (chunk.type === "delta") {
        deltas += 1;
        await writer.send(toContentChunk(context, chunk.content));
        continue;
      }

      if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
        usage = chunk.usage;
        request.observation.usage = chunk.usage;
        continue;
      }

      // A second `start` chunk violates the provider contract; ignoring it is
      // safer than emitting a duplicate role delta the client would append.
    }

    await writer.send(toFinishChunk(context, finishReason));

    // Only when asked, matching OpenAI. A client parsing chunks positionally
    // should not receive an event it never requested.
    if (body.stream_options?.include_usage === true && usage !== undefined) {
      await writer.send(toUsageChunk(context, usage));
    }

    await writer.sendDone();

    request.log.info(
      {
        provider: startChunk.provider,
        model: context.model,
        requestedModel: body.model,
        route: stream.route,
        providerCalls: stream.callCount(),
        streaming: true,
        chunks: deltas,
        latencyMs: Math.round(performance.now() - startedAt),
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        finishReason,
      },
      "chat completion streamed",
    );
  } catch (error) {
    // The caller hung up. There is nobody to send an error to, and this is not a
    // fault — it is the normal outcome of someone closing a tab mid-response.
    // The `finally` below still tears down the upstream provider call.
    if (controller.signal.aborted) {
      request.log.info(
        { requestedModel: body.model, route: stream.route, chunks: deltas },
        "stream aborted by client",
      );
      return;
    }

    const normalized = normalizeError(error);

    if (writer === undefined) {
      // Nothing written yet — rethrow so the normal error handler produces a
      // proper status code and JSON envelope.
      throw normalized;
    }

    // Mid-stream: the status is already 200 and cannot be changed. Emit the
    // error as an event and close WITHOUT [DONE] — sending the terminator would
    // tell the client the response completed successfully.
    request.log.error(
      { err: error, code: normalized.code, route: stream.route, chunks: deltas },
      "chat completion stream failed",
    );

    if (writer.isWritable) {
      await writer.send(toOpenAIErrorEnvelope(normalized, request.id)).catch(() => {
        // The client is already gone; nothing left to report to.
      });
    }
  } finally {
    release();
    // Closes the upstream provider connection if we exited early (client
    // disconnect, shutdown) rather than leaving it generating.
    await iterator.return?.().catch(() => {});
    request.observation.providerCalls = stream.callCount();
    writer?.end();

    // Hijacking means onResponse never fires, so the streaming path records
    // itself. `recorded` keeps it idempotent either way.
    options.observation?.(request, writer === undefined ? 500 : 200);
  }
}
