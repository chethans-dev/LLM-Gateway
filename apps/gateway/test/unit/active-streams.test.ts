import { describe, expect, it } from "vitest";
import { createActiveStreams } from "../../src/http/active-streams.js";

describe("createActiveStreams", () => {
  it("counts registered streams and releases them", () => {
    const streams = createActiveStreams();
    const releaseA = streams.add(new AbortController());
    const releaseB = streams.add(new AbortController());

    expect(streams.size()).toBe(2);

    releaseA();
    expect(streams.size()).toBe(1);

    releaseB();
    expect(streams.size()).toBe(0);
  });

  it("aborts every registered stream with the given reason", () => {
    // The shutdown path: cleanly ending streams beats being SIGKILLed with
    // sockets still open.
    const streams = createActiveStreams();
    const first = new AbortController();
    const second = new AbortController();
    streams.add(first);
    streams.add(second);

    const reason = new Error("gateway is shutting down");
    streams.abortAll(reason);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.reason).toBe(reason);
  });

  it("returns immediately from drain when nothing is active", async () => {
    const streams = createActiveStreams();
    const startedAt = Date.now();

    await streams.drain(5_000);

    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it("stops waiting once the last stream finishes", async () => {
    const streams = createActiveStreams();
    const release = streams.add(new AbortController());
    setTimeout(release, 50);

    const startedAt = Date.now();
    await streams.drain(5_000, 10);

    expect(streams.size()).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("gives up at the deadline rather than blocking shutdown forever", async () => {
    // A stream that never ends must not hold the process open — the force-exit
    // timer would be the only thing left, and that means exit code 1.
    const streams = createActiveStreams();
    streams.add(new AbortController());

    const startedAt = Date.now();
    await streams.drain(60, 10);

    expect(streams.size()).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });
});
