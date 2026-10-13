import { describe, expect, it } from "vitest";

import { acquisitionView, campaignReturnsFinding } from "./campaign-acquisition";

// Made-up numbers throughout; nothing here comes from a real store.
const firsts = (k: number, campaignKey: string | null, outcome: string) => Array.from({ length: k }, () => ({ campaignKey, outcome }));
const pkr = (amount: string) => ({ amount, currency: "PKR" });
const names = new Map([["facebook:1", { name: "Summer sale", platform: "facebook" }]]);

describe("acquisitionView", () => {
  it("counts each campaign's new buyers and splits its spend over every order it brought", () => {
    const v = acquisitionView({
      firsts: [...firsts(3, "facebook:1", "returned"), ...firsts(5, "facebook:1", "delivered"), ...firsts(2, "facebook:1", "in_transit"), ...firsts(10, null, "delivered")],
      ordersByCampaign: new Map([["facebook:1", 20]]),
      spend: new Map([["facebook:1", pkr("10000")]]),
      names,
    });
    expect(v.store).toEqual({ decided: 18, returned: 3, rate: 16.7 });
    // 10,000 over 20 orders, 3 of them returned first orders.
    expect(v.campaigns[0]).toMatchObject({ key: "facebook:1", name: "Summer sale", firsts: 10, decided: 8, returned: 3, rate: 37.5, orders: 20, spendOnReturned: pkr("1500.00") });
  });

  it("treats a campaign with no spend recorded as unknown, not free", () => {
    const v = acquisitionView({ firsts: firsts(2, "snapchat:1", "returned"), ordersByCampaign: new Map(), spend: new Map([["snapchat:1", pkr("0.00")]]), names: new Map() });
    expect(v.campaigns[0]).toMatchObject({ spend: null, spendOnReturned: null });
  });

  it("leaves spend out when the period's ad spend is not fetched in full", () => {
    const v = acquisitionView({ firsts: firsts(2, "tiktok:9", "returned"), ordersByCampaign: new Map(), spend: null, names: new Map() });
    expect(v.campaigns[0]).toMatchObject({ platform: "tiktok", spend: null, spendOnReturned: null, orders: 2 });
  });
});

describe("campaignReturnsFinding (I10)", () => {
  const view = (campaignReturned: number, campaignDelivered: number) =>
    acquisitionView({
      firsts: [...firsts(campaignReturned, "facebook:1", "returned"), ...firsts(campaignDelivered, "facebook:1", "delivered"), ...firsts(20, null, "returned"), ...firsts(180, null, "delivered")],
      ordersByCampaign: new Map([["facebook:1", 50]]),
      spend: new Map([["facebook:1", pkr("50000")]]),
      names,
    });
  const returnCost = { perReturn: pkr("300"), priced: 80, returns: 100 };

  it("flags a campaign whose new buyers come back far more often, with its spend on them and the extra returns' charges", () => {
    const f = campaignReturnsFinding(view(20, 20), returnCost);
    // 50% against 10% for the other 200 new buyers: 16 extra returns.
    expect(f).toMatchObject({ kind: "campaign_returns", spendOnReturned: pkr("20000.00") });
    if (f.kind !== "campaign_returns") throw new Error();
    expect(f.flagged[0]).toMatchObject({ rate: 50, restRate: 10, excessReturns: 16, returnCharges: pkr("4800.00") });
  });

  it("needs 30 decided first orders, and stays quiet without a clear gap", () => {
    expect(campaignReturnsFinding(view(10, 10), returnCost)).toMatchObject({ status: "not_enough_data" });
    expect(campaignReturnsFinding(view(5, 30), returnCost)).toMatchObject({ status: "nothing_found" });
  });
});
