import type { FastifyInstance } from "fastify";
import { withTimeout, type DependencyCheck } from "../../infra/dependency.js";
import type { LifecycleState } from "../../infra/shutdown.js";

export interface DependencyStatus {
  readonly status: "up" | "down";
  readonly latencyMs: number;
  readonly error?: string;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, DependencyStatus>>;
}

export interface ReadinessProbe {
  run(): Promise<ReadinessResult>;
}

export interface ReadinessProbeOptions {
  readonly checks: readonly DependencyCheck[];
  readonly checkTimeoutMs: number;
  readonly cacheTtlMs: number;
  readonly now?: () => number;
}

/**
 * Readiness probe with a short result cache and per-check timeouts.
 *
 * Two properties matter here and both come from operating this kind of service:
 *
 * 1. Checks run in PARALLEL under a hard timeout. A wedged Postgres must not be
 *    able to wedge the probe itself — a health endpoint that hangs is worse than
 *    one that reports failure, because load balancers treat a timeout and a 503
 *    very differently.
 *
 * 2. Results are cached briefly. A load balancer polling at 10rps across N
 *    instances otherwise generates a constant background load of SELECT 1 and
 *    PING against production infrastructure, purely to answer a question whose
 *    answer changes on the order of seconds.
 */
export function createReadinessProbe(options: ReadinessProbeOptions): ReadinessProbe {
  const now = options.now ?? (() => Date.now());
  let cached: { result: ReadinessResult; expiresAt: number } | undefined;
  let inFlight: Promise<ReadinessResult> | undefined;

  async function evaluate(): Promise<ReadinessResult> {
    const entries = await Promise.all(
      options.checks.map(async (check): Promise<[string, DependencyStatus]> => {
        const startedAt = performance.now();
        try {
          // The timeout is applied here as well as passed down. Checks are
          // expected to honour it, but the probe must not depend on every
          // dependency implementation being well-behaved to stay responsive.
          await withTimeout(
            check.ping(options.checkTimeoutMs),
            options.checkTimeoutMs,
            `${check.name} readiness check`,
          );
          return [check.name, { status: "up", latencyMs: elapsed(startedAt) }];
        } catch (error) {
          return [
            check.name,
            {
              status: "down",
              latencyMs: elapsed(startedAt),
              error: error instanceof Error ? error.message : "unknown error",
            },
          ];
        }
      }),
    );

    const checks = Object.fromEntries(entries);
    return {
      ready: entries.every(([, status]) => status.status === "up"),
      checks,
    };
  }

  return {
    async run(): Promise<ReadinessResult> {
      const timestamp = now();

      if (cached !== undefined && cached.expiresAt > timestamp) {
        return cached.result;
      }

      // Collapse concurrent probes into one round of checks.
      if (inFlight !== undefined) return inFlight;

      inFlight = evaluate()
        .then((result) => {
          cached = { result, expiresAt: now() + options.cacheTtlMs };
          return result;
        })
        .finally(() => {
          inFlight = undefined;
        });

      return inFlight;
    },
  };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export interface LifecycleView {
  getState(): LifecycleState;
}

export interface HealthRouteOptions {
  readonly lifecycle: LifecycleView;
  readonly probe: ReadinessProbe;
  readonly version: string;
  readonly startedAt: number;
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  /**
   * Liveness. Deliberately checks NOTHING external (spec §20, decision D4).
   *
   * If this endpoint checked Redis, a thirty-second Redis blip would cause the
   * orchestrator to kill and restart every gateway instance — turning a partial
   * degradation into a total outage, and losing every in-flight request in the
   * process. Liveness answers exactly one question: is this process wedged?
   */
  app.get("/health", async (_request, reply) => {
    const state = options.lifecycle.getState();
    const shuttingDown = state === "draining" || state === "closed";

    return reply.status(shuttingDown ? 503 : 200).send({
      status: shuttingDown ? "shutting_down" : "ok",
      state,
      version: options.version,
      uptimeSeconds: Math.round((Date.now() - options.startedAt) / 1000),
    });
  });

  /**
   * Readiness. Checks every dependency the gateway cannot serve traffic without.
   *
   * Returns the same body shape on success and failure so a load balancer or an
   * operator can see *which* dependency is down, not merely that something is.
   * Phase 3 adds a `providers` section to this payload without changing the contract.
   */
  app.get("/ready", async (_request, reply) => {
    const state = options.lifecycle.getState();
    const result = await options.probe.run();
    const ready = state === "ready" && result.ready;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      state,
      checks: result.checks,
    });
  });
}
