import { describe, expect, it } from "vitest";

import type { CashForecast } from "./cash";
import { historyRow, mondayOf } from "./cash-history";

const r = (x: number) => ({ low: x * 0.8, likely: x, high: x * 1.2 });
const f = (measured: boolean): CashForecast => ({
  asOf: "2026-10-12T06:00:00.000Z",
  currency: "PKR",
  weeks: [{ from: "2026-10-12", to: "2026-10-18" }],
  due: { byPayer: [], weeks: [r(10_000)], total: r(10_000) },
  paid: { byPayer: [{ payer: "tcs", basis: measured ? "measured" : "merchant", weeks: [r(8_000)], total: r(8_000), reason: null }], weeks: [r(8_000)], total: r(8_000) },
  untimed: [],
  overdue: [],
  notTracked: { orders: 0, expected: r(0) },
  excluded: { noOdds: 0, otherCurrency: 0 },
  basis: { open: [], held: [] },
});

describe("earlier cash forecasts against what happened (D-94)", () => {
  it("keeps a forecast under its week's Monday", () => {
    expect(mondayOf(new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-12");
    expect(mondayOf(new Date("2026-10-18T23:59:00Z"))).toBe("2026-10-12");
    expect(mondayOf(new Date("2026-10-19T00:00:00Z"))).toBe("2026-10-19");
  });

  it("the first week's forecast against delivered, paid by courier and received in bank", () => {
    const actual = new Map([["due|tcs|0", 9_000], ["due|tcs|1", 500], ["paid|tcs|0", 7_000], ["paid|tcs|2", 1_000]]);
    expect(historyRow(f(true), actual, { received: 6_500, payouts: 3, inBank: 2 })).toEqual({ from: "2026-10-12", to: "2026-10-18", due: r(10_000), dueActual: 9_000, paid: r(8_000), paidActual: 7_000, bank: { received: 6_500, payouts: 3, inBank: 2 } });
  });

  it("no paid-out forecast when no payer's cycle was measured; no bank figure without Books", () => {
    expect(historyRow(f(false), new Map(), null)).toMatchObject({ paid: null, paidActual: null, bank: null });
  });
});
