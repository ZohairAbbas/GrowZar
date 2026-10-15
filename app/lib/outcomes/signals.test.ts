import { describe, expect, it } from "vitest";

import type { RollupOrder } from "../metrics/rollups";
import { claimLevel, observe, perDayFell, shareFell, shareRose, type SignalInput } from "./signals";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-07-01", createdAt: new Date("2026-07-01T08:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: pkr("400.00"), cogsComplete: true, courierFee: null, outcome: "delivered", outcomeTiming: null,
    financifyOutcome: null, parcelCount: 1, courier: "tcs", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [], confirmation: null, customerId: null, ...o,
  };
}
const many = (n: number, o: Partial<RollupOrder>) => Array.from({ length: n }, () => order(o));
const B = "2026-07-01";
const A = "2026-08-10";
const ACTED = new Date("2026-08-01T10:00:00Z");
const NOW = new Date("2026-08-20T10:00:00Z");
const base = (o: Partial<SignalInput>): SignalInput => ({
  detector: "x", subject: "store", finding: null, actedAt: ACTED, now: NOW, currency: "PKR",
  windows: { before: { from: "2026-05-03", to: "2026-07-31" }, after: { from: "2026-08-02", to: "2026-08-19" } },
  orders: [], ...o,
});

describe("share helpers", () => {
  it("need 10 after-window orders before speaking", () => {
    expect(shareRose({ hits: 1, of: 10 }, { hits: 9, of: 9 }, 20)).toBeNull();
    expect(shareRose({ hits: 1, of: 10 }, { hits: 9, of: 10 }, 20)).toEqual({ from: 10, to: 90 });
    expect(shareFell({ hits: 50, of: 100 }, { hits: 3, of: 10 }, 0.2)).toEqual({ from: 50, to: 30 });
    expect(shareFell({ hits: 50, of: 100 }, { hits: 45, of: 100 }, 0.2)).toBeNull();
    expect(perDayFell({ total: 900, days: 90 }, { total: 40, days: 10 }, 0.5)).toEqual({ from: 10, to: 4 });
  });
  it("claim level: changed only with an observed signal", () => {
    expect(claimLevel(null)).toBe("looked");
    expect(claimLevel({ signal: "otp_on" })).toBe("changed");
  });
});

describe("signals per detector", () => {
  it("I1: the city's parcels moved to the recommended courier by 20+ points", () => {
    const orders = [...many(30, { localDay: B, courier: "tcs" }), ...many(10, { localDay: B, courier: "leopards" }), ...many(4, { localDay: A, courier: "tcs" }), ...many(8, { localDay: A, courier: "leopards" })];
    const s = observe(base({ detector: "courier_for_city", subject: "lahore", finding: { city: "Lahore", best: { courier: "leopards", via: "direct" } }, orders }));
    expect(s).toMatchObject({ signal: "courier_share_up", evidence: { from: 25, to: 66.7 } });
    expect(s!.text).toBe("booked 66.7% of Lahore's parcels with leopards, up from 25%");
  });
  it("I1: nothing when the share barely moved", () => {
    const orders = [...many(30, { localDay: B, courier: "tcs" }), ...many(10, { localDay: B, courier: "leopards" }), ...many(8, { localDay: A, courier: "tcs" }), ...many(4, { localDay: A, courier: "leopards" })];
    expect(observe(base({ detector: "courier_for_city", subject: "lahore", finding: { best: { courier: "leopards", via: "direct" } }, orders }))).toBeNull();
  });
  it("I12: the city's share of orders fell by a fifth or more", () => {
    const orders = [...many(40, { localDay: B }), ...many(60, { localDay: B, city: "Karachi" }), ...many(2, { localDay: A }), ...many(18, { localDay: A, city: "Karachi" })];
    expect(observe(base({ detector: "city_returns", subject: "lahore", orders }))).toMatchObject({ signal: "city_share_down", evidence: { from: 40, to: 10 } });
  });
  it("I8: WhatsApp confirmation coverage up 10+ points", () => {
    const orders = [...many(20, { localDay: B, confirmation: "confirmed" }), ...many(80, { localDay: B }), ...many(6, { localDay: A, confirmation: "confirmed" }), ...many(14, { localDay: A })];
    expect(observe(base({ detector: "unconfirmed_returns", orders }))).toMatchObject({ signal: "confirmation_up", evidence: { from: 20, to: 30 } });
  });
  it("variant: its order share fell, or else more of its form orders paid in advance", () => {
    const v = { lines: [{ variantId: "v1", productId: "p", quantity: 1, value: pkr("1000.00"), cost: null }] };
    const fell = [...many(30, { localDay: B, ...v }), ...many(70, { localDay: B }), ...many(1, { localDay: A, ...v }), ...many(19, { localDay: A })];
    expect(observe(base({ detector: "variant_returns", subject: "v1", orders: fell }))?.signal).toBe("variant_share_down");
    const held = [...many(30, { localDay: B, ...v }), ...many(70, { localDay: B }), ...many(6, { localDay: A, ...v }), ...many(14, { localDay: A })];
    const forms = [
      ...Array.from({ length: 20 }, (_, i) => ({ localDay: B, variantIds: ["v1"], prepaid: i < 2, verified: false })),
      ...Array.from({ length: 10 }, (_, i) => ({ localDay: A, variantIds: ["v1"], prepaid: i < 4, verified: false })),
    ];
    expect(observe(base({ detector: "variant_returns", subject: "v1", orders: held, formOrders: forms }))).toMatchObject({ signal: "variant_prepaid_up", evidence: { from: 10, to: 40 } });
  });
  it("I2: ad spend halved, orders stopped, or price up 5%", () => {
    const v = (value: string) => ({ lines: [{ variantId: "v1", productId: "p", quantity: 1, value: pkr(value), cost: null }] });
    const spend = { before: { total: 90_000, days: 90 }, after: { total: 4_000, days: 18 } };
    expect(observe(base({ detector: "product_loss", subject: "v1", adSpend: spend }))?.signal).toBe("ad_spend_down");
    expect(observe(base({ detector: "product_loss", subject: "v1", orders: many(90, { localDay: B, ...v("1000.00") }) }))?.signal).toBe("orders_stopped");
    const priced = [...many(90, { localDay: B, ...v("1000.00") }), ...many(12, { localDay: A, ...v("1100.00") })];
    expect(observe(base({ detector: "product_loss", subject: "v1", orders: priced }))).toMatchObject({ signal: "price_up", evidence: { from: 1000, to: 1100 } });
  });
  it("I10: spend on the flagged campaigns halved", () => {
    expect(observe(base({ detector: "campaign_returns", adSpend: { before: { total: 90_000, days: 90 }, after: { total: 9_000, days: 18 } } }))?.signal).toBe("campaign_spend_down");
    expect(observe(base({ detector: "campaign_returns", adSpend: { before: { total: 90_000, days: 90 }, after: { total: 15_000, days: 18 } } }))).toBeNull();
  });
  it("I5: OTP switched on after acting, at Preventify's own time; a change before acting does not count", () => {
    const on = new Date("2026-08-05T09:00:00Z");
    const s = observe(base({ detector: "returners", settingsChanges: [{ field: "otpEnabled", to: true, at: new Date("2026-07-01T00:00:00Z") }, { field: "otpEnabled", to: true, at: on }] }));
    expect(s).toMatchObject({ signal: "otp_on", at: on.toISOString() });
    expect(observe(base({ detector: "network_risk", settingsChanges: [{ field: "otpEnabled", to: true, at: new Date("2026-07-01T00:00:00Z") }] }))).toBeNull();
  });
  it("I9: an offer of that type switched off after acting", () => {
    const offers = [{ type: "upsell", enabled: false, name: "Mystery box", updatedAt: new Date("2026-08-03T00:00:00Z") }, { type: "bundle", enabled: false, name: "Two-pack", updatedAt: new Date("2026-08-04T00:00:00Z") }];
    expect(observe(base({ detector: "offer_returns", subject: "upsell", offers }))).toMatchObject({ signal: "offer_off", evidence: { name: "Mystery box" } });
    expect(observe(base({ detector: "offer_returns", subject: "one_tick", offers }))).toBeNull();
  });
  it("I6: follow-up share up 10+ points", () => {
    expect(observe(base({ detector: "unfollowed_checkouts", followUp: { before: { hits: 30, of: 100 }, after: { hits: 8, of: 20 } } }))?.signal).toBe("follow_up_up");
  });
  it("I4: a payout from that payer dated after acting", () => {
    const settlements = [{ payer: "orio", day: "2026-07-20", at: new Date("2026-07-20T00:00:00Z") }, { payer: "orio", day: "2026-08-09", at: new Date("2026-08-09T00:00:00Z") }, { payer: "tcs", day: "2026-08-02", at: new Date("2026-08-02T00:00:00Z") }];
    expect(observe(base({ detector: "cash_held", subject: "orio", settlements }))).toMatchObject({ signal: "payout_received", evidence: { day: "2026-08-09" } });
  });
  it("I3: a purchase order for the variant after acting", () => {
    const purchaseOrders = [{ poNumber: "PO-1", variantIds: ["v9"], at: new Date("2026-08-02T00:00:00Z") }];
    expect(observe(base({ detector: "stockout", subject: "v9", finding: { variantId: "v9" }, purchaseOrders }))).toMatchObject({ signal: "purchase_order", evidence: { poNumber: "PO-1" } });
  });
  it("no signal where pack §5 has none, or the data cannot show it", () => {
    for (const d of ["stuck_parcels", "courier_deductions", "returns_not_received", "missing_courier_fees", "courierify_stopped"]) expect(observe(base({ detector: d }))).toBeNull();
  });
});
