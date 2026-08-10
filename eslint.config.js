import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.tsbuildinfo"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // Spec §22: no `any` unless genuinely unavoidable. Make it a deliberate,
      // reviewable act via an inline eslint-disable rather than an accident.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Spec §24: structured logging only. Every runtime message goes through pino.
      "no-console": "error",
      // `null: "ignore"` permits `x == null` / `x != null`, which is exactly
      // "null or undefined" and nothing else. Provider payloads are full of
      // `string | null | undefined` fields, and the explicit alternative
      // (`x !== null && x !== undefined`) is longer without being safer.
      // Every other loose comparison stays an error.
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },

  {
    // Spec §22: centralized configuration. `process.env` is read exactly once,
    // inside src/config, and everything downstream receives a typed AppConfig.
    files: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    ignores: ["apps/*/src/config/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read values from AppConfig instead. process.env is only allowed in src/config.",
        },
      ],
    },
  },

  {
    files: ["**/test/**/*.ts", "**/*.test.ts", "**/*.config.ts", "eslint.config.js"],
    rules: {
      "no-restricted-properties": "off",
      "no-console": "off",
    },
  },
);
