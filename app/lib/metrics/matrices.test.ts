import { describe, expect, it } from "vitest";

import { ageOf, cityCourierMatrix, confirmationFunnel, payoutAgeing, productEconomics } from "./matrices";
import type { RollupOrder } from "./rollups";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-09-20", createdAt: new Date("2026-09-20T06:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: pkr("400.00"), cogsComplete: true, courierFee: null, outcome: "delivered", outcomeTiming: null,
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [{ variantId: "1", productId: "p1", title: "Mug", quantity: 1, value: pkr("1000.00"), cost: pkr("400.00") }],
    confirmation: "confirmed", customerId: null, ...o,
  };
}
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);
const returned = (o: Partial<RollupOrder> = {}) => order({ outcome: "returned", delivered: null, ...o });
const open = (o: Partial<RollupOrder> = {}) => order({ outcome: "in_transit", delivered: null, ...o });

describe("product economics", () => {
  it("earns on delivered lines only and charges ads to the decided share", () => {
    // 20 delivered, 20 returned, 10 still open; 50 live orders.
    const rows = [...times(20, () => order()), ...times(20, () => returned()), ...times(10, () => open())];
    const { products, storeReturnRate } = productEconomics(rows, "PKR", { "1": [pkr("10000.00")] });
    const p = products[0]!;
    expect(p).toMatchObject({ decided: 40, delivered: 20, returnRate: 50, plotted: true });
    // 20 × (1000 − 400) − 10000 × 40/50 = 12000 − 8000.
    expect(p.adSpend).toEqual(pkr("8000.00"));
    expect(p.margin).toEqual(pkr("4000.00"));
    expect(p.marginPct).toBe(20);
    // Looks like (50 × 600 − 10000) ÷ 50000 = 40% if every order were delivered.
    expect(p.marginIfAllDeliveredPct).toBe(40);
    expect(storeReturnRate).toBe(50);
  });

  it("does not plot a product short of decided orders or of costed lines", () => {
    const few = productEconomics(times(10, () => order()), "PKR", null).products[0]!;
    expect(few.plotted).toBe(false);
    const uncosted = productEconomics(
      times(25, () => order({ lines: [{ variantId: "1", productId: "p1", quantity: 1, value: pkr("1000.00"), cost: null }] })),
      "PKR",
      null,
    ).products[0]!;
    expect(uncosted).toMatchObject({ plotted: false, linesWithoutCost: 25, adSpend: null });
  });
});

describe("city × courier", () => {
  it("rates a cell only with enough decided orders, keeping its counts", () => {
    const rows = [
      ...times(18, () => order()),
      ...times(2, () => returned()),
      ...times(5, () => order({ courier: "tcs" })),
      order({ courier: null }),
    ];
    const m = cityCourierMatrix(rows);
    expect(m.couriers).toEqual(["leopards", "tcs"]);
    expect(m.cities[0]!.cells.leopards).toEqual({ orders: 20, decided: 20, delivered: 18, rate: 90 });
    expect(m.cities[0]!.cells.tcs).toMatchObject({ orders: 5, rate: null });
    expect(m.cities[0]!.orders).toBe(25);
  });
});

describe("payout ageing", () => {
  it("buckets unpaid COD by days since delivery, per courier, in one currency", () => {
    const asOf = new Date("2026-10-06T12:00:00Z");
    const day = (d: string) => new Date(`${d}T10:00:00Z`);
    const a = payoutAgeing(
      [
        { courier: "leopards", deliveredAt: day("2026-10-03"), amount: pkr("100.00") },
        { courier: "leopards", deliveredAt: day("2026-09-01"), amount: pkr("250.00") },
        { courier: "smartlane", deliveredAt: null, amount: pkr("50.00") },
        { courier: "smartlane", deliveredAt: day("2026-10-01"), amount: { amount: "9.00", currency: "USD" } },
      ],
      "PKR",
      asOf,
    );
    expect(a.total).toEqual(pkr("400.00"));
    expect(a.couriers[0]).toMatchObject({ courier: "leopards", orders: 2 });
    expect(a.couriers[0]!.cells["0-7"]).toEqual({ amount: pkr("100.00"), orders: 1 });
    expect(a.couriers[0]!.cells["31-60"]).toEqual({ amount: pkr("250.00"), orders: 1 });
    expect(a.buckets.at(-1)?.key).toBe("unknown");
    expect(a.otherCurrencies).toEqual([{ amount: "9.00", currency: "USD" }]);
    expect(ageOf(day("2026-07-01"), asOf)).toBe("61+");
  });
});

describe("confirmation funnel", () => {
  it("counts each step and the return rate of each confirmation state", () => {
    const rows = [
      ...times(18, () => order()),
      ...times(4, () => returned()),
      ...times(10, () => returned({ confirmation: "declined" })),
      ...times(3, () => order({ confirmation: null, outcome: "not_shipped", delivered: null })),
      order({ confirmation: "timed_out" }),
    ];
    const f = confirmationFunnel(rows);
    expect(f.steps.map((s) => [s.key, s.orders])).toEqual([
      ["placed", 36], ["attempted", 33], ["confirmed", 22], ["shipped", 33], ["delivered", 19], ["returned", 14],
    ]);
    const confirmed = f.states.find((s) => s.state === "confirmed")!;
    expect(confirmed).toMatchObject({ orders: 22, decided: 22, returned: 4, returnRate: 18.2 });
    expect(f.states.find((s) => s.state === "declined")).toMatchObject({ decided: 10, returnRate: null });
    expect(f.states.find((s) => s.state === "not_sent")).toMatchObject({ orders: 3, shipped: 0 });
  });
});
