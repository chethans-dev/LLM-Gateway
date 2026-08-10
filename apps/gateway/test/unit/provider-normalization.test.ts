import { describe, expect, it } from "vitest";
import { foldSystemPrompt, splitSystemMessages } from "../../src/providers/messages.js";
import { addTokenUsage, createTokenUsage } from "../../src/providers/usage.js";
import type { ChatMessage } from "../../src/providers/types.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const system = (content: string): ChatMessage => ({ role: "system", content });

describe("splitSystemMessages", () => {
  it("returns no system prompt when there are none", () => {
    const result = splitSystemMessages([user("hi")]);

    expect(result.system).toBeUndefined();
    expect(result.conversation).toEqual([user("hi")]);
  });

  it("extracts a single system prompt and leaves the conversation intact", () => {
    const result = splitSystemMessages([system("Be terse."), user("hi"), assistant("hello")]);

    expect(result.system).toBe("Be terse.");
    expect(result.conversation).toEqual([user("hi"), assistant("hello")]);
  });

  it("joins multiple system messages in order", () => {
    // OpenAI permits several; Anthropic and Gemini take exactly one.
    const result = splitSystemMessages([system("Be terse."), system("Use British spelling."), user("hi")]);

    expect(result.system).toBe("Be terse.\n\nUse British spelling.");
  });

  it("hoists a system message that appears mid-conversation", () => {
    // Fidelity loss we accept deliberately: Anthropic and Gemini cannot express
    // a positioned system turn, and consistent behaviour across providers beats
    // per-provider faithfulness for a gateway.
    const result = splitSystemMessages([user("hi"), system("Be terse."), assistant("hello")]);

    expect(result.system).toBe("Be terse.");
    expect(result.conversation).toEqual([user("hi"), assistant("hello")]);
  });

  it("ignores empty and whitespace-only system messages", () => {
    const result = splitSystemMessages([system("   "), system(""), user("hi")]);

    expect(result.system).toBeUndefined();
  });

  it("trims system content", () => {
    expect(splitSystemMessages([system("  Be terse.  ")]).system).toBe("Be terse.");
  });

  it("handles a request that is nothing but system messages", () => {
    const result = splitSystemMessages([system("Be terse.")]);

    expect(result.system).toBe("Be terse.");
    expect(result.conversation).toEqual([]);
  });

  it("does not mutate the input", () => {
    const messages = [system("Be terse."), user("hi")];
    splitSystemMessages(messages);

    expect(messages).toHaveLength(2);
  });
});

describe("foldSystemPrompt", () => {
  it("prepends the system prompt as a user turn", () => {
    // For providers with no system field. A user turn, not an assistant turn:
    // inventing assistant output would corrupt turn alternation.
    const result = foldSystemPrompt("Be terse.", [user("hi")]);

    expect(result).toEqual([user("Be terse."), user("hi")]);
  });

  it("leaves the conversation alone when there is no system prompt", () => {
    const conversation = [user("hi")];

    expect(foldSystemPrompt(undefined, conversation)).toBe(conversation);
    expect(foldSystemPrompt("   ", conversation)).toBe(conversation);
  });
});

describe("createTokenUsage", () => {
  it("computes the total rather than trusting a provider's own", () => {
    // Providers disagree about whether their total includes reasoning or cached
    // tokens; a total that isn't input + output makes downstream maths unauditable.
    expect(createTokenUsage(824, 214)).toEqual({
      inputTokens: 824,
      outputTokens: 214,
      totalTokens: 1038,
    });
  });

  it("accepts zero counts", () => {
    expect(createTokenUsage(0, 0)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("returns undefined when either count is missing", () => {
    // "We don't know" must stay distinguishable from "zero tokens", or Phase 9
    // reports a confident cost that silently understates the bill.
    expect(createTokenUsage(undefined, 5)).toBeUndefined();
    expect(createTokenUsage(10, undefined)).toBeUndefined();
    expect(createTokenUsage(null, null)).toBeUndefined();
  });

  it("rejects nonsensical counts rather than propagating them", () => {
    expect(createTokenUsage(-1, 5)).toBeUndefined();
    expect(createTokenUsage(1.5, 5)).toBeUndefined();
    expect(createTokenUsage(Number.NaN, 5)).toBeUndefined();
  });
});

describe("addTokenUsage", () => {
  it("sums usage across attempts", () => {
    // A request that failed over still burned tokens on the first provider.
    const first = createTokenUsage(100, 10);
    const second = createTokenUsage(100, 40);

    expect(addTokenUsage(first, second)).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      totalTokens: 250,
    });
  });

  it("passes through when only one side reported usage", () => {
    const usage = createTokenUsage(10, 5);

    expect(addTokenUsage(usage, undefined)).toEqual(usage);
    expect(addTokenUsage(undefined, usage)).toEqual(usage);
  });

  it("stays undefined when nothing reported usage", () => {
    expect(addTokenUsage(undefined, undefined)).toBeUndefined();
  });
});
