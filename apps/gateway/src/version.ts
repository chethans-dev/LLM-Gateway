import { createRequire } from "node:module";

// Resolves to apps/gateway/package.json from both src/ (tsx) and dist/ (node),
// so the reported version is the packaged one and cannot drift from a constant
// somebody forgot to bump.
const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere("../package.json") as { version?: string };

export const VERSION = pkg.version ?? "0.0.0";
