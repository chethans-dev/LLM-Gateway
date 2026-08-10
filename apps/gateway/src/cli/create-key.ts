import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createApiKeyRepository } from "../auth/api-key-repository.js";
import { ConfigError, loadConfig } from "../config/index.js";
import * as schema from "../db/schema.js";

/**
 * Mint an API key from the command line.
 *
 *   pnpm key:create "staging-backend"
 *   docker compose exec gateway node apps/gateway/dist/cli/create-key.js "prod"
 *
 * This exists to break the bootstrap cycle: `/v1/admin/keys` needs the admin
 * secret, and an operator who has not set one yet still needs a first key. It
 * also means a deployment can issue keys without exposing key management over
 * HTTP at all.
 *
 * Writes the key to stdout and everything else to stderr, so it can be captured:
 *
 *   KEY=$(pnpm -s key:create "ci") && export OPENLLM_API_KEY="$KEY"
 */
async function main(): Promise<void> {
  const name = process.argv[2];

  if (name === undefined || name.trim() === "") {
    process.stderr.write("usage: key:create <name>\n");
    process.exit(2);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }

  const pool = new pg.Pool({ connectionString: config.postgres.url, max: 1 });

  try {
    const repository = createApiKeyRepository({ db: drizzle(pool, { schema }) });
    const created = await repository.create(name.trim());

    process.stderr.write(
      `\nCreated API key "${created.name}" (${created.keyPrefix}…)\n` +
        `This is the only time it will be shown — store it now.\n\n`,
    );
    // stdout is the key alone, so `$(pnpm -s key:create ...)` captures exactly it.
    process.stdout.write(`${created.key}\n`);
  } catch (error) {
    process.stderr.write(
      `Failed to create API key: ${error instanceof Error ? error.message : String(error)}\n` +
        `Have migrations run? Try: pnpm db:migrate\n`,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
