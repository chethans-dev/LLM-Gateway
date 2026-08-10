import { describe, expect, it } from "vitest";
import { parseNdjson, parseSSE, readLines } from "../../src/providers/stream-parsers.js";
import { streamOf } from "../helpers/fake-fetch.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("readLines", () => {
  it("reassembles a line split across chunk boundaries", async () => {
    // The bug this prevents: parsing each network chunk independently. It works
    // perfectly on short responses and starts dropping tokens exactly when
    // responses get long enough to span chunks.
    const lines = await collect(readLines(streamOf(["hel", "lo\nwor", "ld\n"])));

    expect(lines).toEqual(["hello", "world"]);
  });

  it("reassembles a multi-byte character split across chunk boundaries", async () => {
    // Decoding each chunk in isolation mangles any non-ASCII token — emoji, CJK,
    // accented text — at random points in a response.
    const bytes = new TextEncoder().encode("日本語\n");
    // Byte 2 lands in the middle of the first three-byte character.
    const parts = [bytes.slice(0, 2), bytes.slice(2)];

    expect(await collect(readLines(streamOf(parts)))).toEqual(["日本語"]);
  });

  it("handles CRLF line endings", async () => {
    expect(await collect(readLines(streamOf(["a\r\nb\r\n"])))).toEqual(["a", "b"]);
  });

  it("yields a final line with no trailing newline", async () => {
    expect(await collect(readLines(streamOf(["a\nb"])))).toEqual(["a", "b"]);
  });

  it("yields nothing for an empty stream", async () => {
    expect(await collect(readLines(streamOf([])))).toEqual([]);
  });
});

describe("parseSSE", () => {
  it("parses data events terminated by a blank line", async () => {
    const events = await collect(parseSSE(streamOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n'])));

    expect(events.map((e) => e.data)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("ignores comment keep-alives", async () => {
    // Several providers send `: ping` to hold the connection open. Treating it
    // as payload would feed a JSON parser a non-JSON line.
    const events = await collect(parseSSE(streamOf([": ping\n\n", 'data: {"a":1}\n\n'])));

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"a":1}');
  });

  it("joins multi-line data with newlines", async () => {
    const events = await collect(parseSSE(streamOf(["data: line one\ndata: line two\n\n"])));

    expect(events[0]?.data).toBe("line one\nline two");
  });

  it("captures the event name when present", async () => {
    const events = await collect(
      parseSSE(streamOf(["event: message_start\ndata: {}\n\n"])),
    );

    expect(events[0]?.event).toBe("message_start");
  });

  it("strips exactly one leading space after the colon", async () => {
    // `data:  x` is the value " x", not "x" — the first space is framing.
    const events = await collect(parseSSE(streamOf(["data:  x\n\n"])));

    expect(events[0]?.data).toBe(" x");
  });

  it("emits a trailing event even without a terminating blank line", async () => {
    const events = await collect(parseSSE(streamOf(["data: [DONE]\n"])));

    expect(events[0]?.data).toBe("[DONE]");
  });

  it("survives an event split across chunks", async () => {
    const events = await collect(parseSSE(streamOf(["data: {\"a\"", ":1}\n", "\n"])));

    expect(events[0]?.data).toBe('{"a":1}');
  });
});

describe("parseNdjson", () => {
  it("parses one JSON value per line", async () => {
    const values = await collect(parseNdjson(streamOf(['{"a":1}\n', '{"b":2}\n'])));

    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips blank lines", async () => {
    expect(await collect(parseNdjson(streamOf(['{"a":1}\n\n\n'])))).toEqual([{ a: 1 }]);
  });

  it("throws on malformed JSON so the adapter can normalize it", async () => {
    await expect(collect(parseNdjson(streamOf(["not json\n"])))).rejects.toBeInstanceOf(SyntaxError);
  });
});
