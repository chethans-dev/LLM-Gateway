import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests resolve @openllm/core straight from source so `pnpm test` never requires
// a prior `pnpm build`. Production resolution still goes through packages/core/dist.
const coreSrc = fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url));
const alias = { "@openllm/core": coreSrc };

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Source only. Test helpers and generated migrations are not the thing
      // whose coverage anyone is trying to judge.
      include: ["apps/gateway/src/**/*.ts", "packages/core/src/**/*.ts"],
      exclude: [
        "**/index.ts",
        // Composition roots: a few dozen lines of wiring whose only meaningful
        // test is booting the real process, which the compose smoke test does.
        "apps/gateway/src/index.ts",
        "apps/gateway/src/version.ts",
        "apps/gateway/src/db/schema.ts",
      ],
      reporter: ["text-summary", "html", "lcov"],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["apps/*/test/unit/**/*.test.ts", "packages/*/test/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["apps/*/test/integration/**/*.test.ts"],
          // Real Redis/Postgres connections; be generous but not unbounded.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Integration tests share infrastructure — no parallel file execution.
          fileParallelism: false,
        },
      },
    ],
  },
});
