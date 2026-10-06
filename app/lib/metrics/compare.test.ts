import { describe, expect, it } from "vitest";

import {
  MIN_DECIDED_TO_RATE,
  countDelta,
  dailyCount,
  dailyMoney,
  foldThinRows,
  moneyDelta,
  previousPeriod,
  rateDelta,
  weeklyRate,
} from "./compare";
import { bucketOf, type RollupOrder } from "./rollups";
import { inScope, parseScope, scopeQuery, scopeWhere } from "./scope";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-09-20", createdAt: new Date("2026-09-20T06:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: null, cogsComplete: null, courierFee: null, outcome: "delivered", outcomeTiming: null,
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore",
    cityRaw: "Lahore", lines: [], confirmation: null, customerId: null, ...o,
  };
}
const times = (k: number, make: (i: number) => RollupOrder) => Array.from({ length: k }, (_, i) => make(i));
const rate = (delivered: number, returned: number) => ({
  rate: delivered + returned ? delivered / (delivered + returned) : null, delivered, returned, stillOpen: 0, partial: 0,
});

describe("previous period", () => {
  it("is the same number of days, ending the day before", () => {
    expect(previousPeriod("2026-09-07", "2026-10-06")).toEqual({ from: "2026-08-08", to: "2026-09-06" });
    expect(previousPeriod("2026-10-06", "2026-10-06")).toEqual({ from: "2026-10-05", to: "2026-10-05" });
  });
});

describe("deltas", () => {
  it("compares counts in percent, and not against zero", () => {
    expect(countDelta(110, 100)).toMatchObject({ change: 10, direction: "up", unit: "percent" });
    expect(countDelta(5, 0)).toMatchObject({ change: null, direction: null });
  });

  it("compares money in the store's currency only", () => {
    expect(moneyDelta([pkr("900.00"), { amount: "50.00", currency: "USD" }], [pkr("1000.00")], "PKR")).toMatchObject({
      current: 900, previous: 1000, change: -10, direction: "down",
    });
    // A negative previous profit: improving is "up".
    expect(moneyDelta(pkr("-500.00"), pkr("-1000.00"), "PKR")).toMatchObject({ change: 50, direction: "up" });
  });

  it("compares rates in points, only when both periods decided enough orders", () => {
    expect(rateDelta(rate(90, 10), rate(80, 20))).toMatchObject({ current: 90, previous: 80, change: 10, unit: "points" });
    expect(rateDelta(rate(90, 10), rate(5, 5))).toMatchObject({ previous: null, change: null });
    expect(MIN_DECIDED_TO_RATE).toBe(20);
  });
});

describe("trends", () => {
  it("counts per local day, with empty days as zero", () => {
    const t = dailyCount([order({ localDay: "2026-09-02" }), order({ localDay: "2026-09-02" })], "2026-09-01", "2026-09-05", () => true);
    expect(t?.points.map((p) => p.value)).toEqual([0, 2, 0, 0, 0]);
    expect(dailyCount([], "2026-09-01", "2026-09-02", () => true)).toBeNull();
  });

  it("adds money per day in one currency", () => {
    const rows = [order({ localDay: "2026-09-01" }), order({ localDay: "2026-09-01", delivered: { amount: "7.00", currency: "USD" } })];
    expect(dailyMoney(rows, "2026-09-01", "2026-09-04", "PKR", (o) => o.delivered)?.points[0]?.value).toBe(1000);
  });

  it("draws a weekly rate only for weeks with enough decided orders", () => {
    const days = ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"];
    const rows = days.flatMap((d, w) => [
      ...times(18, () => order({ localDay: d })),
      ...times(w === 0 ? 0 : 2, () => order({ localDay: d, outcome: "returned" })),
    ]);
    const t = weeklyRate(rows, "2026-08-29", "2026-09-25");
    // Week one decided 18 orders: no point. The other three are 90%.
    expect(t).toBeNull();
    const more = [...rows, ...times(2, () => order({ localDay: "2026-09-03", outcome: "returned" }))];
    expect(weeklyRate(more, "2026-08-29", "2026-09-25")?.points.map((p) => p.value)).toEqual([90, 90, 90, 90]);
  });
});

describe("thin rows", () => {
  it("folds rows under the minimum into one, keeping every order", () => {
    const big = { ...bucketOf("Lahore", times(25, () => order())) };
    const small = { ...bucketOf("Gujrat", times(3, () => order({ city: "Gujrat" }))) };
    const tiny = { ...bucketOf("Swat", times(1, () => order({ city: "Swat" }))) };
    const out = foldThinRows([big, small, tiny], 20, (thin) => ({ ...bucketOf("other", []), key: "other", orders: thin.reduce((n, t) => n + t.orders, 0) }));
    expect(out.folded).toBe(2);
    expect(out.rows.map((r) => [r.key, r.orders])).toEqual([["Lahore", 25], ["other", 4]]);
  });
});

describe("scope", () => {
  it("selects the same orders as the roll-up keys", () => {
    const s = parseScope(new URLSearchParams("courier=unknown&city=unmapped"));
    expect(inScope(order({ courier: null, city: null, cityRaw: "lhr" }), s)).toBe(true);
    expect(inScope(order({ courier: null, city: null, cityRaw: null, parcelCount: 0 }), s)).toBe(false);
    expect(scopeQuery(s)).toBe("courier=unknown&city=unmapped");
    expect(scopeWhere(s)).toEqual({
      AND: [{ courier: null }, { city: null }, { OR: [{ parcelCount: { gt: 0 } }, { cityRaw: { not: null } }] }],
    });
    expect(scopeWhere(parseScope(new URLSearchParams()))).toEqual({});
  });
});

describe("like-for-like", () => {
  it("withdraws an outcome-dependent change while either period is still settling", async () => {
    const { whenSettled, whenCovered } = await import("./compare");
    const d = countDelta(80, 100);
    expect(whenSettled(d, { orders: 100, stillOpen: 10 }, { orders: 100, stillOpen: 5 }).change).toBe(-20);
    const young = whenSettled(d, { orders: 100, stillOpen: 38 }, { orders: 100, stillOpen: 5 });
    expect(young).toMatchObject({ change: null, direction: null, previous: 100 });
    expect(young.notComparable).toBe("38% of this period's orders and 5% of the previous period's are still open");
    expect(whenCovered(d, "Courier fees", { have: 75, of: 100 }, { have: 5, of: 100 }).change).toBeNull();
    expect(whenCovered(d, "Courier fees", { have: 95, of: 100 }, { have: 90, of: 100 }).change).toBe(-20);
  });
});

describe("without comparison", () => {
  it("drops every headline's previous value, and nothing else", async () => {
    const { withoutComparison } = await import("./compare");
    const view = { total: 5, compare: { a: { delta: countDelta(5, 4), trend: null, good: "up" } }, list: [{ delta: countDelta(1, 2), good: "down" }] };
    const out = withoutComparison(view);
    expect(out.total).toBe(5);
    expect(out.compare.a.delta).toMatchObject({ current: 5, previous: null, change: null });
    expect(out.list[0]!.delta.previous).toBeNull();
    expect(view.compare.a.delta.previous).toBe(4);
  });
});
