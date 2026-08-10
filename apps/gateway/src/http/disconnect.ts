/**
 * Detecting that the caller hung up.
 *
 * The obvious implementation is wrong, and wrong in a way that only shows up
 * once responses stop being instantaneous:
 *
 *     request.raw.once("close", () => controller.abort());   // ✗
 *
 * `IncomingMessage` emits `close` when the REQUEST is complete — i.e. as soon as
 * its body has been read — not when the connection drops. For a buffered
 * response that returns in milliseconds the race is invisible; for a streamed
 * response it fires almost immediately and aborts the provider call mid-stream.
 *
 * The response object is the right thing to watch. It also emits `close` on
 * normal completion, so `writableFinished` is what distinguishes "we finished
 * writing" from "the socket went away before we could".
 */
export interface ResponseLike {
  once(event: "close", listener: () => void): unknown;
  readonly writableFinished: boolean;
}

export class ClientDisconnectedError extends Error {
  override readonly name = "ClientDisconnectedError";

  constructor() {
    super("client disconnected");
  }
}

/**
 * Returns a controller that aborts only on a genuine premature disconnect.
 *
 * Aborting means the upstream provider call stops — so we stop generating, and
 * paying for, tokens nobody will ever read.
 */
export function watchForDisconnect(response: ResponseLike): AbortController {
  const controller = new AbortController();

  response.once("close", () => {
    if (!response.writableFinished) {
      controller.abort(new ClientDisconnectedError());
    }
  });

  return controller;
}
