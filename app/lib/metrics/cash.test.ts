import { describe, expect, it } from "vitest";

import { cashTimeline, courierDeductions, deliveryOdds, expectedProfit, isStuck, moneyBreakdown } from "./cash";
import { bucketOf, profitAfterReturns, type RollupOrder } from "./rollups";
import { parseAmount } from "./money";
import type { Statement } from "./settlements";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-09-20", createdAt: new Date("2026-09-20T06:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), discounts: pkr("100.00"), refunded: null,
    collected: null, uncollected: null, cogs: pkr("400.00"), cogsComplete: true, courierFee: pkr("200.00"),
    outcome: "delivered", outcomeTiming: { basis: "happened_on", at: new Date("2026-09-23T06:00:00Z") },
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [], confirmation: null, customerId: null, ...o,
  };
}
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);
const open = (o: Partial<RollupOrder> = {}) => order({ outcome: "in_transit", delivered: null, ...o });
const returned = (o: Partial<RollupOrder> = {}) => order({ outcome: "returned", delivered: null, ...o });
const amount = (lines: ReturnType<typeof moneyBreakdown>, key: string) => lines.find((l) => l.key === key)?.amount.amount;

describe("where the money went", () => {
  it("adds up line by line, and ends on the headline profit", () => {
    const rows = [
      ...times(3, () => order()),
      order({ delivered: pkr("900.00") }), // a refund after delivery
      returned(),
      open(),
      order({ outcome: "order_cancelled", delivered: null, courierFee: null }),
    ];
    const b = bucketOf("s", rows);
    const ads = { spend: [pkr("500.00")], fees: [pkr("50.00")] };
    const profit = profitAfterReturns(b, "PKR", [pkr("550.00")]);
    const lines = moneyBreakdown(rows, "PKR", profit, ads);
    expect(amount(lines, "gross")).toBe("7700.00");
    expect(amount(lines, "net")).toBe("6000.00");
    expect(amount(lines, "adjustments")).toBe("-100.00");
    expect(amount(lines, "delivered")).toBe("3900.00");
    // Delivered sales − 4 × 400 cost − 6 shipped × 200 fees − 550 ads.
    expect(amount(lines, "profit")).toBe(profit.amount);
    expect(profit.amount).toBe("550.00");
    // Every line between a subtotal and the next adds up to it.
    const u = (k: string) => parseAmount(amount(lines, k)!)!;
    expect(u("net") + u("open") + u("returned") + u("adjustments")).toBe(u("delivered"));
    expect(lines.find((l) => l.key === "net")?.share).toBe(100);
  });

  it("ends on the same profit without ad lines when ads are not subtracted", () => {
    const rows = times(2, () => order());
    const profit = profitAfterReturns(bucketOf("s", rows), "PKR", null);
    const lines = moneyBreakdown(rows, "PKR", profit, null);
    expect(lines.some((l) => l.key === "ads")).toBe(false);
    expect(amount(lines, "profit")).toBe(profit.amount);
  });
});

describe("expected profit", () => {
  it("prices parcels with couriers at their route's odds, falling back to courier then store", () => {
    const history = [
      ...times(18, () => order()),
      ...times(2, () => returned()), // Lahore × leopards: 90%
      ...times(10, () => order({ city: "Multan" })),
      ...times(10, () => returned({ city: "Multan" })), // leopards overall: 28/40 = 70%
    ];
    const odds = deliveryOdds(history);
    expect(odds(open())).toMatchObject({ level: "route", rate: 0.9 });
    expect(odds(open({ city: "Quetta" }))).toMatchObject({ level: "courier", rate: 0.7 });
    expect(odds(open({ courier: "tcs", city: "Quetta" }))).toMatchObject({ level: "store", rate: 0.7 });
    expect(deliveryOdds(times(5, () => order()))(open())).toBeNull();

    const rows = [order(), open(), open({ city: "Quetta" }), order({ outcome: "not_shipped", delivered: null, courierFee: null })];
    const realized = profitAfterReturns(bucketOf("s", rows), "PKR", null);
    const e = expectedProfit(rows, realized, odds);
    // 0.9 × (1000 − 400) + 0.7 × (1000 − 400) = 540 + 420.
    expect(parseAmount(e.amount.amount)! - parseAmount(realized.amount)!).toBe(960_000_000n);
    expect(e).toMatchObject({ levels: { route: 1, courier: 1, store: 0 }, unpriced: 0, notDispatched: 1 });
    expect(e.withCourier).toEqual({ orders: 2, placed: pkr("2000.00") });
  });
});

describe("where the cash is", () => {
  const asOf = new Date("2026-10-06T12:00:00Z");
  it("puts each order in one stage, and owed only for tracked payers", () => {
    const rows = [
      order({ collected: pkr("1000.00") }),
      order({ uncollected: pkr("1000.00") }),
      order({ uncollected: pkr("1000.00"), courier: "smartlane" }),
      open({ outcomeTiming: { basis: "happened_on", at: new Date("2026-09-20T00:00:00Z") } }),
      order({ outcome: "booked", delivered: null, outcomeTiming: { basis: "status_as_of", at: new Date("2026-10-05T00:00:00Z") } }),
      order({ outcome: "not_shipped", delivered: null, parcelCount: 0 }),
      order({ outcome: "order_cancelled", delivered: null }),
    ];
    const t = cashTimeline(rows, "PKR", new Set(["leopards"]), asOf);
    expect(t.stages.map((s) => [s.key, s.orders])).toEqual([
      ["not_dispatched", 1], ["booked", 1], ["with_courier", 1], ["awaiting", 1], ["untracked", 1], ["paid", 1],
    ]);
    expect(t.stuck).toEqual({ booked: 0, inTransit: 1, amount: pkr("1000.00") });
  });

  it("calls a parcel stuck only on Courierify's own status time", () => {
    const old = { basis: "status_as_of" as const, at: new Date("2026-09-01T00:00:00Z") };
    expect(isStuck(order({ outcome: "booked", outcomeTiming: old }), asOf)).toBe(true);
    expect(isStuck(open({ outcomeTiming: old, parcelCount: 0 }), asOf)).toBe(false);
    expect(isStuck(order({ outcomeTiming: old }), asOf)).toBe(false);
  });
});

describe("what couriers deducted", () => {
  const st = (o: Partial<Statement>): Statement => ({
    payer: "tcs", day: "2026-09-10", status: "received", source: "courier_api", shipments: 10, returned: 1,
    totalCod: pkr("10000.00"), codFees: pkr("100.00"), deliveryFees: pkr("1500.00"), reversalFees: null,
    withholdingTax: pkr("200.00"), miscDeduction: null, carryForward: null, netPaid: pkr("8200.00"), ...o,
  });
  it("sums statements in the period per payer, with what the courier kept", () => {
    const rows = courierDeductions(
      [st({}), st({ day: "2026-09-20", status: "pending" }), st({ day: "2026-08-01" }), st({ payer: "leopards", reversalFees: pkr("50.00") })],
      "2026-09-01",
      "2026-09-30",
      "PKR",
    );
    expect(rows.map((r) => [r.payer, r.statements, r.open])).toEqual([["tcs", 2, 1], ["leopards", 1, 0]]);
    expect(rows[0]).toMatchObject({ cod: pkr("20000.00"), netPaid: pkr("16400.00"), keptShare: 18, returnFees: null });
    expect(rows[1]!.returnFees).toEqual(pkr("50.00"));
    // 20000 − 200 COD fee − 3000 delivery − 400 tax − 16400 paid.
    expect(rows[0]!.unitemized).toEqual(pkr("0.00"));
    const gap = courierDeductions([st({ netPaid: pkr("7000.00") })], "2026-09-01", "2026-09-30", "PKR")[0]!;
    expect(gap.unitemized).toEqual(pkr("1200.00"));
  });
});

describe("other costs in the breakdown", () => {
  it("charges Financify's shipping estimate only where Courierify recorded no fee, and still ends on the profit", () => {
    const oc = { payment: pkr("10.00"), shipping: pkr("300.00"), taxes: null, custom: pkr("20.00") };
    const rows = [order({ otherCosts: oc }), order({ courierFee: null, otherCosts: oc }), order()];
    const profit = profitAfterReturns(bucketOf("s", rows), "PKR", null);
    const lines = moneyBreakdown(rows, "PKR", profit, null);
    expect(amount(lines, "payment")).toBe("-20.00");
    expect(amount(lines, "shipping")).toBe("-300.00");
    expect(amount(lines, "custom")).toBe("-40.00");
    expect(lines.some((l) => l.key === "taxes")).toBe(false);
    // 3000 delivered − 1200 cost − 400 fees − 360 other costs.
    expect(profit.amount).toBe("1040.00");
    expect(amount(lines, "profit")).toBe("1040.00");
    expect(profit.parts.otherCosts).toMatchObject({ total: "360.00", shipping: "300.00" });
  });
});
