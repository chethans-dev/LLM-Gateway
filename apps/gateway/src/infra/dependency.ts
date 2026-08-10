/**
 * Uniform shape for every external dependency the gateway talks to.
 *
 * Both the readiness probe and the shutdown sequence iterate over these, so
 * adding a new backing service later (a second Redis, a vector store) means
 * implementing this interface — not editing the probe and the shutdown path.
 */
export interface DependencyCheck {
  readonly name: string;
  /** Resolves if the dependency is reachable; rejects otherwise. Must respect the timeout. */
  ping(timeoutMs: number): Promise<void>;
}

export interface Closable {
  readonly name: string;
  close(): Promise<void>;
}

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
  }
}

/**
 * Bound an operation that has no native cancellation.
 *
 * `pool.query` and `redis.ping` will happily wait on a wedged server. Without this,
 * a single hung dependency turns the readiness probe itself into a hung request —
 * which is precisely the failure mode the probe exists to detect.
 */
export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
  });

  // Promise.race attaches handlers to both, so the loser rejecting later is
  // already handled and will not surface as an unhandled rejection.
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
