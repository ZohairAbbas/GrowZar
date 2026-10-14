import { describe, expect, it } from "vitest";

import { nextAppPrompts, type StoreFacts } from "./next-app";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
const facts: StoreFacts = {
  currency: "PKR",
  days: 90,
  returns: { orders: 200, value: pkr("400000.00") },
  unconfirmedReturns: { orders: 5, value: pkr("9000.00") },
  oneTimeBuyers: { buyers: 700, value: pkr("1200000.00") },
  untracked: { orders: 300, value: pkr("900000.00") },
  topSellers: { orders: 500, share: 41.6, variants: 60 },
  delivered: { orders: 900, value: pkr("2000000.00") },
};

describe("nextAppPrompts (G-GZR6-3)", () => {
  it("pitches only apps the store lacks, biggest measured amount first, count-only last", () => {
    const p = nextAppPrompts(facts, new Set(["FINANCIFY", "WHATKABOT"]), true);
    expect(p.map((x) => x.app)).toEqual(["RETAINIFY", "COURIERIFY", "PREVENTIFY", "INVENTORIFY"]);
    expect(p[2]).toMatchObject({ headline: "PKR 400,000 of orders came back in 90 days", amount: pkr("400000.00") });
    expect(p[3]).toMatchObject({ headline: "Your 10 best sellers are in 42% of orders, and their stock is invisible", amount: null });
  });

  it("leaves out figures too small to pitch on", () => {
    expect(nextAppPrompts(facts, new Set(), true).map((x) => x.app)).not.toContain("WHATKABOT");
    // A store selling only a handful of products: "your 10 best sellers" says nothing.
    expect(nextAppPrompts({ ...facts, topSellers: { orders: 500, share: 98, variants: 6 } }, new Set(), true).map((x) => x.app)).not.toContain("INVENTORIFY");
  });

  it("shows counts, not money, to a viewer who may not see money", () => {
    const p = nextAppPrompts(facts, new Set(["FINANCIFY", "WHATKABOT", "RETAINIFY", "COURIERIFY", "INVENTORIFY"]), false);
    expect(p).toEqual([expect.objectContaining({ app: "PREVENTIFY", headline: "200 orders came back in 90 days", amount: null })]);
  });

  it("says nothing to a store with every app", () => {
    expect(nextAppPrompts(facts, new Set(["FINANCIFY", "WHATKABOT", "RETAINIFY", "COURIERIFY", "INVENTORIFY", "PREVENTIFY"]), true)).toEqual([]);
  });
});
