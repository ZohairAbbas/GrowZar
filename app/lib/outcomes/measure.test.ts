import { describe, expect, it } from "vitest";

import type { RollupOrder } from "../metrics/rollups";
import { addDays, classifierFor, historyFromOf, productProfit, productVerdict, tally, windowsOf, type Classifier, type GroupContext } from "./groups";
import { rateEffect, returnsAvoidedMoney, stateOf, timing, verdictOf, type Verdict } from "./measure";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-07-01", createdAt: new Date("2026-07-01T08:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: pkr("400.00"), cogsComplete: true, courierFee: null, outcome: "delivered", outcomeTiming: null,
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [], confirmation: null, customerId: null, ...o,
  };
}
const ACTED = new Date("2026-08-01T10:00:00Z");
const W = windowsOf("2026-08-01");
const at = (day: string) => ({ localDay: day, createdAt: new Date(`${day}T08:00:00Z`) });
const BEFORE = "2026-07-01";
const AFTER = "2026-08-15";

/** `n` orders on `day`, `returned` of them returned, `open` more still in transit. */
function batch(n: number, returned: number, day: string, o: Partial<RollupOrder> = {}, open = 0): RollupOrder[] {
  return [
    ...Array.from({ length: n }, (_, i) => order({ ...at(day), outcome: i < returned ? "returned" : "delivered", ...o })),
    ...Array.from({ length: open }, () => order({ ...at(day), outcome: "in_transit", delivered: null, ...o })),
  ];
}
const ctx: GroupContext = { currency: "PKR" };
const V = "v-1";
const withV = { lines: [{ variantId: V, productId: "p", quantity: 1, value: pkr("1000.00"), cost: pkr("400.00") }] };
const variant = classifierFor("variant_returns", V, null, ctx) as Classifier;

/** The verdict for a variant watch at `now`, store-local days in UTC. */
function judge(orders: RollupOrder[], now: Date): { verdict: Verdict; e: ReturnType<typeof rateEffect> } {
  const t = tally(orders, variant, W, now);
  const e = rateEffect(t.before, t.after);
  const tm = timing(ACTED, W.after.to, now.toISOString().slice(0, 10), now, e.progress);
  return { verdict: verdictOf(e, tm), e };
}
const LATER = new Date("2026-09-20T10:00:00Z"); // day 50: after window closed, before the cut-off
const CUTOFF = new Date("2026-10-01T10:00:00Z"); // day 61
const rest = [...batch(1000, 200, BEFORE), ...batch(1000, 200, AFTER)];

describe("verdicts (variant returns, against the rest of the store)", () => {
  it("improved: the product's returns fell while the rest held", () => {
    const { verdict, e } = judge([...batch(100, 40, BEFORE, withV), ...batch(100, 15, AFTER, withV), ...rest], LATER);
    expect(verdict).toBe("improved");
    expect(e.before.subject).toBe(40);
    expect(e.after.subject).toBe(15);
    expect(e.effectPoints).toBe(-25);
    expect(e.interval[0]).toBeLessThan(e.interval[1]);
  });
  it("worse, shown as plainly", () => {
    expect(judge([...batch(100, 40, BEFORE, withV), ...batch(100, 60, AFTER, withV), ...rest], LATER).verdict).toBe("worse");
  });
  it("no change", () => {
    expect(judge([...batch(100, 40, BEFORE, withV), ...batch(100, 38, AFTER, withV), ...rest], LATER).verdict).toBe("no_change");
  });
  it("counts the change beyond the rest of the store's (difference in differences)", () => {
    // Everything fell by 25 points: not the product's doing.
    const all = [...batch(100, 40, BEFORE, withV), ...batch(100, 15, AFTER, withV), ...batch(1000, 300, BEFORE), ...batch(1000, 50, AFTER)];
    const { verdict, e } = judge(all, LATER);
    expect(e.effectPoints).toBe(0);
    expect(verdict).toBe("no_change");
  });
  it("too early while the after window is still open", () => {
    expect(judge([...batch(100, 40, BEFORE, withV), ...batch(100, 15, AFTER, withV), ...rest], new Date("2026-08-20T10:00:00Z")).verdict).toBe("too_early");
  });
  it("not enough data: under 30 decided orders after, at the cut-off", () => {
    const { verdict } = judge([...batch(100, 40, BEFORE, withV), ...batch(20, 2, AFTER, withV), ...rest], CUTOFF);
    expect(verdict).toBe("not_enough_data");
  });
  it("waits while open orders could still swing it, and at the cut-off gives no direction the extremes disagree on", () => {
    const orders = [...batch(100, 40, BEFORE, withV), ...batch(60, 10, "2026-08-21", withV, 40), ...rest];
    expect(judge(orders, LATER).verdict).toBe("too_early");
    const { verdict, e } = judge(orders, CUTOFF);
    expect(e.after.subject).toBe(16.7); // decided only: looks much better…
    expect(verdict).toBe("not_enough_data"); // …but all 40 open returning would make it worse
  });
  it("leaves other currencies out", () => {
    const usd = batch(100, 100, AFTER, { ...withV, currency: "USD" });
    const { verdict, e } = judge([...batch(100, 40, BEFORE, withV), ...batch(100, 15, AFTER, withV), ...rest, ...usd], LATER);
    expect(e.tallies.after.subject.returned).toBe(15);
    expect(verdict).toBe("improved");
  });
  it("prices only an improvement, at the conservative end", () => {
    const { e } = judge([...batch(100, 40, BEFORE, withV), ...batch(100, 15, AFTER, withV), ...rest], LATER);
    const m = returnsAvoidedMoney(e, pkr("300.00"))!;
    // Central: 25 fewer returns per 100 orders per 28 days ≈ 26.8 per 30 days; conservative is less.
    expect(m.returnsPer30Days).toBeGreaterThan(0);
    expect(m.returnsPer30Days).toBeLessThan(26.8);
    expect(m.amountPer30Days).toBe(Math.round(m.returnsPer30Days * 300));
    const worse = judge([...batch(100, 40, BEFORE, withV), ...batch(100, 60, AFTER, withV), ...rest], LATER).e;
    expect(returnsAvoidedMoney(worse, pkr("300.00"))).toBeNull();
  });
});

describe("what counts", () => {
  const asOf = new Date("2026-09-20T00:00:00Z");
  const placed = (daysAgo: number) => new Date(asOf.getTime() - daysAgo * 86_400_000);
  it("decided, open, or left out when stale or cancelled", () => {
    expect(stateOf({ outcome: "returned", createdAt: placed(200) }, asOf)).toBe("returned");
    expect(stateOf({ outcome: "in_transit", createdAt: placed(30) }, asOf)).toBe("open");
    expect(stateOf({ outcome: "in_transit", createdAt: placed(50) }, asOf)).toBe("stale");
    expect(stateOf({ outcome: "not_shipped", createdAt: placed(5) }, asOf)).toBe("open");
    expect(stateOf({ outcome: "not_shipped", createdAt: placed(20) }, asOf)).toBeNull();
    expect(stateOf({ outcome: "order_cancelled", createdAt: placed(5) }, asOf)).toBeNull();
  });
  it("windows are the 90 days before acting and days 1–28 after", () => {
    expect(W).toEqual({ before: { from: "2026-05-03", to: "2026-07-31" }, after: { from: "2026-08-02", to: addDays("2026-08-01", 28) } });
  });
  it("starts the before window no earlier than the store's first delivery", () => {
    const orders = [order({ ...at("2026-03-01"), outcome: "returned" }), order({ ...at("2026-07-01") })];
    expect(historyFromOf(orders)).toBe("2026-07-01");
    expect(windowsOf("2026-08-01", "2026-07-01").before).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(windowsOf("2026-08-01", "2026-01-01").before.from).toBe("2026-05-03");
  });
  it("counts stale open orders as left out, not as open", () => {
    const k = classifierFor("city_returns", "lahore", null, ctx) as Classifier;
    const t = tally([order({ ...at(AFTER), outcome: "in_transit", delivered: null })], k, W, new Date("2026-10-15T00:00:00Z"));
    expect(t.after.subject).toEqual({ delivered: 0, returned: 0, open: 0, stale: 1 });
  });
});

describe("subjects and comparisons per detector", () => {
  const cls = (d: string, subject: string, o: RollupOrder, c: GroupContext = ctx, finding: Record<string, unknown> | null = null) => {
    const k = classifierFor(d, subject, finding, c);
    return "reason" in k ? k.reason : k.classify(o);
  };
  it("city returns: the city, any case, against every other order", () => {
    expect(cls("city_returns", "lahore", order({ city: "Lahore" }))).toBe("subject");
    expect(cls("city_returns", "lahore", order({ city: null }))).toBe("rest");
  });
  it("courier for city: only Courierify orders with a city", () => {
    expect(cls("courier_for_city", "karachi", order({ city: "Karachi" }))).toBe("subject");
    expect(cls("courier_for_city", "karachi", order({ city: "Karachi", parcelCount: 0 }))).toBeNull();
    expect(cls("courier_for_city", "karachi", order({ city: null }))).toBeNull();
  });
  it("unconfirmed returns: the whole store against its own earlier rate", () => {
    const k = classifierFor("unconfirmed_returns", "store", null, ctx) as Classifier;
    expect(k.comparison).toBe(false);
    expect(k.classify(order())).toBe("subject");
  });
  it("returners: by the buyer's band when the order was placed", () => {
    const a = order();
    const b = order();
    const c = { ...ctx, bands: new Map([[a.orderId, "returned_before" as const], [b.orderId, "first" as const]]) };
    expect(cls("returners", "store", a, c)).toBe("subject");
    expect(cls("returners", "store", b, c)).toBe("rest");
    expect(cls("returners", "store", order(), c)).toBeNull();
    expect(cls("returners", "store", a)).toMatch(/not loaded/);
  });
  it("network risk: high against other labels, unlabelled left out", () => {
    const a = order();
    const b = order();
    const c = { ...ctx, labels: new Map([[a.orderId, "high"], [b.orderId, "low"]]) };
    expect(cls("network_risk", "store", a, c)).toBe("subject");
    expect(cls("network_risk", "store", b, c)).toBe("rest");
    expect(cls("network_risk", "store", order(), c)).toBeNull();
  });
  it("campaign returns: first orders of the campaigns flagged at the time", () => {
    const a = order();
    const b = order();
    const c = { ...ctx, firsts: new Map<string, string | null>([[a.orderId, "meta:1"], [b.orderId, null]]) };
    const f = { flagged: [{ key: "meta:1" }] };
    expect(cls("campaign_returns", "store", a, c, f)).toBe("subject");
    expect(cls("campaign_returns", "store", b, c, f)).toBe("rest");
    expect(cls("campaign_returns", "store", order(), c, f)).toBeNull(); // a repeat order
    expect(cls("campaign_returns", "store", a, c, null)).toMatch(/flagged/);
  });
  it("offer returns: form orders with the offer against form orders with none", () => {
    const [a, b, d] = [order(), order(), order()];
    const c = { ...ctx, offers: new Map<string, string[]>([[a.orderId, ["upsell"]], [b.orderId, []], [d.orderId, ["bundle"]]]) };
    expect(cls("offer_returns", "upsell", a, c)).toBe("subject");
    expect(cls("offer_returns", "upsell", b, c)).toBe("rest");
    expect(cls("offer_returns", "upsell", d, c)).toBeNull();
  });
  it("says why a detector is not measured here", () => {
    expect(cls("cash_held", "orio", order())).toMatch(/not measured from order history/);
  });
});

describe("a product losing money (I2)", () => {
  const line = (value: string) => ({ lines: [{ variantId: V, productId: "p", quantity: 1, value: pkr(value), cost: pkr("400.00") }] });
  const asOf = new Date("2026-09-20T10:00:00Z");
  // Before: 90 orders over 90 days, half returned, ads 60,000 → (45 × 600 − 60,000) per 90 days.
  const before = productProfit(batch(90, 45, BEFORE, line("1000.00")), V, "PKR", W.before, 90, 60_000, asOf);
  it("measures profit as delivered per 30 days", () => {
    expect(before.per30.asDelivered).toBe(-11_000);
  });
  it("improved when the loss at least halves even with open orders returned", () => {
    const after = productProfit(batch(28, 7, AFTER, line("1000.00")), V, "PKR", W.after, 28, 5_000, asOf);
    expect(after.per30.asDelivered).toBeGreaterThan(-5_500);
    expect(productVerdict(before, after)).toBe("improved");
  });
  it("improved when it stopped selling and its ads stopped", () => {
    expect(productVerdict(before, productProfit([], V, "PKR", W.after, 28, 0, asOf))).toBe("improved");
  });
  it("worse when the loss grew by half even with open orders delivered", () => {
    const after = productProfit(batch(28, 20, AFTER, line("1000.00")), V, "PKR", W.after, 28, 25_000, asOf);
    expect(productVerdict(before, after)).toBe("worse");
  });
  it("no direction while open orders could swing it", () => {
    const after = productProfit(batch(10, 5, "2026-08-25", line("1000.00"), 30), V, "PKR", W.after, 28, 10_000, asOf);
    expect(productVerdict(before, after)).toBeNull();
  });
});
