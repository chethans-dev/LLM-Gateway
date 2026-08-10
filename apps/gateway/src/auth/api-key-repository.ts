import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { apiKeys, type ApiKeyRow } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import type { Logger } from "../observability/logger.js";
import { generateApiKey, hashApiKey, type GeneratedApiKey } from "./api-key.js";

export type Database = NodePgDatabase<typeof schema>;

/** What the rest of the system knows about an authenticated caller. */
export interface ApiKeyIdentity {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
}

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly status: "active" | "revoked";
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface CreatedApiKey extends ApiKeySummary {
  /** The raw key. Present ONLY here, only once — never persisted, never re-readable. */
  readonly key: string;
}

export interface ApiKeyRepository {
  /** Returns the identity for an active key, or undefined. */
  findActiveByKey(rawKey: string): Promise<ApiKeyIdentity | undefined>;
  create(name: string): Promise<CreatedApiKey>;
  list(): Promise<readonly ApiKeySummary[]>;
  revoke(id: string): Promise<boolean>;
  /** Fire-and-forget freshness stamp. Never awaited on the request path. */
  touch(id: string): void;
}

/**
 * How often a single key's `last_used_at` may be written.
 *
 * Without a throttle this is a database write on every request — turning a
 * read-only auth check into write amplification on the hottest path in the
 * system, for a column whose useful resolution is "roughly when".
 */
const TOUCH_INTERVAL_MS = 60_000;

export interface ApiKeyRepositoryDeps {
  readonly db: Database;
  readonly logger?: Logger;
  readonly now?: () => number;
}

export function createApiKeyRepository(deps: ApiKeyRepositoryDeps): ApiKeyRepository {
  const { db, logger } = deps;
  const now = deps.now ?? (() => Date.now());
  const lastTouched = new Map<string, number>();

  return {
    async findActiveByKey(rawKey: string): Promise<ApiKeyIdentity | undefined> {
      // Look up BY HASH. The raw key never reaches a query parameter, a query
      // log, or a slow-query report.
      const rows = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, hashApiKey(rawKey)), eq(apiKeys.status, "active")))
        .limit(1);

      return rows[0];
    },

    async create(name: string): Promise<CreatedApiKey> {
      const generated: GeneratedApiKey = generateApiKey();

      const rows = await db
        .insert(apiKeys)
        .values({
          name,
          keyHash: generated.keyHash,
          keyPrefix: generated.keyPrefix,
        })
        .returning();

      const row = rows[0];
      if (row === undefined) throw new Error("failed to create api key");

      return { ...toSummary(row), key: generated.key };
    },

    async list(): Promise<readonly ApiKeySummary[]> {
      // Selects explicit columns — `key_hash` must never leave the database,
      // and `select()` with no argument would happily include it.
      const rows = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          status: apiKeys.status,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .orderBy(desc(apiKeys.createdAt));

      return rows;
    },

    async revoke(id: string): Promise<boolean> {
      // Revocation is a status change, not a delete: the request history in
      // Phase 9 references these rows, and "who made this call" must survive
      // the key being turned off.
      const rows = await db
        .update(apiKeys)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.status, "active")))
        .returning({ id: apiKeys.id });

      lastTouched.delete(id);
      return rows.length > 0;
    },

    touch(id: string): void {
      const previous = lastTouched.get(id);
      const timestamp = now();
      if (previous !== undefined && timestamp - previous < TOUCH_INTERVAL_MS) return;
      lastTouched.set(id, timestamp);

      // Deliberately not awaited. A failure to record "last used" must never
      // fail a request that was otherwise perfectly authenticated.
      void db
        .update(apiKeys)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(apiKeys.id, id))
        .catch((error: unknown) => {
          logger?.debug({ err: error, apiKeyId: id }, "failed to record api key usage");
        });
    },
  };
}

function toSummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    status: row.status,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}
