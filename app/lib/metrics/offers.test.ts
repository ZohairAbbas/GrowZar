import { describe, expect, it } from "vitest";

import { MIN_DECIDED, offerReturnsFindings, offersView, parseFormOrder, type FormOrder, type OrderFacts } from "./offers";

const aed = (amount: string) => ({ amount, currency: "AED" });
const order = (id: string, offers: FormOrder["offers"] = []): FormOrder => ({ orderId: id, createdAt: new Date("2026-10-01T10:00:00Z"), offers });
const bundle = [{ type: "bundle" as const, offerId: "b1", source: "preventify" }];

/** `n` orders of one kind, `returned` of them returned, the rest delivered, each worth `value`. */
function batch(prefix: string, n: number, returned: number, value: string, offers: FormOrder["offers"] = []) {
  const orders = Array.from({ length: n }, (_, i) => order(`${prefix}${i}`, offers));
  const facts: Array<[string, OrderFacts]> = orders.map((o, i) => [o.orderId, { placed: aed(value), outcome: i < returned ? "returned" : "delivered" }]);
  return { orders, facts };
}

describe("parseFormOrder", () => {
  it("collects each line's offer and an order-level downsell", () => {
    const o = parseFormOrder({
      orderId: "5550001",
      createdAt: "2026-10-01T10:00:00.000Z",
      lines: [{ offer: { type: "bundle", offerId: "b1", source: "preventify" } }, { offer: null }, { offer: { type: "one_tick", offerId: "t1" } }],
      downsell: { offerId: "d1", discount: aed("10.00") },
    });
    expect(o?.offers.map((x) => x.type)).toEqual(["bundle", "one_tick", "downsell"]);
  });
});

describe("offersView", () => {
  it("compares each offer type with orders that took none, on Financify's value and the grain's outcomes", () => {
    const none = batch("n", 4, 1, "100.00");
    const withBundle = batch("b", 2, 1, "190.00", bundle);
    const v = offersView({
      formOrders: [...none.orders, ...withBundle.orders, order("unknown", bundle)],
      facts: new Map([...none.facts, ...withBundle.facts]),
      offerNames: new Map([["b1", { name: "Buy 2 save 10%", type: "bundle" }]]),
      events: [{ offerId: "b1", kind: "shown" }, { offerId: "b1", kind: "shown" }, { offerId: "b1", kind: "accepted" }],
      currency: "AED",
    });
    expect(v.formOrders).toBe(6);
    expect(v.byType.map((g) => [g.type, g.orders, g.delivered, g.returned, g.avgPlaced?.amount])).toEqual([
      ["none", 4, 3, 1, "100.00"],
      ["bundle", 2, 1, 1, "190.00"],
    ]);
    // Too few decided to show a rate.
    expect(v.byType[0]!.returnRate).toBeNull();
    expect(v.byOffer[0]).toMatchObject({ label: "Buy 2 save 10%", orders: 2 });
    expect(v.events).toEqual([{ offerId: "b1", shown: 2, accepted: 1 }]);
  });
});

describe("I9", () => {
  const view = (noneReturned: number, bundleReturned: number, bundleValue = "190.00", n = MIN_DECIDED) => {
    const none = batch("n", n, noneReturned, "100.00");
    const b = batch("b", n, bundleReturned, bundleValue, bundle);
    return offersView({ formOrders: [...none.orders, ...b.orders], facts: new Map([...none.facts, ...b.facts]), offerNames: new Map(), events: [], currency: "AED" });
  };

  it("flags an offer type that raises both order value and returns, with the arithmetic", () => {
    expect(offerReturnsFindings(view(3, 12))).toEqual([
      expect.objectContaining({ type: "bundle", decided: 30, returnRate: 40, baselineRate: 10, gapPoints: 30, valueLiftPct: 90 }),
    ]);
  });

  it("holds back a gap too small for its orders to tell from chance", () => {
    // 12 of 30 against 28 of 93 (zainvault's one-tick add-ons, 90 days): 9.9 points, z about 1.
    const none = batch("n", 93, 28, "114.00");
    const t = batch("t", 30, 12, "154.00", [{ type: "one_tick", offerId: "t1", source: "preventify" }]);
    const v = offersView({ formOrders: [...none.orders, ...t.orders], facts: new Map([...none.facts, ...t.facts]), offerNames: new Map(), events: [], currency: "AED" });
    expect(offerReturnsFindings(v)).toMatchObject({ status: "not_enough_data", reason: expect.stringMatching(/chance/) });
  });

  it("is quiet when returns barely move, or order value does not rise", () => {
    expect(offerReturnsFindings(view(3, 4))).toMatchObject({ status: "nothing_found" });
    expect(offerReturnsFindings(view(3, 9, "90.00"))).toMatchObject({ status: "nothing_found" });
  });

  it("says how far each side is from enough decided orders", () => {
    expect(offerReturnsFindings(view(3, 9, "190.00", 12))).toMatchObject({ status: "not_enough_data", reason: expect.stringMatching(/bundles have 12, orders with no offer 12/) });
  });
});
