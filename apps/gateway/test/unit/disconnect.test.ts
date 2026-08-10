import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  ClientDisconnectedError,
  watchForDisconnect,
  type ResponseLike,
} from "../../src/http/disconnect.js";

/** Minimal stand-in for ServerResponse: emits `close`, reports writableFinished. */
class FakeResponse extends EventEmitter implements ResponseLike {
  writableFinished = false;

  finishThenClose(): void {
    this.writableFinished = true;
    this.emit("close");
  }

  dropConnection(): void {
    this.writableFinished = false;
    this.emit("close");
  }
}

describe("watchForDisconnect", () => {
  it("aborts when the socket closes before the response finished", () => {
    const response = new FakeResponse();
    const controller = watchForDisconnect(response);

    response.dropConnection();

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(ClientDisconnectedError);
  });

  it("does NOT abort when the response completed normally", () => {
    // Regression test for a real bug found by streaming over a live socket.
    //
    // The first implementation watched `request.raw`, whose `close` event fires
    // once the request BODY has been read — not when the client goes away. With
    // instant responses that race was invisible; as soon as chunks were spaced
    // 120ms apart it aborted every stream after the first chunk and turned a
    // healthy completion into an INTERNAL_ERROR event.
    const response = new FakeResponse();
    const controller = watchForDisconnect(response);

    response.finishThenClose();

    expect(controller.signal.aborted).toBe(false);
  });

  it("stays unaborted while the response is still in flight", () => {
    const response = new FakeResponse();
    const controller = watchForDisconnect(response);

    expect(controller.signal.aborted).toBe(false);
  });
});
