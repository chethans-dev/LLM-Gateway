import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CODE_DESCRIPTORS, LLM_ERROR_CODES, PROVIDER_IDS } from "@openllm/core";
import { MOCK_BEHAVIOURS } from "../../src/providers/mock.js";
import { ENV_VAR_NAMES } from "../../src/config/env.js";

/**
 * The README is documentation people act on, and documentation drifts.
 *
 * The Phase 11 audit found the mock-behaviour table missing two entries and the
 * endpoints table missing four routes — both introduced silently, phases after
 * the text was written. These assertions turn the next such drift into a failing
 * build instead of a confused reader.
 *
 * Only claims that are mechanically checkable live here. Prose is still prose.
 */
const README = readFileSync(fileURLToPath(new URL("../../../../README.md", import.meta.url)), "utf8");
const CONFIG_DOC = readFileSync(
  fileURLToPath(new URL("../../../../docs/configuration.md", import.meta.url)),
  "utf8",
);

describe("README: the error-model table", () => {
  /** Find the table row documenting a given error code. */
  function rowFor(code: string): string | undefined {
    return README.split("\n").find((line) => line.includes(`\`${code}\``) && line.includes("|"));
  }

  it("documents every error code", () => {
    for (const code of LLM_ERROR_CODES) {
      expect(rowFor(code), `README has no row for ${code}`).toBeDefined();
    }
  });

  it("states retryable and failoverable exactly as the code defines them", () => {
    // This table is the load-bearing claim in the whole README: it is how a
    // reader decides whether the gateway will do the right thing during an
    // incident. Getting it wrong is worse than omitting it.
    for (const code of LLM_ERROR_CODES) {
      const cells = (rowFor(code) ?? "").split("|").map((cell) => cell.trim());
      const documentedRetry = cells[2]?.includes("yes") ?? false;
      const documentedFailover = cells[3]?.includes("yes") ?? false;

      expect(documentedRetry, `${code}: retryable`).toBe(ERROR_CODE_DESCRIPTORS[code].retryable);
      expect(documentedFailover, `${code}: failoverable`).toBe(
        ERROR_CODE_DESCRIPTORS[code].failoverable,
      );
    }
  });
});

describe("README: the mock provider table", () => {
  it("documents every behaviour the mock provider supports", () => {
    // `success` is the unnamed default and `echo` is documented alongside it.
    const documented = MOCK_BEHAVIOURS.filter((behaviour) => behaviour !== "success");

    for (const behaviour of documented) {
      expect(README, `README does not document mock/${behaviour}`).toContain(`mock/${behaviour}`);
    }
  });

  it("does not advertise a behaviour that does not exist", () => {
    const advertised = new Set(
      [...README.matchAll(/mock\/([a-z-]+)/g)].map((match) => match[1] as string),
    );

    for (const behaviour of advertised) {
      expect(
        (MOCK_BEHAVIOURS as readonly string[]).includes(behaviour),
        `README advertises mock/${behaviour}, which the provider does not implement`,
      ).toBe(true);
    }
  });
});

describe("README: providers", () => {
  it("names every provider the gateway can route to", () => {
    for (const provider of PROVIDER_IDS) {
      expect(README.toLowerCase(), `README never mentions ${provider}`).toContain(provider);
    }
  });
});

describe("configuration docs", () => {
  it("documents every environment variable", () => {
    // A variable that exists but is undocumented is one an operator finds by
    // reading source, which is a bug report waiting to happen.
    expect(ENV_VAR_NAMES.length).toBeGreaterThan(30);

    for (const name of ENV_VAR_NAMES) {
      expect(CONFIG_DOC, `docs/configuration.md does not document ${name}`).toContain(name);
    }
  });
});

describe("README: architecture section", () => {
  it("describes the layers a reader needs to understand the request path", () => {
    const architecture = README.slice(
      README.indexOf("## Architecture"),
      README.indexOf("## Local development"),
    );

    expect(architecture.length).toBeGreaterThan(1_000);
    for (const topic of ["Router", "LLMProvider", "Redis", "PostgreSQL", "fallback", "retry"]) {
      expect(architecture, `architecture section omits ${topic}`).toContain(topic);
    }
  });

  it("lists repository directories that actually exist", () => {
    // Checked against the real tree by the accompanying shell audit; here we
    // assert the section did not lose its layout block entirely.
    expect(README).toContain("apps/gateway/src/");
    expect(README).toContain("packages/core/");
  });
});
