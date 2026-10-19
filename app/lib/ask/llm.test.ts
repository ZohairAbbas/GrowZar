import { afterEach, describe, expect, it } from "vitest";

import { askModel, costMicros, DEFAULT_MODEL, PRICES } from "./llm.server";

describe("cost", () => {
  it("prices uncached input, cached input and output (reasoning included) per model, rounding up", () => {
    // gpt-6.1-sol: $2 / $0.10 / $10 per million tokens = micro-dollars per token.
    expect(costMicros("gpt-6.1-sol", { inputTokens: 9_371, cachedTokens: 4_419, outputTokens: 187, reasoningTokens: 0 })).toBe(Math.ceil(4_952 * 2 + 4_419 * 0.1 + 187 * 10));
    expect(costMicros("gpt-6-luna", { inputTokens: 3, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 })).toBe(1);
  });

  it("refuses a model it has no price for, so nothing escapes the cap", () => {
    expect(() => costMicros("gpt-unknown", { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 })).toThrow(/No price/);
  });
});

describe("model choice", () => {
  afterEach(() => {
    delete process.env.ASK_MODEL;
    delete process.env.ASK_REASONING;
  });

  it("defaults to the proposed model at low effort", () => {
    expect(askModel()).toEqual({ model: DEFAULT_MODEL, effort: "low" });
    expect(PRICES[DEFAULT_MODEL]).toBeDefined();
  });

  it("takes ASK_MODEL and ASK_REASONING, and rejects a model without a price", () => {
    process.env.ASK_MODEL = "gpt-6-luna";
    process.env.ASK_REASONING = "medium";
    expect(askModel()).toEqual({ model: "gpt-6-luna", effort: "medium" });
    process.env.ASK_REASONING = "max";
    expect(askModel().effort).toBe("low");
    process.env.ASK_MODEL = "gpt-9";
    expect(() => askModel()).toThrow(/no price/);
  });
});
