export type { LLMProvider } from "./provider.js";

export { createProviderRegistry } from "./registry.js";
export type { ProviderRegistry, ProviderRegistryDeps } from "./registry.js";

export { AnthropicProvider } from "./anthropic.js";
export { GeminiProvider } from "./gemini.js";
export { MockProvider, MOCK_BEHAVIOURS, parseBehaviour } from "./mock.js";
export type { MockBehaviour, MockProviderOptions } from "./mock.js";
export { OllamaProvider } from "./ollama.js";
export { OpenAIProvider } from "./openai.js";

export { foldSystemPrompt, mergeConsecutiveMessages, splitSystemMessages } from "./messages.js";
export type { SplitMessages } from "./messages.js";

export { addTokenUsage, createTokenUsage } from "./usage.js";

export { parseNdjson, parseSSE, readLines } from "./stream-parsers.js";
export type { SSEEvent } from "./stream-parsers.js";

export {
  errorCodeFromStatus,
  extractErrorMessage,
  normalizeFetchError,
  normalizeStreamError,
  parseRetryAfter,
} from "./transport.js";
export type { FetchLike } from "./transport.js";

export type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatRole,
  FinishReason,
  ProviderCallOptions,
  ProviderCapabilities,
  TokenUsage,
} from "./types.js";
