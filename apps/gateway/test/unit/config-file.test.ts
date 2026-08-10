import { describe, expect, it } from "vitest";
import { ConfigFileError, loadConfigFile } from "../../src/config/file.js";
import { loadConfig } from "../../src/config/index.js";

/** A readFile stub: known paths return content, everything else "does not exist". */
function files(contents: Record<string, string>) {
  return (path: string): string => {
    const found = contents[path];
    if (found === undefined) throw new Error(`ENOENT: ${path}`);
    return found;
  };
}

const noFiles = files({});

describe("loadConfigFile", () => {
  it("returns an empty config when no file exists", () => {
    expect(loadConfigFile({ path: undefined, readFile: noFiles })).toEqual({
      file: {},
      path: undefined,
    });
  });

  it("discovers openllm.yaml by default", () => {
    const result = loadConfigFile({
      path: undefined,
      readFile: files({ "openllm.yaml": "models:\n  fast:\n    - mock\n" }),
    });

    expect(result.path).toBe("openllm.yaml");
    expect(result.file.models).toEqual({ fast: ["mock"] });
  });

  it("errors when an explicitly configured file is missing", () => {
    // The operator asked for that file. Starting with no routes would mean every
    // aliased model 404s at runtime instead of failing at boot.
    expect(() => loadConfigFile({ path: "custom.yaml", readFile: noFiles })).toThrow(/ENOENT/);
  });

  it("treats an empty file as no overrides", () => {
    expect(loadConfigFile({ path: "c.yaml", readFile: files({ "c.yaml": "" }) }).file).toEqual({});
  });

  it("reports a YAML syntax error against the file path", () => {
    expect(() =>
      loadConfigFile({ path: "c.yaml", readFile: files({ "c.yaml": "models:\n  - [unclosed" }) }),
    ).toThrow(ConfigFileError);
  });

  it("rejects an unknown top-level key rather than ignoring it", () => {
    // `route:` instead of `routes:` would otherwise be silently dropped, leaving
    // the operator wondering why fallback never fires.
    expect(() =>
      loadConfigFile({ path: "c.yaml", readFile: files({ "c.yaml": "route:\n  fast:\n    - mock" }) }),
    ).toThrow(ConfigFileError);
  });

  it("rejects an empty model list", () => {
    expect(() =>
      loadConfigFile({ path: "c.yaml", readFile: files({ "c.yaml": "models:\n  fast: []" }) }),
    ).toThrow(/at least one model/);
  });

  it("parses routes with an explicit strategy", () => {
    const result = loadConfigFile({
      path: "c.yaml",
      readFile: files({
        "c.yaml": "routes:\n  fast:\n    strategy: fallback\n    models:\n      - mock\n",
      }),
    });

    expect(result.file.routes?.["fast"]).toEqual({ strategy: "fallback", models: ["mock"] });
  });

  it("has no way to express an API key", () => {
    // Config files get committed; keys in them get committed too. Credentials
    // come from the environment, structure comes from YAML.
    expect(() =>
      loadConfigFile({
        path: "c.yaml",
        readFile: files({ "c.yaml": "providers:\n  openai:\n    apiKey: sk-leaked\n" }),
      }),
    ).toThrow(ConfigFileError);
  });
});

describe("loadConfig with a config file", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost:5432/openllm",
    REDIS_URL: "redis://localhost:6379",
    OPENAI_API_KEY: "sk-test",
  };

  it("lets the file disable a provider the environment enabled", () => {
    const config = loadConfig(
      { ...env, CONFIG_FILE: "c.yaml" },
      { readFile: files({ "c.yaml": "providers:\n  openai:\n    enabled: false\n" }) },
    );

    expect(config.providers.openai.enabled).toBe(false);
  });

  it("cannot enable a provider that has no credential", () => {
    // "Enabled" with no way to authenticate is not a state worth expressing.
    const config = loadConfig(
      { ...env, CONFIG_FILE: "c.yaml" },
      { readFile: files({ "c.yaml": "providers:\n  gemini:\n    enabled: true\n" }) },
    );

    expect(config.providers.gemini.enabled).toBe(false);
  });

  it("loads routes from both models and routes blocks", () => {
    const config = loadConfig(
      { ...env, CONFIG_FILE: "c.yaml" },
      {
        readFile: files({
          "c.yaml": [
            "models:",
            "  cheap:",
            "    - mock",
            "routes:",
            "  fast:",
            "    strategy: fallback",
            "    models:",
            "      - mock/rate-limited",
            "      - mock",
            "",
          ].join("\n"),
        }),
      },
    );

    expect(config.routing.configFile).toBe("c.yaml");
    expect(config.routing.routes.map((r) => r.name).sort()).toEqual(["cheap", "fast"]);
  });

  it("works with no config file at all", () => {
    const config = loadConfig(env, { readFile: noFiles });

    expect(config.routing.routes).toEqual([]);
    expect(config.routing.configFile).toBeUndefined();
  });
});
