import { describe, expect, it } from "vitest";

import { campaignSpend, storeColumn, type CampaignSpendRow } from "./campaigns";
import { bucketOf, type RollupOrder } from "./rollups";

// Made-up numbers throughout.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
const row = (day: string, key: string, spend: string, o: Partial<CampaignSpendRow> = {}): CampaignSpendRow => ({
  day, key, platform: key.split(":")[0]!, name: `Campaign ${key}`, spend: pkr(spend), fees: pkr("5.00"), ...o,
});

describe("campaign spend", () => {
  it("adds spend per campaign and platform, with shares and the change against before", () => {
    const now = [
      row("2026-09-10", "facebook:1", "600.00"),
      row("2026-09-11", "facebook:1", "300.00"),
      row("2026-09-10", "tiktok:2", "100.00"),
      row("2026-09-12", "tiktok:3", "0.00"),
      row("2026-09-10", "facebook:9", "50.00", { spend: { amount: "50.00", currency: "USD" } }),
    ];
    const before = [row("2026-08-10", "facebook:1", "450.00")];
    const c = campaignSpend(now, before, "PKR");
    expect(c.total).toEqual(pkr("1000.00"));
    expect(c.campaigns.map((x) => [x.key, x.spend.amount, x.share, x.daysWithSpend])).toEqual([
      ["facebook:1", "900.00", 90, 2],
      ["tiktok:2", "100.00", 10, 1],
    ]);
    expect(c.campaigns[0]!.change).toMatchObject({ change: 100, direction: "up" });
    expect(c.campaigns[1]!.change.previous).toBeNull();
    expect(c.platforms).toEqual([
      { platform: "facebook", spend: pkr("900.00"), share: 90, campaigns: 1 },
      { platform: "tiktok", spend: pkr("100.00"), share: 10, campaigns: 1 },
    ]);
    expect(c.otherCurrencies).toEqual(["USD"]);
  });
});

describe("store column", () => {
  it("rates only on enough decided orders and says whether profit is in the base currency", () => {
    const o = (outcome: RollupOrder["outcome"]) =>
      ({ orderId: Math.random().toString(), outcome, currency: "PKR", placed: pkr("100.00"), delivered: outcome === "delivered" ? pkr("100.00") : null, lines: [] }) as unknown as RollupOrder;
    const orders = bucketOf("s", [...Array.from({ length: 18 }, () => o("delivered")), o("returned"), o("returned")]);
    const col = storeColumn({
      storeId: "s", name: "Shop", currency: "PKR", base: "PKR", period: { from: "2026-09-01", to: "2026-09-30" },
      orders, previousOrders: 10, placed: null, deliveredRevenue: null,
      profit: { amount: "1.00", currency: "AED", complete: true, missing: [], parts: { deliveredRevenue: "0", cogsDelivered: "0", courierFees: "0", adSpend: null } },
      adSpend: null, roas: null, courierify: { shippedOrders: 20, withParcel: 15 },
    });
    expect(col).toMatchObject({ deliveryRate: 90, returnRate: 10, decided: 20, courierifyShare: 75 });
    expect(col.ordersChange.change).toBe(100);
    expect(col.profit?.inBase).toBe(false);
  });
});

describe("campaign outcomes", () => {
  it("counts each campaign's orders by Growzar's outcomes, with ROAS on delivered revenue", async () => {
    const { campaignOutcomes } = await import("./campaigns");
    const o = (outcome: RollupOrder["outcome"], id: string) =>
      ({ orderId: id, outcome, currency: "PKR", placed: pkr("1000.00"), delivered: outcome === "delivered" ? pkr("1000.00") : null, lines: [] }) as unknown as RollupOrder;
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => o("delivered", `a${i}`)),
      ...Array.from({ length: 5 }, (_, i) => o("returned", `r${i}`)),
      o("in_transit", "t1"),
      o("delivered", "late"), // a campaign that spent nothing this period
      o("delivered", "org"),
      o("delivered", "none"),
    ];
    const attr = new Map<string, { campaignKey: string | null; platform: string | null; method: string | null }>([
      ...rows.slice(0, 21).map((r) => [r.orderId, { campaignKey: "facebook:1", platform: "facebook", method: "utm_id" }] as const),
      ["late", { campaignKey: "facebook:9", platform: "facebook", method: "mapping" }],
      ["org", { campaignKey: null, platform: null, method: "utm_only" }],
      ["none", { campaignKey: null, platform: null, method: null }],
    ]);
    const spend = campaignSpend([row("2026-09-10", "facebook:1", "5000.00"), row("2026-09-10", "tiktok:2", "300.00")], [], "PKR");
    const out = campaignOutcomes(rows, attr, spend, new Map([["facebook:9", { name: "Old campaign", platform: "facebook" }]]), "PKR");
    const fb = out.campaigns.find((c) => c.key === "facebook:1")!;
    expect(fb).toMatchObject({ orders: 21, delivered: 15, returned: 5, stillOpen: 1, decided: 20, returnRate: 25, byId: 21 });
    // 15,000 delivered ÷ (5,000 spend + 5 fees).
    expect(fb.roas).toBe(2.99);
    expect(fb.costPerDelivered).toEqual(pkr("333.67"));
    expect(out.campaigns.find((c) => c.key === "facebook:9")).toMatchObject({ name: "Old campaign", spend: null, roas: null, orders: 1, returnRate: null });
    expect(out.campaigns.find((c) => c.key === "tiktok:2")).toMatchObject({ orders: 0, roas: 0 });
    expect(out.unattributed).toEqual({ untracked: 1, affiliate: 0, noRecord: 1 });
    expect([out.matched, out.of]).toEqual([22, 24]);

    // A campaign whose orders mostly cannot be tracked shows no ROAS, not 0.
    const blind = [o("delivered", "b1"), ...Array.from({ length: 4 }, (_, i) => o("unknown", `bu${i}`))];
    const blindAttr = new Map(blind.map((r) => [r.orderId, { campaignKey: "facebook:7", platform: "facebook", method: "utm_id" }] as const));
    const b = campaignOutcomes(blind, blindAttr, campaignSpend([row("2026-09-10", "facebook:7", "900.00")], [], "PKR"), new Map(), "PKR").campaigns[0]!;
    expect(b).toMatchObject({ orders: 5, delivered: 1, notTrackable: 4, roas: null, costPerDelivered: null });
  });
});
