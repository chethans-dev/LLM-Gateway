import { LLMError, type ProviderId } from "@openllm/core";
import { resolveModel } from "./model-resolver.js";

/**
 * Routing strategies (spec §8).
 *
 * A union of one. Round-robin, least-latency, lowest-cost and reliability-
 * weighted are named in the spec as future work; the shape here is what lets
 * them be added as new cases rather than a rewrite — the executor switches on
 * this, and `noFallthroughCasesInSwitch` will flag every site that needs
 * updating.
 */
export type RouteStrategy = "fallback";

export interface RouteTarget {
  readonly provider: ProviderId;
  /** The model name as the provider itself knows it. */
  readonly model: string;
  /** What the operator wrote in config, for error messages and logs. */
  readonly requested: string;
}

export interface Route {
  readonly name: string;
  readonly strategy: RouteStrategy;
  readonly targets: readonly RouteTarget[];
}

export interface RouteTable {
  get(name: string): Route | undefined;
  names(): readonly string[];
  size(): number;
}

/** Raw, unvalidated definitions — straight from YAML or from a test. */
export interface RouteDefinition {
  readonly name: string;
  readonly strategy?: RouteStrategy;
  readonly models: readonly string[];
}

export class RouteConfigError extends Error {
  override readonly name = "RouteConfigError";
  constructor(readonly issues: readonly string[]) {
    super(`Invalid routing configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

/**
 * Build the route table, resolving and validating every target up front.
 *
 * Resolution happens at BOOT, not per request: a model the gateway cannot route
 * to any provider becomes a startup failure with a precise message, rather than
 * a 404 the first time someone uses that alias in production. A fallback route
 * exists specifically for when things are already going wrong, so discovering it
 * was misconfigured *during* an incident is the worst possible timing.
 *
 * The limit of this check is worth being honest about: it validates that a
 * provider can be *determined*, not that the model exists. `gemini-2.5-flsah`
 * still matches the `gemini-` prefix and passes, then 404s at Google. Verifying
 * model existence would mean calling every provider at boot — turning startup
 * into a network dependency, which is a far worse trade.
 *
 * `models:` and `routes:` are unified here. They are two spellings of the same
 * idea (a name mapped to an ordered list of models), and keeping them as
 * separate mechanisms would raise a question with no good answer: which wins
 * when a name appears in both? Defining a name twice is rejected instead.
 */
export function buildRouteTable(definitions: readonly RouteDefinition[]): RouteTable {
  const routes = new Map<string, Route>();
  const issues: string[] = [];

  for (const definition of definitions) {
    const name = definition.name.trim();

    if (name === "") {
      issues.push("a route name must not be empty");
      continue;
    }

    if (routes.has(name)) {
      issues.push(
        `'${name}' is defined more than once — a name may appear under 'models' or 'routes', not both`,
      );
      continue;
    }

    // A route named after a real model would shadow it, and the shadowing would
    // be invisible: requests for `gpt-4.1-mini` would silently go somewhere else.
    if (isConcreteModel(name)) {
      issues.push(
        `'${name}' resolves to a real model, so using it as a route name would silently shadow it`,
      );
      continue;
    }

    const targets: RouteTarget[] = [];
    for (const model of definition.models) {
      try {
        const resolved = resolveModel(model);
        targets.push({ provider: resolved.provider, model: resolved.model, requested: model });
      } catch (error) {
        issues.push(
          `${name}: '${model}' — ${error instanceof Error ? error.message : "could not be resolved"}`,
        );
      }
    }

    if (targets.length > 0) {
      routes.set(name, { name, strategy: definition.strategy ?? "fallback", targets });
    }
  }

  if (issues.length > 0) throw new RouteConfigError(issues);

  return {
    get: (name) => routes.get(name),
    names: () => [...routes.keys()],
    size: () => routes.size,
  };
}

function isConcreteModel(name: string): boolean {
  try {
    resolveModel(name);
    return true;
  } catch {
    return false;
  }
}

/** An empty table, for when no routing is configured. */
export function emptyRouteTable(): RouteTable {
  return buildRouteTable([]);
}

/**
 * Flatten the YAML `models:` and `routes:` blocks into one list of definitions.
 *
 * Kept separate from `buildRouteTable` so routes can be constructed directly in
 * tests without going through YAML.
 */
export function toRouteDefinitions(source: {
  readonly models?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly routes?:
    | Readonly<Record<string, { readonly strategy: RouteStrategy; readonly models: readonly string[] }>>
    | undefined;
}): readonly RouteDefinition[] {
  const definitions: RouteDefinition[] = [];

  for (const [name, models] of Object.entries(source.models ?? {})) {
    definitions.push({ name, models });
  }

  for (const [name, route] of Object.entries(source.routes ?? {})) {
    definitions.push({ name, strategy: route.strategy, models: route.models });
  }

  return definitions;
}

/**
 * Resolve a requested model to an ordered list of targets.
 *
 * Order matters and mirrors spec §8: an alias or route wins over model-name
 * inference, so an operator can point `fast` wherever they like without the
 * gateway second-guessing them. A name that is not a route falls through to
 * Level 1 explicit resolution and yields a single target.
 */
export function planTargets(requested: string, table: RouteTable): {
  readonly route: Route | undefined;
  readonly targets: readonly RouteTarget[];
} {
  const trimmed = requested.trim();
  if (trimmed === "") throw LLMError.invalidRequest("'model' must not be empty");

  const route = table.get(trimmed);
  if (route !== undefined) return { route, targets: route.targets };

  const resolved = resolveModel(trimmed);
  return {
    route: undefined,
    targets: [{ provider: resolved.provider, model: resolved.model, requested: trimmed }],
  };
}
