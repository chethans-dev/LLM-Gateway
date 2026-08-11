import { describe, expect, it } from "vitest";
import { LLMError } from "@openllm/core";
import { encodeCursor, parseCursor } from "../../src/observability/request-repository.js";

/**
 * The cursor is the one piece of the paging path a client can hand back
 * arbitrarily, so it is the one piece that has to be hostile-input safe. The id
 * half is interpolated into a `::uuid` cast; anything that is not a UUID must be
 * rejected here rather than becoming a Postgres 22P02 at query time.
 */
const ID = "2f1d6b6e-1f6b-4c1e-9a3a-9d5a2f5c6b7e";
const AT = new Date("2026-08-01T12:00:00.000Z");

describe("request cursor", () => {
  it("round-trips a position", () => {
    const parsed = parseCursor(encodeCursor({ createdAt: AT, id: ID }));

    expect(parsed.createdAt.toISOString()).toBe(AT.toISOString());
    expect(parsed.id).toBe(ID);
  });

  it("keeps millisecond precision", () => {
    // Truncating to seconds would make every request sharing a second with the
    // page boundary a candidate for being skipped or repeated.
    const precise = new Date("2026-08-01T12:00:00.123Z");

    expect(parseCursor(encodeCursor({ createdAt: precise, id: ID })).createdAt.getTime()).toBe(
      precise.getTime(),
    );
  });

  it.each([
    ["empty", ""],
    ["no separator", `2026-08-01T12:00:00.000Z${ID}`],
    ["missing id", "2026-08-01T12:00:00.000Z|"],
    ["missing timestamp", `|${ID}`],
    ["unparseable timestamp", `not-a-date|${ID}`],
    ["id that is not a uuid", "2026-08-01T12:00:00.000Z|1; drop table requests"],
    ["uuid with trailing sql", `2026-08-01T12:00:00.000Z|${ID}'::uuid or true--`],
  ])("rejects a cursor with %s", (_label, cursor) => {
    expect(() => parseCursor(cursor)).toThrow(LLMError);
  });

  it("reports a bad cursor as a 400, not a 500", () => {
    // It is the caller's input. Surfacing it as a server error would send
    // somebody looking at the gateway for a bug that is in their pagination.
    try {
      parseCursor("garbage");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as LLMError).code).toBe("INVALID_REQUEST");
      expect((error as LLMError).httpStatus).toBe(400);
    }
  });

  it("accepts an uppercase uuid", () => {
    // Postgres will cast it happily; rejecting it would be our own artifact.
    expect(parseCursor(`2026-08-01T12:00:00.000Z|${ID.toUpperCase()}`).id).toBe(ID.toUpperCase());
  });
});
