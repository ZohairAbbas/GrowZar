import { describe, expect, it } from "vitest";

import { convertAmount, convertMoneyTree, foreignLines, monthEndsDue, pickRate } from "./fx";

describe("converting into the book's currency (v1.1 V1)", () => {
  it("amount × rate at 6 places, half away from zero", () => {
    expect(convertAmount("100.00", "75.5")).toBe("7550.000000");
    expect(convertAmount("-12.5", "75.439017")).toBe("-942.987713");
    expect(convertAmount("0.000001", "0.5")).toBe("0.000001");
    expect(convertAmount("abc", "75")).toBeNull();
    expect(convertAmount("1", "0")).toBeNull();
  });

  it("every amount in the order's currency converts; other values stay as they were", () => {
    const o = { currency: { code: "AED" }, money: { placed: { amount: "10", currency: "AED" } }, refunds: [{ total: { amount: "4", currency: "AED" }, note: "x" }], other: { amount: "1", currency: "PKR" } };
    expect(convertMoneyTree(o, "AED", "PKR", "75")).toEqual({
      currency: { code: "AED" },
      money: { placed: { amount: "750.000000", currency: "PKR" } },
      refunds: [{ total: { amount: "300.000000", currency: "PKR" }, note: "x" }],
      other: { amount: "1", currency: "PKR" },
    });
    expect(convertMoneyTree({ a: { amount: "nope", currency: "AED" } }, "AED", "PKR", "75")).toBeNull();
  });

  it("the day's rate, else the latest within a week before it", () => {
    const rates = [
      { currency: "AED", day: "2026-07-01", rate: "75", source: "s" },
      { currency: "AED", day: "2026-07-03", rate: "76", source: "s" },
      { currency: "USD", day: "2026-07-03", rate: "277", source: "s" },
    ];
    expect(pickRate(rates, "AED", "2026-07-03")).toEqual({ rate: "76", day: "2026-07-03", source: "s" });
    expect(pickRate(rates, "AED", "2026-07-02")).toEqual({ rate: "75", day: "2026-07-01", source: "s" });
    expect(pickRate(rates, "AED", "2026-07-11")).toBeNull();
    expect(pickRate(rates, "SAR", "2026-07-03")).toBeNull();
  });

  it("month ends to revalue: from the book's start to the last one over", () => {
    expect(monthEndsDue("2026-07-15", "2026-10-02")).toEqual(["2026-07-31", "2026-08-31", "2026-09-30"]);
    expect(monthEndsDue("2026-10-01", "2026-10-31")).toEqual([]);
  });
});

describe("what a store in another currency is owed, kept in that currency (v1.1 V1b)", () => {
  const toBook = (f: bigint) => f * 76n; // PKR minor per AED minor at the day's rate
  it("book and foreign amounts the same way: one line with its foreign amount", () => {
    const r = foreignLines(new Map([["owed-aed", 755_000n], ["sales", -755_000n]]), new Map([["owed-aed", 10_000n]]), toBook, "gains");
    expect([...r.sums]).toEqual([["owed-aed", 755_000n], ["sales", -755_000n]]);
    expect(r.fx).toEqual({ "owed-aed": { amount: "10000" } });
  });
  it("a change that's only a rate's worth goes to exchange gains and losses", () => {
    const r = foreignLines(new Map([["owed-aed", 300n], ["sales", -300n]]), new Map([["owed-aed", 0n]]), toBook, "gains");
    expect(Object.fromEntries(r.sums)).toEqual({ sales: -300n, gains: 300n });
    expect(r.fx).toEqual({});
  });
  it("book and foreign amounts disagreeing: the foreign amount at the day's rate, the rest exchange", () => {
    const r = foreignLines(new Map([["owed-aed", -100n], ["returns", 100n]]), new Map([["owed-aed", 5n]]), toBook, "gains");
    expect(Object.fromEntries(r.sums)).toEqual({ "owed-aed": 380n, returns: 100n, gains: -480n });
    expect(r.fx).toEqual({ "owed-aed": { amount: "5" } });
    expect([...r.sums.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });
});
