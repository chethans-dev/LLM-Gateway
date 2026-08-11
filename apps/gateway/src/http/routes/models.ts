import { LLMError } from "@openllm/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { RouteTable } from "../../routing/route-table.js";

export interface ModelRouteOptions {
  readonly routes: RouteTable;
  readonly registry: ProviderRegistry;
}

const modelSchema = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number(),
  owned_by: z.string(),
});

/**
 * `GET /v1/models` — OpenAI-compatible model listing.
 *
 * Exists because "OpenAI-compatible" is a promise clients hold us to in ways the
 * chat endpoint alone does not satisfy. LangChain, Open WebUI, LibreChat and
 * `client.models.list()` all call this to populate a model picker; without it
 * they get a 404 and the integration fails before a single completion is sent.
 *
 * **The list is what is CONFIGURED, not everything accepted.** Any model whose
 * name a provider prefix matches is routable — `gpt-4.1-mini` works whether or
 * not it appears here. Enumerating that set would mean asking every provider for
 * its catalogue on each call, which makes this endpoint's latency and
 * availability depend on all of them at once. Aliases and their resolved targets
 * are the set an operator actually chose, and the set a picker should offer.
 *
 * Targets are filtered to providers that are genuinely configured, so the
 * gateway never advertises a model it has no credential to serve.
 */
export function registerModelRoutes(app: FastifyInstance, options: ModelRouteOptions): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { routes, registry } = options;

  /** `owned_by` per id: the gateway owns alias names, providers own real ones. */
  function catalogue(): { id: string; object: "model"; created: number; owned_by: string }[] {
    const owners = new Map<string, string>();

    for (const name of routes.names()) {
      // An alias is the gateway's own name for a policy, not a provider's model.
      owners.set(name, "openllm");

      for (const target of routes.get(name)?.targets ?? []) {
        // Only if we could actually serve it. Advertising a model whose provider
        // has no credential turns a picker into a list of things that 401.
        if (!registry.has(target.provider)) continue;
        // `requested`, not `model`: the former is the name a CLIENT can send
        // (`mock/echo`), the latter is what the provider calls it internally
        // (`echo`). Listing the internal name advertises something the router
        // cannot resolve.
        if (!owners.has(target.requested)) owners.set(target.requested, target.provider);
      }
    }

    return [...owners.entries()]
      .map(([id, owner]) => ({
        id,
        object: "model" as const,
        // OpenAI sends a creation timestamp. We do not know one, and inventing a
        // plausible number is worse than admitting it: clients sort by this.
        created: 0,
        owned_by: owner,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  typed.get(
    "/v1/models",
    {
      schema: {
        response: { 200: z.object({ object: z.literal("list"), data: z.array(modelSchema) }) },
      },
    },
    async () => ({ object: "list" as const, data: catalogue() }),
  );

  typed.get(
    "/v1/models/*",
    {
      // Wildcard: model ids contain slashes (`mock/echo`, `ollama/qwen3`), and a
      // plain `:model` would only ever match the first segment.
      schema: { params: z.object({ "*": z.string().min(1) }), response: { 200: modelSchema } },
    },
    async (request) => {
      const id = request.params["*"];
      const found = catalogue().find((model) => model.id === id);

      if (found === undefined) {
        throw LLMError.modelNotFound(`No such model: '${id}'`, { httpStatus: 404 });
      }

      return found;
    },
  );
}
