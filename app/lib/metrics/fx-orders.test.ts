import { describe, expect, it } from "vitest";

import { convertOne, tableSource } from "./fx";
import { convertOrder, fxReport } from "./fx-orders";
import type { RollupOrder } from "./rollups";
import { baseFirst } from "../../components/metrics/Metrics";

// Made-up rates and orders.
const m = (amount: string, currency: string) => ({ amount, currency });
const rates = tableSource("test", [
  { from: "AED", to: "PKR", day: "2026-10-06", rate: "75.559508", source: "test" },
  { from: "IDR", to: "PKR", day: "2026-10-06", rate: "0.017312345678", source: "test" },
]);

function order(o: Partial<RollupOrder> = {}): RollupOrder {
  return {
    orderId: "o1", localDay: "2026-10-06", createdAt: null, currency: "AED",
    placed: m("100.00", "AED"), delivered: m("100.00", "AED"), refunded: m("0.00", "AED"), collected: null, uncollected: m("40.00", "AED"),
    cogs: m("2000.00", "PKR"), cogsComplete: true, courierFee: null, outcome: "delivered", outcomeTiming: null, financifyOutcome: "delivered",
    parcelCount: 0, courier: null, fulfilledVia: null, city: null, cityRaw: null, confirmation: null, customerId: null,
    lines: [{ variantId: "1", productId: "p", quantity: 1, value: m("100.00", "AED"), cost: m("2000.00", "PKR") }],
    ...o,
  };
}

describe("rule #4: one amount at its own day's rate", () => {
  it("converts with 12-decimal rates, so a small currency does not round to nothing", () => {
    expect(convertOne(m("100.00", "AED"), "PKR", "2026-10-06", rates)?.money).toEqual(m("7555.95", "PKR"));
    expect(convertOne(m("1000000.00", "IDR"), "PKR", "2026-10-06", rates)?.money).toEqual(m("17312.35", "PKR"));
  });

  it("has no answer for a day without a rate: never a nearby day, never 1", () => {
    expect(convertOne(m("100.00", "AED"), "PKR", "2026-10-05", rates)).toBeNull();
    expect(convertOne(m("100.00", "AED"), "PKR", null, rates)).toBeNull();
    expect(convertOne(m("100.00", "PKR"), "PKR", null, rates)).toEqual({ money: m("100.00", "PKR"), rate: null });
  });

  it("treats a zero or over-precise rate as no rate", () => {
    const odd = tableSource("odd", [
      { from: "AED", to: "PKR", day: "2026-10-06", rate: "0.000000000000", source: "t" },
      { from: "SAR", to: "PKR", day: "2026-10-06", rate: "73.1234567890123", source: "t" },
    ]);
    expect(convertOne(m("1.00", "AED"), "PKR", "2026-10-06", odd)).toBeNull();
    expect(convertOne(m("1.00", "SAR"), "PKR", "2026-10-06", odd)).toBeNull();
  });
});

describe("orders in another currency, in the store's", () => {
  it("converts every money field at the order's day, and keeps the order's own currency", () => {
    const c = convertOrder(order(), "PKR", rates);
    expect([c.placed, c.delivered, c.uncollected, c.lines[0]!.value]).toEqual([
      m("7555.95", "PKR"), m("7555.95", "PKR"), m("3022.38", "PKR"), m("7555.95", "PKR"),
    ]);
    expect(c.cogs).toEqual(m("2000.00", "PKR"));
    // Still recognised as an international order, and left out of return rates.
    expect(c.currency).toBe("AED");
  });

  it("leaves an order whose day has no rate in its own currency", () => {
    const c = convertOrder(order({ localDay: "2026-07-12" }), "PKR", rates);
    expect(c.placed).toEqual(m("100.00", "AED"));
  });

  it("reports which foreign orders converted, at which rate, and which did not, with their days", () => {
    const r = fxReport(
      [order(), order({ orderId: "o2", localDay: "2026-07-12" }), order({ orderId: "o3", localDay: "2026-07-17", placed: m("50.00", "AED") }), order({ orderId: "o4", currency: "PKR", placed: m("10.00", "PKR") })],
      "PKR",
      rates,
      "2026-10-05",
    )!;
    expect(r.converted).toEqual([{ currency: "AED", orders: 1, placed: m("100.00", "AED"), rates: [expect.objectContaining({ day: "2026-10-06", rate: "75.559508" })] }]);
    expect(r.unconverted).toEqual([{ currency: "AED", orders: 2, placed: m("150.00", "AED"), days: ["2026-07-12", "2026-07-17"] }]);
    expect(r.ratesFrom).toBe("2026-10-05");
  });

  it("reports nothing for a period with no foreign orders", () => {
    expect(fxReport([order({ currency: "PKR", placed: m("10.00", "PKR") })], "PKR", rates, null)).toBeNull();
  });
});

describe("the store's currency leads every figure", () => {
  it("puts PKR first, even though AED sorts before it", () => {
    expect(baseFirst([m("891.00", "AED"), m("6486819.89", "PKR")], "PKR").map((x) => x.currency)).toEqual(["PKR", "AED"]);
  });
});
