import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Optional YAML configuration file (spec §7, §8).
 *
 * Environment variables cannot express nested lists, and model aliases and
 * fallback routes are exactly that. So structure lives in YAML while
 * **credentials stay in the environment** — a split that is deliberate, not
 * incidental:
 *
 *  - A config file gets committed. Keys in it get committed with it.
 *  - Env vars are what every secret manager, orchestrator and CI system already
 *    injects.
 *
 * There is therefore no way to put an API key in this file. `providers.*.enabled`
 * can only turn something OFF that the environment already made possible.
 */

const modelListSchema = z
  .array(z.string().min(1))
  .min(1, "must list at least one model");

export const configFileSchema = z
  .object({
    providers: z
      .record(z.string(), z.object({ enabled: z.boolean().optional() }).strict())
      .optional(),

    /**
     * Aliases (spec §8 Level 2). A name mapped to one or more models.
     *
     * Sugar for a `routes` entry with the default strategy — see route-table.ts
     * for why the two are unified rather than kept as parallel mechanisms.
     */
    models: z.record(z.string(), modelListSchema).optional(),

    /**
     * Per-model pricing (spec §16), merged over the built-in defaults.
     *
     * Lives in config rather than in code because provider prices change and
     * nobody should need a redeploy to correct a cost figure. Keys match a model
     * exactly or by prefix, so `gpt-4.1-mini` covers its dated snapshots.
     */
    pricing: z
      .record(
        z.string(),
        z
          .object({
            /** USD per million input tokens. */
            input: z.number().nonnegative(),
            /** USD per million output tokens. */
            output: z.number().nonnegative(),
          })
          .strict(),
      )
      .optional(),

    /** Routes (spec §8 Level 3): the same thing, with an explicit strategy. */
    routes: z
      .record(
        z.string(),
        z
          .object({
            // A union of one today. Round-robin, least-latency and lowest-cost
            // are designed for but deliberately not implemented (spec §8).
            strategy: z.enum(["fallback"]).default("fallback"),
            models: modelListSchema,
          })
          .strict(),
      )
      .optional(),
  })
  // Strict: a typo'd top-level key (`route:` instead of `routes:`) would
  // otherwise be silently ignored and the operator would be left wondering why
  // their fallback never fires.
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;

export class ConfigFileError extends Error {
  override readonly name = "ConfigFileError";
  constructor(
    readonly path: string,
    readonly issues: readonly string[],
  ) {
    super(`Invalid config file ${path}:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  }
}

export interface LoadConfigFileOptions {
  /** Explicit path from CONFIG_FILE. Its absence is an error. */
  readonly path: string | undefined;
  /** Tried in order when no explicit path is given. Absence is fine. */
  readonly defaultPaths?: readonly string[];
  /** Injected in tests. */
  readonly readFile?: (path: string) => string;
}

const DEFAULT_PATHS = ["openllm.yaml", "openllm.yml"] as const;

/**
 * Load and validate the config file, if there is one.
 *
 * An explicitly configured path that does not exist is a hard error: the
 * operator asked for that file, and silently starting with no routes would mean
 * every aliased model 404s at runtime instead of failing at boot.
 */
export function loadConfigFile(options: LoadConfigFileOptions = { path: undefined }): {
  readonly file: ConfigFile;
  readonly path: string | undefined;
} {
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  if (options.path !== undefined) {
    return { file: parseAndValidate(options.path, read(options.path)), path: options.path };
  }

  for (const candidate of options.defaultPaths ?? DEFAULT_PATHS) {
    let contents: string;
    try {
      contents = read(candidate);
    } catch {
      continue; // Not there — that is the normal case.
    }
    return { file: parseAndValidate(candidate, contents), path: candidate };
  }

  return { file: {}, path: undefined };
}

function parseAndValidate(path: string, contents: string): ConfigFile {
  let raw: unknown;
  try {
    raw = parseYaml(contents);
  } catch (error) {
    throw new ConfigFileError(path, [
      error instanceof Error ? error.message : "could not be parsed as YAML",
    ]);
  }

  // An empty file parses to null, which is a legitimate "no overrides".
  if (raw === null || raw === undefined) return {};

  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigFileError(
      path,
      parsed.error.issues.map((issue) => {
        const where = issue.path.join(".") || "(root)";
        return `${where}: ${issue.message}`;
      }),
    );
  }

  return parsed.data;
}
