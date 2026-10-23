import { describe, expect, it } from "vitest";

import { realiseExchange, type PostingLine } from "../posting";

const line = (accountId: string, amount: bigint, fxAmount: bigint | null = null): PostingLine => ({ accountId, amount, contactId: null, description: null, fxAmount });
const sum = (ls: PostingLine[]) => ls.reduce((t, l) => t + l.amount, 0n);

describe("realised exchange differences (Growzar v1.1 V1b, D-99)", () => {
  // A USD card owing USD 100.00, carried at PKR 28,000.00 (280 per USD).
  const card = new Map([["card", { book: -2_800_000n, foreign: -10_000n }]]);

  it("paying part of it off at a dearer rate: the card moves by its carried value, the rest is a realised loss", () => {
    const out = realiseExchange([line("card", 1_420_000n, 5_000n), line("bank", -1_420_000n)], card, "gains");
    expect(out).toEqual([line("card", 1_400_000n, 5_000n), line("bank", -1_420_000n), { accountId: "gains", amount: 20_000n, contactId: null, description: "Exchange difference (realised)" }]);
    expect(sum(out)).toBe(0n);
  });

  it("paying more than it owes: only what was owed is settled at the carried rate", () => {
    const out = realiseExchange([line("card", 3_400_000n, 12_000n), line("bank", -3_400_000n)], card, "gains");
    // USD 100 settled: at the entry's rate 2,833,333, carried 2,800,000; USD 20 more is a balance the other way, at the entry's rate.
    expect(out[0]!.amount).toBe(3_400_000n - 33_333n);
    expect(out.at(-1)).toMatchObject({ accountId: "gains", amount: 33_333n });
    expect(sum(out)).toBe(0n);
  });

  it("adding to a foreign balance, or no foreign balance yet: nothing is realised", () => {
    const more = [line("card", -560_000n, -2_000n), line("ads", 560_000n)];
    expect(realiseExchange(more, card, "gains")).toEqual(more);
    expect(realiseExchange(more, new Map(), "gains")).toEqual(more);
  });

  it("an AED receivable collected at a better rate: a realised gain", () => {
    const owed = new Map([["owed-aed", { book: 755_000n, foreign: 10_000n }]]);
    const out = realiseExchange([line("owed-aed", -760_000n, -10_000n), line("bank", 760_000n)], owed, "gains");
    expect(out).toEqual([line("owed-aed", -755_000n, -10_000n), line("bank", 760_000n), { accountId: "gains", amount: -5_000n, contactId: null, description: "Exchange difference (realised)" }]);
  });
});
