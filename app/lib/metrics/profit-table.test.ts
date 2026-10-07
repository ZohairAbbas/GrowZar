import { describe, expect, it } from "vitest";

import { profitTable, shareOut, type ProfitDimension } from "./profit-table";
import { bucketOf, profitAfterReturns, type RollupOrder } from "./rollups";
import { parseAmount } from "./money";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
const line = (variantId: string, value: string, cost: string) => ({ variantId, productId: `p${variantId}`, quantity: 1, value: pkr(value), cost: pkr(cost) });
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-09-20", createdAt: new Date("2026-09-20T00:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: pkr("400.00"), cogsComplete: true, courierFee: pkr("150.00"), outcome: "delivered", outcomeTiming: null,
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [line("1", "1000.00", "400.00")], confirmation: null, customerId: null,
    otherCosts: { payment: pkr("10.00"), shipping: pkr("300.00"), taxes: null, custom: pkr("21.98") }, ...o,
  };
}
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);

const rows = [
  ...times(20, () => order()),
  ...times(4, () => order({ outcome: "returned", delivered: null, city: "Multan" })),
  order({ courierFee: null, courier: "smartlane", city: "Karachi" }), // shipping estimate applies
  order({ lines: [line("1", "700.00", "300.00"), line("2", "300.00", "100.00")], courier: "tcs" }), // split across products
  order({ outcome: "in_transit", delivered: null, otherCosts: undefined }),
  order({ outcome: "order_cancelled", delivered: null, courierFee: null, lines: [line("3", "500.00", "200.00")] }),
];
const ADS = 7_333_333_333n; // 7,333.333333 PKR of spend + fees

describe("profit tables", () => {
  const headline = profitAfterReturns(bucketOf("s", rows), "PKR", [pkr("7333.333333")]);

  it.each<ProfitDimension>(["city", "courier", "product", "campaign"])("%s tab adds up to the headline profit to the cent", (dim) => {
    const t = profitTable(dim, {
      rows,
      currency: "PKR",
      ads: ADS,
      adByVariant: new Map([["1", 5_000_000_000n], ["2", 1_000_000_000n]]),
      adUnattributed: 500_000_000n,
      adByCampaign: new Map([["facebook:1", 6_000_000_000n]]),
      campaignOf: new Map(rows.map((r, i) => [r.orderId, i % 2 ? "facebook:1" : null])),
      maxRows: 2,
    });
    expect(t.total).toEqual({ amount: headline.amount, currency: "PKR" });
    expect(t.rows.reduce((a, r) => a + parseAmount(r.ads.amount)!, 0n)).toBe(ADS);
  });

  it("splits a several-product order by line value and line cost", () => {
    const t = profitTable("product", { rows: [rows[25]!], currency: "PKR", ads: null });
    const v1 = t.rows.find((r) => r.key === "1")!;
    const v2 = t.rows.find((r) => r.key === "2")!;
    expect([v1.revenue.amount, v1.productCost.amount, v2.revenue.amount, v2.productCost.amount]).toEqual(["700.00", "300.00", "300.00", "100.00"]);
    expect(v1.orders + v2.orders).toBe(2);
  });

  it("puts ad spend no product or campaign took on its own row", () => {
    const p = profitTable("product", { rows, currency: "PKR", ads: ADS, adByVariant: new Map([["1", 1_000_000_000n]]), adUnattributed: 1_000_000_000n });
    expect(p.rows.at(-1)).toMatchObject({ kind: "ads", key: "Ad spend not tied to a product" });
    // The remainder of the allocation, rounding included.
    expect(parseAmount(p.rows.at(-1)!.ads.amount)!).toBe(ADS - ADS / 2n);
    const c = profitTable("campaign", { rows, currency: "PKR", ads: ADS, adByCampaign: new Map([["facebook:1", 1_000_000_000n]]), campaignOf: new Map() });
    expect(c.rows.at(-1)).toMatchObject({ kind: "ads", key: "Ad spend not split by campaign" });
  });

  it("charges the shipping estimate only where no courier fee is recorded", () => {
    const t = profitTable("courier", { rows, currency: "PKR", ads: null });
    expect(t.rows.find((r) => r.key === "smartlane")!.otherCosts.amount).toBe("331.98");
    expect(t.rows.find((r) => r.key === "tcs")!.otherCosts.amount).toBe("31.98");
  });

  it("shares exactly, with the remainder on the largest weight", () => {
    expect(shareOut(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(shareOut(5n, [0n, 0n])).toEqual([5n, 0n]);
  });
});
