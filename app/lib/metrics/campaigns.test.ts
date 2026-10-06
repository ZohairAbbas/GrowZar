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
