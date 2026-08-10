/**
 * Provider identity.
 *
 * This lives in `core` rather than in the gateway because it is vocabulary the
 * dashboard also speaks: request rows, provider breakdowns, and health displays
 * are all keyed by provider. The wire contracts (ChatRequest, ChatResponse, …)
 * stay inside the gateway, where they have exactly one consumer.
 *
 * Adding a provider means adding one entry here plus the implementation. A union
 * rather than a bare string so a typo is a compile error, not a silent
 * "provider not found" at runtime.
 */
export const PROVIDER_IDS = ["openai", "gemini", "anthropic", "ollama", "mock"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}
