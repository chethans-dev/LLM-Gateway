/**
 * Wire-format parsers shared by the streaming adapters.
 *
 * OpenAI, Anthropic and Gemini stream Server-Sent Events; Ollama streams
 * newline-delimited JSON. Both sit on the same problem — a network chunk is not
 * a line — so the line reader is shared and the format parsers are thin.
 */

/**
 * Yield complete lines from a byte stream.
 *
 * Two details that are easy to get wrong and produce corruption only under load:
 *
 *  - **A chunk boundary can fall mid-line.** Anything that parses each chunk
 *    independently silently drops or splits events once responses get long
 *    enough to span chunks, which is exactly when you stop noticing.
 *  - **A chunk boundary can fall mid-character.** `TextDecoder` with
 *    `{ stream: true }` holds the partial UTF-8 sequence until the rest arrives.
 *    Decoding each chunk in isolation mangles any non-ASCII token — emoji, CJK,
 *    accented text — at random points in the response.
 */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        yield stripCarriageReturn(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }

    // Flush any bytes the decoder was holding, then any unterminated final line.
    buffer += decoder.decode();
    if (buffer.length > 0) yield stripCarriageReturn(buffer);
  } finally {
    // Runs when the consumer breaks out early too — this is what actually closes
    // the upstream HTTP connection when a client disconnects mid-stream.
    try {
      await reader.cancel();
    } catch {
      // Already closed or errored; nothing useful to do.
    }
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export interface SSEEvent {
  /** The `event:` field, when the provider sends one (Anthropic does). */
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Parse Server-Sent Events.
 *
 * Implements the parts of the SSE grammar providers actually use: `data:` and
 * `event:` fields, multi-line data joined with newlines, `:` comment lines
 * (which several providers send as keep-alives and which must not be mistaken
 * for payload), and a blank line as the event terminator.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  let dataLines: string[] = [];
  let eventName: string | undefined;

  for await (const line of readLines(body)) {
    if (line === "") {
      if (dataLines.length > 0) {
        yield { event: eventName, data: dataLines.join("\n") };
      }
      dataLines = [];
      eventName = undefined;
      continue;
    }

    // Keep-alive comment.
    if (line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // A single leading space after the colon is part of the framing, not data.
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
  }

  // Some servers close without a trailing blank line.
  if (dataLines.length > 0) {
    yield { event: eventName, data: dataLines.join("\n") };
  }
}

/** Parse newline-delimited JSON (Ollama's streaming format). */
export async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  for await (const line of readLines(body)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    yield JSON.parse(trimmed);
  }
}
