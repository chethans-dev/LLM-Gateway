import { defineConfig } from "drizzle-kit";

// drizzle-kit is a CLI run outside the application process, so it reads the
// environment directly rather than going through loadConfig().
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl === "") {
  throw new Error("DATABASE_URL must be set to run drizzle-kit");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
