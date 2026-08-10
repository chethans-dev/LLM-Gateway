/**
 * A delay that can be cancelled.
 *
 * Every wait in the gateway — retry backoff, mock latency — has to be
 * interruptible. A plain `setTimeout` promise keeps a request alive after the
 * client has hung up or the deadline has passed, which is precisely the
 * "requests must not hang indefinitely" failure spec §10 is about.
 */

// setTimeout coerces anything larger to 1ms, which would turn a long wait into
// no wait at all.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.min(ms, MAX_TIMEOUT_MS));

    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason as Error);
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
