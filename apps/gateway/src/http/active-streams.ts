/**
 * Registry of in-flight streaming responses.
 *
 * Spec §25 says shutdown should "finish active requests where possible".
 * For ordinary requests Fastify's `close()` already does that — they complete in
 * milliseconds. Streams are the case where it actually matters: a completion can
 * run for tens of seconds, and severing it mid-sentence loses work the user has
 * already been billed for.
 *
 * Tracking them lets shutdown wait for a bounded grace period, then abort what
 * remains *cleanly* — rather than the process being SIGKILLed with sockets open.
 * The count is also the natural source for an "active streams" metric later.
 */
export interface ActiveStreams {
  /** Register a stream. Returns the function that deregisters it. */
  add(controller: AbortController): () => void;
  size(): number;
  abortAll(reason: Error): void;
  /** Resolves when every stream has finished, or when the deadline passes. */
  drain(graceMs: number, pollMs?: number): Promise<void>;
}

export function createActiveStreams(): ActiveStreams {
  const controllers = new Set<AbortController>();

  return {
    add(controller: AbortController): () => void {
      controllers.add(controller);
      return () => {
        controllers.delete(controller);
      };
    },

    size: () => controllers.size,

    abortAll(reason: Error): void {
      for (const controller of controllers) {
        controller.abort(reason);
      }
    },

    async drain(graceMs: number, pollMs = 100): Promise<void> {
      const deadline = Date.now() + graceMs;

      while (controllers.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}
