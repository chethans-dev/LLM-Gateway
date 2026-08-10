import { describe, expect, it } from "vitest";
import {
  buildRouteTable,
  planTargets,
  RouteConfigError,
  toRouteDefinitions,
} from "../../src/routing/route-table.js";

describe("buildRouteTable", () => {
  it("resolves each target to a provider at build time", () => {
    const table = buildRouteTable([
      { name: "fast", models: ["gemini-2.5-flash", "gpt-4.1-mini"] },
    ]);

    expect(table.get("fast")?.targets).toEqual([
      { provider: "gemini", model: "gemini-2.5-flash", requested: "gemini-2.5-flash" },
      { provider: "openai", model: "gpt-4.1-mini", requested: "gpt-4.1-mini" },
    ]);
  });

  it("strips the provider prefix so adapters never see routing syntax", () => {
    const table = buildRouteTable([{ name: "local", models: ["ollama/qwen3"] }]);

    expect(table.get("local")?.targets[0]).toEqual({
      provider: "ollama",
      model: "qwen3",
      requested: "ollama/qwen3",
    });
  });

  it("defaults to the fallback strategy", () => {
    expect(buildRouteTable([{ name: "fast", models: ["mock"] }]).get("fast")?.strategy).toBe(
      "fallback",
    );
  });

  it("rejects an unroutable model at BOOT, not at request time", () => {
    // A fallback route exists precisely for when things are already going wrong.
    // Discovering it was misconfigured during an incident is the worst timing.
    expect(() => buildRouteTable([{ name: "fast", models: ["no-such-vendor-model"] }])).toThrow(
      RouteConfigError,
    );
  });

  it("cannot catch a typo that still matches a known prefix — documented limit", () => {
    // `gemini-2.5-flsah` is routable (the `gemini-` prefix resolves), so boot
    // validation accepts it and Google returns the 404. Verifying model
    // existence would mean calling every provider at startup, turning boot into
    // a network dependency — a worse trade than this gap.
    expect(() => buildRouteTable([{ name: "fast", models: ["gemini-2.5-flsah"] }])).not.toThrow();
  });

  it("names the route and the bad model in the failure", () => {
    let thrown: unknown;
    try {
      buildRouteTable([{ name: "fast", models: ["mock", "totally-unknown-model"] }]);
    } catch (error) {
      thrown = error;
    }

    const issues = (thrown as RouteConfigError).issues.join("\n");
    expect(issues).toContain("fast");
    expect(issues).toContain("totally-unknown-model");
  });

  it("reports every bad route at once", () => {
    let thrown: unknown;
    try {
      buildRouteTable([
        { name: "a", models: ["bogus-one"] },
        { name: "b", models: ["bogus-two"] },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as RouteConfigError).issues).toHaveLength(2);
  });

  it("rejects a duplicate route name instead of guessing which wins", () => {
    expect(() =>
      buildRouteTable([
        { name: "fast", models: ["mock"] },
        { name: "fast", models: ["gpt-4.1-mini"] },
      ]),
    ).toThrow(/defined more than once/);
  });

  it("refuses a route name that would shadow a real model", () => {
    // Otherwise requests for gpt-4.1-mini would silently go elsewhere, and the
    // shadowing would be invisible from the request alone.
    expect(() => buildRouteTable([{ name: "gpt-4.1-mini", models: ["mock"] }])).toThrow(
      /shadow/,
    );
  });

  it("rejects an empty route name", () => {
    expect(() => buildRouteTable([{ name: "   ", models: ["mock"] }])).toThrow(RouteConfigError);
  });
});

describe("toRouteDefinitions", () => {
  it("treats a models alias as a fallback route", () => {
    // `models:` and `routes:` are two spellings of one idea — a name mapped to an
    // ordered list. Keeping them separate would raise "which wins?" with no good
    // answer.
    const definitions = toRouteDefinitions({ models: { fast: ["mock", "gpt-4.1-mini"] } });

    expect(definitions).toEqual([{ name: "fast", models: ["mock", "gpt-4.1-mini"] }]);
  });

  it("carries an explicit strategy through", () => {
    const definitions = toRouteDefinitions({
      routes: { fast: { strategy: "fallback", models: ["mock"] } },
    });

    expect(definitions[0]).toMatchObject({ name: "fast", strategy: "fallback" });
  });

  it("surfaces a name defined in both blocks so the table can reject it", () => {
    const definitions = toRouteDefinitions({
      models: { fast: ["mock"] },
      routes: { fast: { strategy: "fallback", models: ["gpt-4.1-mini"] } },
    });

    expect(definitions).toHaveLength(2);
    expect(() => buildRouteTable(definitions)).toThrow(/defined more than once/);
  });
});

describe("planTargets", () => {
  const table = buildRouteTable([{ name: "fast", models: ["mock", "gpt-4.1-mini"] }]);

  it("prefers a route over model-name inference", () => {
    const plan = planTargets("fast", table);

    expect(plan.route?.name).toBe("fast");
    expect(plan.targets).toHaveLength(2);
  });

  it("falls through to explicit resolution for a non-route model", () => {
    const plan = planTargets("gpt-4.1-mini", table);

    expect(plan.route).toBeUndefined();
    expect(plan.targets).toEqual([
      { provider: "openai", model: "gpt-4.1-mini", requested: "gpt-4.1-mini" },
    ]);
  });

  it("rejects an empty model", () => {
    expect(() => planTargets("   ", table)).toThrow(/must not be empty/);
  });

  it("rejects an unknown model with guidance rather than guessing a provider", () => {
    // Guessing sends a request, and money, to a provider nobody asked for.
    expect(() => planTargets("some-new-model", table)).toThrow(/provider\/model/);
  });
});
