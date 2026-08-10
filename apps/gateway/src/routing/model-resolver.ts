import { LLMError, isProviderId, type ProviderId } from "@openllm/core";

export interface ResolvedModel {
  readonly provider: ProviderId;
  /** The model name as the provider itself knows it. */
  readonly model: string;
  readonly source: "explicit-prefix" | "known-prefix";
}

/**
 * Spec §8 Level 1 — explicit model resolution.
 *
 * Phase 6 layers aliases, routes and fallback strategies on top of this. It is
 * implemented here because `/v1/chat/completions` cannot function without *some*
 * way to decide which provider serves `gpt-4.1-mini`.
 *
 * Two rules, in order:
 *
 *  1. **`provider/model`** — an explicit prefix that is a known provider always
 *     wins. This is the unambiguous form and the only way to reach Ollama,
 *     whose model names are arbitrary local strings.
 *  2. **Known model-name prefixes** — so that a client can send `gpt-4.1-mini`
 *     unchanged, which is the entire point of being OpenAI-compatible.
 *
 * Anything else is refused with a message explaining the qualified form, rather
 * than guessed at. Guessing sends a request (and money) to a provider the caller
 * did not ask for.
 */
const KNOWN_MODEL_PREFIXES: readonly { readonly prefix: string; readonly provider: ProviderId }[] = [
  { prefix: "gpt-", provider: "openai" },
  { prefix: "chatgpt-", provider: "openai" },
  { prefix: "o1", provider: "openai" },
  { prefix: "o3", provider: "openai" },
  { prefix: "o4", provider: "openai" },
  { prefix: "claude-", provider: "anthropic" },
  { prefix: "gemini-", provider: "gemini" },
  { prefix: "mock", provider: "mock" },
];

export function resolveModel(requested: string): ResolvedModel {
  const trimmed = requested.trim();

  if (trimmed === "") {
    throw LLMError.invalidRequest("'model' must not be empty");
  }

  // Split on the FIRST slash only. Models on OpenAI-compatible servers are
  // routinely namespaced (`meta-llama/Llama-3-70B`), so `openai/meta-llama/...`
  // has to keep the remainder intact.
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    const rest = trimmed.slice(slash + 1);

    if (isProviderId(prefix) && rest.length > 0) {
      return { provider: prefix, model: rest, source: "explicit-prefix" };
    }
    // A non-provider prefix is part of the model name, not a routing
    // instruction — fall through rather than reject.
  }

  const lower = trimmed.toLowerCase();
  for (const { prefix, provider } of KNOWN_MODEL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { provider, model: trimmed, source: "known-prefix" };
    }
  }

  throw LLMError.modelNotFound(
    `Cannot determine a provider for model '${trimmed}'. ` +
      `Qualify it as 'provider/model' — for example 'openai/${trimmed}' or 'ollama/${trimmed}'.`,
    { model: trimmed },
  );
}
