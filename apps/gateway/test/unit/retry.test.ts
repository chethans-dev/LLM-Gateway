import { describe, expect, it, vi } from "vitest";
import { LLMError } from "@openllm/core";
import { createDeadline, unboundedDeadline } from "../../src/routing/deadline.js";
import { computeBackoffMs, withRetry, type RetryPolicy } from "../../src/routing/retry.js";
import { rejection } from "../helpers/expect-error.js";

const policy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitter: false,
};

/** Records what we would have slept, without spending the time. */
function recordingSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
    },
  };
}

function context(overrides: Partial<Parameters<typeof withRetry>[1]> = {}) {
  const { waits, sleep } = recordingSleep();
  return {
    waits,
    ctx: {
      policy,
      deadline: unboundedDeadline(),
      signal: new AbortController().signal,
      sleep,
      random: () => 0.5,
      ...overrides,
    },
  };
}

describe("computeBackoffMs", () => {
  it("follows the documented schedule: 250, 500, 1000", () => {
    // Spec §9's example. `attempt` is the attempt that just failed, so the wait
    // before attempt 2 is computed with attempt = 1.
    expect(computeBackoffMs(1, policy)).toBe(250);
    expect(computeBackoffMs(2, policy)).toBe(500);
    expect(computeBackoffMs(3, policy)).toBe(1_000);
  });

  it("caps at maxDelayMs", () => {
    // Without a cap, attempt 10 would wait over two minutes.
    expect(computeBackoffMs(10, policy)).toBe(5_000);
  });

  it("keeps the schedule as the expected value when jittering", () => {
    // Equal jitter: half fixed, half random. Full jitter would sometimes retry
    // almost immediately, which is worse when a provider is genuinely overloaded.
    const jittered = { ...policy, jitter: true };

    expect(computeBackoffMs(1, jittered, () => 0)).toBe(125);
    expect(computeBackoffMs(1, jittered, () => 1)).toBe(250);
    expect(computeBackoffMs(1, jittered, () => 0.5)).toBe(188);
  });

  it("spreads retries across clients", () => {
    // The point of jitter: without it every client that hit the same outage
    // retries at the same instant, re-creating the spike that caused it.
    const jittered = { ...policy, jitter: true };
    const delays = new Set(
      Array.from({ length: 50 }, () => computeBackoffMs(2, jittered, Math.random)),
    );

    expect(delays.size).toBeGreaterThan(10);
  });
});

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const { ctx, waits } = context();
    const operation = vi.fn(async () => "ok");

    const outcome = await withRetry(operation, ctx);

    expect(outcome).toEqual({ value: "ok", attempts: 1 });
    expect(waits).toEqual([]);
  });

  it("retries a retryable failure and reports the attempt count", async () => {
    const { ctx, waits } = context();
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw LLMError.provider("500");
      return "ok";
    });

    const outcome = await withRetry(operation, ctx);

    expect(outcome).toEqual({ value: "ok", attempts: 3 });
    expect(waits).toEqual([250, 500]);
  });

  it("NEVER retries a non-retryable failure", async () => {
    // Spec §9: do not retry invalid client requests. A malformed body fails
    // identically on the second attempt, so retrying only adds latency and cost.
    const { ctx, waits } = context();
    const operation = vi.fn(async () => {
      throw LLMError.invalidRequest("temperature must be <= 2");
    });

    const error = await rejection(withRetry(operation, ctx));

    expect(error.code).toBe("INVALID_REQUEST");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("does not retry an authentication failure", async () => {
    // Our key will not fix itself between attempts. Fallback may still try a
    // different provider — that is the other axis.
    const { ctx } = context();
    const operation = vi.fn(async () => {
      throw LLMError.authentication("bad key");
    });

    await expect(withRetry(operation, ctx)).rejects.toMatchObject({
      code: "AUTHENTICATION_ERROR",
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const { ctx, waits } = context();
    const operation = vi.fn(async () => {
      throw LLMError.rateLimited("429");
    });

    const error = await rejection(withRetry(operation, ctx));

    expect(error.code).toBe("RATE_LIMITED");
    expect(operation).toHaveBeenCalledTimes(3);
    // Two waits for three attempts — never a pointless sleep after the last one.
    expect(waits).toEqual([250, 500]);
  });

  it("honours a provider's Retry-After over our own guess", async () => {
    // The provider knows its actual limit; our exponential curve is a model.
    const { ctx, waits } = context();
    const onRetry = vi.fn();
    const operation = vi.fn(async () => {
      throw LLMError.rateLimited("429", { details: { retryAfterMs: 1_500 } });
    });

    await rejection(withRetry(operation, { ...ctx, onRetry }));

    expect(waits[0]).toBe(1_500);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ honouredRetryAfter: true });
  });

  it("reports when the delay was our own guess", async () => {
    const { ctx } = context();
    const onRetry = vi.fn();

    await rejection(
      withRetry(
        async () => {
          throw LLMError.provider("500");
        },
        { ...ctx, onRetry },
      ),
    );

    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      delayMs: 250,
      honouredRetryAfter: false,
    });
  });

  it("stops when the backoff would not fit the remaining budget", async () => {
    // Sleeping only to then abandon the request wastes the caller's time and
    // ours; give up now so fallback can use what is left on another provider.
    const { ctx, waits } = context({ deadline: createDeadline(100) });
    const operation = vi.fn(async () => {
      throw LLMError.rateLimited("429", { details: { retryAfterMs: 30_000 } });
    });

    await rejection(withRetry(operation, ctx));

    expect(operation).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("stops once the overall deadline has passed", async () => {
    const { ctx } = context({ deadline: createDeadline(0) });
    const operation = vi.fn(async () => {
      throw LLMError.provider("500");
    });

    await rejection(withRetry(operation, ctx));

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("stops when the caller has hung up", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = context({ signal: controller.signal });
    const operation = vi.fn(async () => {
      throw LLMError.provider("500");
    });

    await rejection(withRetry(operation, ctx));

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("normalizes a non-LLMError and does not retry it", async () => {
    // An unexpected crash is our bug; it would fail the same way next time.
    const { ctx } = context();
    const operation = vi.fn(async () => {
      throw new TypeError("cannot read property of undefined");
    });

    const error = await rejection(withRetry(operation, ctx));

    expect(error.code).toBe("INTERNAL_ERROR");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one call when retries are disabled", async () => {
    const { ctx } = context({ policy: { ...policy, maxAttempts: 1 } });
    const operation = vi.fn(async () => {
      throw LLMError.rateLimited("429");
    });

    await rejection(withRetry(operation, ctx));

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("passes the attempt number to the operation", async () => {
    const { ctx } = context();
    const seen: number[] = [];

    await rejection(
      withRetry(async (attempt) => {
        seen.push(attempt);
        throw LLMError.provider("500");
      }, ctx),
    );

    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("createDeadline", () => {
  it("reports remaining time and expiry", () => {
    let now = 1_000;
    const deadline = createDeadline(500, () => now);

    expect(deadline.remainingMs()).toBe(500);
    expect(deadline.expired()).toBe(false);

    now = 1_400;
    expect(deadline.remainingMs()).toBe(100);
    expect(deadline.allows(50)).toBe(true);
    expect(deadline.allows(200)).toBe(false);

    now = 1_600;
    expect(deadline.expired()).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
  });
});
