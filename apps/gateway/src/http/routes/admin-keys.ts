import { LLMError } from "@openllm/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ApiKeyRepository, ApiKeySummary } from "../../auth/api-key-repository.js";

export interface AdminKeyRouteOptions {
  readonly repository: ApiKeyRepository;
}

const createKeyBodySchema = z.object({
  name: z.string().min(1).max(120),
});

const keySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  status: z.enum(["active", "revoked"]),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

/** The create response is the ONLY place a raw key ever appears. */
const createdKeySchema = keySummarySchema.extend({
  key: z.string(),
});

function toWire(summary: ApiKeySummary) {
  return {
    id: summary.id,
    name: summary.name,
    key_prefix: summary.keyPrefix,
    status: summary.status,
    created_at: summary.createdAt.toISOString(),
    last_used_at: summary.lastUsedAt?.toISOString() ?? null,
    revoked_at: summary.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Key management (spec §13).
 *
 * Guarded by the admin secret in the authentication hook, not here — this file
 * is translation only.
 *
 * The create response contains the raw key and is the single moment it exists
 * outside the caller's hands. Nothing stores it, nothing logs it, and no other
 * endpoint can produce it again. That is what "shown once" has to mean for the
 * hashing to be worth anything.
 */
export function registerAdminKeyRoutes(
  app: FastifyInstance,
  options: AdminKeyRouteOptions,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/v1/admin/keys",
    { schema: { body: createKeyBodySchema, response: { 201: createdKeySchema } } },
    async (request, reply) => {
      const created = await options.repository.create(request.body.name);

      request.log.info(
        // The prefix, never the key. This log line is the audit record.
        { apiKeyId: created.id, apiKeyName: created.name, keyPrefix: created.keyPrefix },
        "api key created",
      );

      return reply.status(201).send({ ...toWire(created), key: created.key });
    },
  );

  typed.get(
    "/v1/admin/keys",
    { schema: { response: { 200: z.object({ data: z.array(keySummarySchema) }) } } },
    async () => {
      const keys = await options.repository.list();
      return { data: keys.map(toWire) };
    },
  );

  typed.delete(
    "/v1/admin/keys/:id",
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 200: z.object({ id: z.string(), status: z.literal("revoked") }) },
      },
    },
    async (request) => {
      const revoked = await options.repository.revoke(request.params.id);

      if (!revoked) {
        // Covers both "no such key" and "already revoked". Either way the caller
        // gets a 404 and the desired end state is unchanged.
        throw LLMError.modelNotFound(`No active API key with id '${request.params.id}'`, {
          httpStatus: 404,
        });
      }

      request.log.warn({ apiKeyId: request.params.id }, "api key revoked");
      return { id: request.params.id, status: "revoked" as const };
    },
  );
}
