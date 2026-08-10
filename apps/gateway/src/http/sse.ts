import type { ServerResponse } from "node:http";
import type { FastifyReply } from "fastify";

/**
 * Server-Sent Events writer.
 *
 * Writes directly to the raw socket via `reply.hijack()`, because Fastify's
 * reply lifecycle assumes one buffered payload — it cannot express "200, headers
 * now, body over the next thirty seconds".
 *
 * Hijacking means Fastify stops managing this response, so anything it would
 * normally do for us has to be done here: headers set through `reply.header()`
 * are NOT applied, and `onResponse` hooks do not fire. Correlation headers are
 * therefore written explicitly below, and the streaming route logs its own
 * completion line.
 */
export interface SSEHeaders {
  readonly [name: string]: string;
}

export class SSEWriter {
  private readonly res: ServerResponse;
  private started = false;
  private ended = false;

  constructor(reply: FastifyReply) {
    reply.hijack();
    this.res = reply.raw;
  }

  /** Commit to a 200 and flush the headers. After this the status is fixed. */
  start(headers: SSEHeaders): void {
    if (this.started) return;
    this.started = true;

    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      // `no-transform` matters as much as `no-cache`: a compressing proxy will
      // happily buffer the whole stream to gzip it, turning a token-by-token
      // response into one delivery at the end.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx buffers proxied responses by default, which breaks streaming in
      // exactly the deployment people are most likely to have.
      "x-accel-buffering": "no",
      ...headers,
    });

    // Some proxies wait for a first byte before forwarding headers downstream.
    this.res.flushHeaders();
  }

  /** Send one `data:` event. */
  async send(payload: unknown): Promise<void> {
    await this.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /** OpenAI's terminator. Clients treat this as "completed successfully". */
  async sendDone(): Promise<void> {
    await this.write("data: [DONE]\n\n");
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.res.end();
  }

  get isWritable(): boolean {
    return !this.ended && this.res.writable;
  }

  /**
   * Write, respecting backpressure.
   *
   * `res.write` returning false means the kernel buffer is full — usually a
   * client reading more slowly than the provider generates. Ignoring that
   * return value queues every chunk in process memory, so one slow reader on a
   * long completion becomes unbounded heap growth.
   */
  private write(chunk: string): Promise<void> {
    if (this.ended || !this.res.writable) return Promise.resolve();

    if (this.res.write(chunk)) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        this.res.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        this.res.off("drain", onDrain);
        reject(error);
      };

      this.res.once("drain", onDrain);
      this.res.once("error", onError);
    });
  }
}
