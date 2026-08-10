import { LLMError, type ProviderId } from "@openllm/core";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./provider.js";
import type { FetchLike } from "./transport.js";

export interface ProviderRegistry {
  get(id: ProviderId): LLMProvider | undefined;
  /** Throws a client-meaningful error when the provider is not configured. */
  require(id: ProviderId): LLMProvider;
  has(id: ProviderId): boolean;
  list(): readonly LLMProvider[];
  enabledIds(): readonly ProviderId[];
}

export interface ProviderRegistryDeps {
  /** Injected in tests so no adapter ever reaches the network. */
  readonly fetch?: FetchLike;
}

/**
 * Build the set of usable providers from configuration.
 *
 * Only configured providers are constructed. The alternative — instantiate
 * everything and fail at call time — produces a gateway that advertises models
 * it cannot serve and only discovers the missing credential under real traffic.
 */
export function createProviderRegistry(
  config: AppConfig,
  logger: Logger,
  deps: ProviderRegistryDeps = {},
): ProviderRegistry {
  const providers = new Map<ProviderId, LLMProvider>();
  const { providers: settings } = config;

  if (settings.openai.enabled && settings.openai.apiKey !== undefined) {
    providers.set(
      "openai",
      new OpenAIProvider({
        apiKey: settings.openai.apiKey,
        baseUrl: settings.openai.baseUrl,
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      }),
    );
  }

  if (settings.gemini.enabled && settings.gemini.apiKey !== undefined) {
    providers.set(
      "gemini",
      new GeminiProvider({
        apiKey: settings.gemini.apiKey,
        baseUrl: settings.gemini.baseUrl,
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      }),
    );
  }

  if (settings.anthropic.enabled && settings.anthropic.apiKey !== undefined) {
    providers.set(
      "anthropic",
      new AnthropicProvider({
        apiKey: settings.anthropic.apiKey,
        baseUrl: settings.anthropic.baseUrl,
        version: settings.anthropic.version,
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      }),
    );
  }

  if (settings.ollama.enabled && settings.ollama.baseUrl !== undefined) {
    providers.set(
      "ollama",
      new OllamaProvider({
        baseUrl: settings.ollama.baseUrl,
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      }),
    );
  }

  if (settings.mock.enabled) {
    providers.set(
      "mock",
      new MockProvider({
        latencyMs: settings.mock.latencyMs,
        chunkDelayMs: settings.mock.chunkDelayMs,
        failureRate: settings.mock.failureRate,
      }),
    );
  }

  // Enabled provider IDs only — never keys, never base URLs that might embed
  // credentials. Operators need to see at a glance what this instance can serve.
  logger.info(
    { providers: [...providers.keys()], count: providers.size },
    providers.size > 0 ? "providers configured" : "no providers configured",
  );

  return {
    get: (id) => providers.get(id),
    has: (id) => providers.has(id),
    list: () => [...providers.values()],
    enabledIds: () => [...providers.keys()],
    require(id) {
      const provider = providers.get(id);
      if (provider === undefined) {
        // MODEL_NOT_FOUND rather than an internal error: from the caller's side
        // this model genuinely is not available here, and 404 is the honest
        // answer. The message names the missing setting so the operator does not
        // have to go source-diving.
        throw LLMError.modelNotFound(
          `Provider '${id}' is not configured on this gateway. Set ${credentialEnvVar(id)} to enable it.`,
          { provider: id, details: { configured: [...providers.keys()] } },
        );
      }
      return provider;
    },
  };
}

function credentialEnvVar(id: ProviderId): string {
  switch (id) {
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "ollama":
      return "OLLAMA_BASE_URL";
    case "mock":
      return "MOCK_PROVIDER_ENABLED";
  }
}
