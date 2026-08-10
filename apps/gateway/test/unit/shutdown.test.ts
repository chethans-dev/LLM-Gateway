import { describe, expect, it, vi } from "vitest";
import { ShutdownManager } from "../../src/infra/shutdown.js";
import { silentLogger } from "../helpers/build-test-server.js";

function createManager(overrides: { drainMs?: number; timeoutMs?: number } = {}) {
  const exit = vi.fn<(code: number) => void>();
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

  const manager = new ShutdownManager({
    logger: silentLogger,
    drainMs: overrides.drainMs ?? 5_000,
    timeoutMs: overrides.timeoutMs ?? 15_000,
    exit,
    sleep,
  });

  return { manager, exit, sleep };
}

describe("ShutdownManager", () => {
  it("starts in 'starting' and only becomes ready when told", () => {
    const { manager } = createManager();

    expect(manager.getState()).toBe("starting");
    expect(manager.isAcceptingTraffic()).toBe(false);

    manager.markReady();

    expect(manager.getState()).toBe("ready");
    expect(manager.isAcceptingTraffic()).toBe(true);
  });

  it("drains BEFORE running teardown hooks", async () => {
    // Closing the server the instant SIGTERM arrives connection-refuses requests
    // the load balancer already dispatched. Order here is the whole fix.
    const order: string[] = [];
    const { manager, sleep } = createManager({ drainMs: 5_000 });
    sleep.mockImplementation(async () => {
      order.push(`drain:${manager.getState()}`);
    });
    manager.markReady();
    manager.register({ name: "http", run: async () => void order.push("http") });

    await manager.shutdown("SIGTERM");

    expect(order).toEqual(["drain:draining", "http"]);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("runs hooks in registration order", async () => {
    const order: string[] = [];
    const { manager, exit } = createManager({ drainMs: 0 });
    manager.register({ name: "http", run: async () => void order.push("http") });
    manager.register({ name: "redis", run: async () => void order.push("redis") });
    manager.register({ name: "postgres", run: async () => void order.push("postgres") });

    await manager.shutdown("SIGTERM");

    expect(order).toEqual(["http", "redis", "postgres"]);
    expect(manager.getState()).toBe("closed");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("continues past a failing hook and exits non-zero", async () => {
    // Failing to close Redis must not leave the Postgres pool open.
    const order: string[] = [];
    const { manager, exit } = createManager({ drainMs: 0 });
    manager.register({
      name: "redis",
      run: async () => {
        throw new Error("redis close failed");
      },
    });
    manager.register({ name: "postgres", run: async () => void order.push("postgres") });

    await manager.shutdown("SIGTERM");

    expect(order).toEqual(["postgres"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("is idempotent — a second signal does not re-run teardown", async () => {
    let runs = 0;
    const { manager, exit } = createManager({ drainMs: 0 });
    manager.register({ name: "http", run: async () => void (runs += 1) });

    await Promise.all([manager.shutdown("SIGTERM"), manager.shutdown("SIGTERM")]);

    expect(runs).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("force-exits when a hook wedges past the deadline", async () => {
    // Without this the process becomes a zombie the orchestrator has to SIGKILL,
    // which drops every in-flight request.
    const { manager, exit } = createManager({ drainMs: 0, timeoutMs: 20 });
    manager.register({ name: "wedged", run: () => new Promise<void>(() => {}) });

    void manager.shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(exit).toHaveBeenCalledWith(1);
    expect(manager.getState()).toBe("draining");
  });

  it("propagates a non-zero initial exit code (e.g. uncaught exception)", async () => {
    const { manager, exit } = createManager({ drainMs: 0 });

    await manager.shutdown("uncaughtException", 1);

    expect(exit).toHaveBeenCalledWith(1);
  });
});
