import type { Logger } from "../observability/logger.js";

export type LifecycleState = "starting" | "ready" | "draining" | "closed";

export interface ShutdownHook {
  readonly name: string;
  run(): Promise<void>;
}

export interface ShutdownManagerOptions {
  readonly logger: Logger;
  /** How long to fail readiness before closing the server. */
  readonly drainMs: number;
  /** Hard deadline for the entire sequence. */
  readonly timeoutMs: number;
  /** Injected for tests; defaults to process.exit. */
  readonly exit?: (code: number) => void;
  /** Injected for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ordered, bounded shutdown (spec §25).
 *
 * The sequence is:
 *
 *   SIGTERM
 *     -> state = draining     (/ready returns 503, /health still 200)
 *     -> wait drainMs         (load balancer observes and stops routing)
 *     -> run hooks in order   (HTTP server, then Redis, then Postgres)
 *     -> exit
 *
 * The drain delay is the part usually skipped. Closing the server the instant
 * SIGTERM arrives means requests the load balancer already dispatched get
 * connection-refused — the classic "deploys cause a blip of 502s" bug. Failing
 * readiness first, then closing, is what makes a rolling deploy zero-downtime.
 *
 * Hook order matters and is registration order: stop accepting work before
 * tearing down the things in-flight work depends on.
 */
export class ShutdownManager {
  private state: LifecycleState = "starting";
  private readonly hooks: ShutdownHook[] = [];
  private inFlight: Promise<void> | undefined;

  private readonly logger: Logger;
  private readonly drainMs: number;
  private readonly timeoutMs: number;
  private readonly exit: (code: number) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ShutdownManagerOptions) {
    this.logger = options.logger;
    this.drainMs = options.drainMs;
    this.timeoutMs = options.timeoutMs;
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.sleep = options.sleep ?? defaultSleep;
  }

  getState(): LifecycleState {
    return this.state;
  }

  /** True only in the steady state. Drives both /health and /ready. */
  isAcceptingTraffic(): boolean {
    return this.state === "ready";
  }

  markReady(): void {
    if (this.state === "starting") this.state = "ready";
  }

  register(hook: ShutdownHook): void {
    this.hooks.push(hook);
  }

  /**
   * Trap termination signals and last-resort process errors.
   *
   * An unhandled rejection that silently kills the process leaves connections
   * open and in-flight requests hanging; routing it through the same shutdown
   * path at least closes things cleanly and logs why.
   */
  listen(): void {
    process.on("SIGTERM", () => void this.shutdown("SIGTERM"));
    process.on("SIGINT", () => void this.shutdown("SIGINT"));

    process.on("unhandledRejection", (reason) => {
      this.logger.fatal({ err: reason }, "unhandled promise rejection");
      void this.shutdown("unhandledRejection", 1);
    });

    process.on("uncaughtException", (error) => {
      this.logger.fatal({ err: error }, "uncaught exception");
      void this.shutdown("uncaughtException", 1);
    });
  }

  async shutdown(reason: string, initialExitCode = 0): Promise<void> {
    if (this.inFlight !== undefined) {
      this.logger.warn({ reason }, "shutdown already in progress");
      return this.inFlight;
    }

    this.inFlight = this.run(reason, initialExitCode);
    return this.inFlight;
  }

  private async run(reason: string, initialExitCode: number): Promise<void> {
    this.logger.info({ reason, drainMs: this.drainMs }, "shutdown started; draining");
    this.state = "draining";

    // Absolute deadline. If any hook wedges, we still exit rather than becoming
    // a zombie the orchestrator has to SIGKILL.
    const forceTimer = setTimeout(() => {
      this.logger.fatal({ timeoutMs: this.timeoutMs }, "shutdown timed out; forcing exit");
      this.exit(1);
    }, this.timeoutMs);
    forceTimer.unref();

    let exitCode = initialExitCode;

    if (this.drainMs > 0) {
      await this.sleep(this.drainMs);
    }

    for (const hook of this.hooks) {
      const startedAt = performance.now();
      try {
        await hook.run();
        this.logger.info(
          { hook: hook.name, durationMs: Math.round(performance.now() - startedAt) },
          "shutdown hook completed",
        );
      } catch (error) {
        // Keep going: failing to close Redis must not prevent closing Postgres.
        exitCode = 1;
        this.logger.error({ err: error, hook: hook.name }, "shutdown hook failed");
      }
    }

    clearTimeout(forceTimer);
    this.state = "closed";
    this.logger.info({ reason, exitCode }, "shutdown complete");
    this.exit(exitCode);
  }
}
