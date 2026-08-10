import type { ChatMessage } from "./types.js";

export interface SplitMessages {
  /** Joined system prompt, or undefined when the request had none. */
  readonly system: string | undefined;
  /** Everything else, in original order. */
  readonly conversation: readonly ChatMessage[];
}

/**
 * Separate system messages from the conversation.
 *
 * OpenAI carries the system prompt inside the message array; Anthropic takes a
 * top-level `system` parameter and Gemini a `systemInstruction`. Every adapter
 * needs this split, so it lives here once rather than being re-derived — subtly
 * differently — in four places.
 *
 * Two decisions this makes on everyone's behalf:
 *
 *  - **Multiple system messages are joined** with a blank line, in order.
 *    OpenAI permits several; Anthropic and Gemini take one.
 *  - **A system message appearing mid-conversation is still hoisted.** This
 *    loses a little fidelity against OpenAI, which would have honoured its
 *    position. We accept that: a gateway whose behaviour changes depending on
 *    which provider happens to serve a request is worse than one that is
 *    consistently slightly simplified, and Anthropic and Gemini cannot express
 *    the original semantics at all.
 */
export function splitSystemMessages(messages: readonly ChatMessage[]): SplitMessages {
  const systemParts: string[] = [];
  const conversation: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = message.content.trim();
      // An empty system message carries no instruction; forwarding it would
      // mean sending providers a pointless empty field.
      if (text.length > 0) systemParts.push(text);
    } else {
      conversation.push(message);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    conversation,
  };
}

/**
 * Merge adjacent messages that share a role.
 *
 * OpenAI accepts `[user, user, assistant]`; Anthropic and Gemini expect turns to
 * alternate and reject or mangle repeats. Since the gateway promises that an
 * OpenAI-compatible client works unchanged, rejecting input OpenAI would have
 * accepted — purely because of which provider happened to serve it — breaks that
 * promise. Merging with a blank line preserves the content and satisfies both.
 */
export function mergeConsecutiveMessages(
  messages: readonly ChatMessage[],
): readonly ChatMessage[] {
  const merged: ChatMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.role === message.role) {
      merged[merged.length - 1] = {
        role: previous.role,
        content: `${previous.content}\n\n${message.content}`,
      };
    } else {
      merged.push(message);
    }
  }

  return merged;
}

/**
 * Fold a system prompt into the conversation for providers that have no
 * dedicated system field (`ProviderCapabilities.systemPrompt === false`).
 *
 * Prepending a user turn is the least-bad option: it keeps the instruction
 * ahead of everything else without inventing an assistant turn the model never
 * produced, which would corrupt the conversation's turn alternation.
 */
export function foldSystemPrompt(
  system: string | undefined,
  conversation: readonly ChatMessage[],
): readonly ChatMessage[] {
  if (system === undefined || system.trim().length === 0) return conversation;
  return [{ role: "user", content: system }, ...conversation];
}
