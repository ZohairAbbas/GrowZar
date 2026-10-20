import { describe, expect, it } from "vitest";

import { gateFixes } from "./gate";
import { atSpend, buildNodes, fitCurve, K, windowOf } from "./nodes";
import { cashDelay, simulate, stepFor } from "./plan";
import { replayAt, scoreReplay } from "./replay";
import type { SimData, SimOrder, SimRequest, SpendDay, StockItem } from "./types";
import { requireAdvance, switchCourier } from "./whatif";

// A made-up store: two Facebook campaigns over 90 days, one strong (A), one thin (B).
const DAY = 86_400_000;
const AS_OF = new Date("2026-10-20T00:00:00Z");
const day = (n: number) => new Date(AS_OF.getTime() - n * DAY).toISOString().slice(0, 10);
let seq = 0;
const order = (daysAgo: number, o: Partial<SimOrder> = {}): SimOrder => ({
  orderId: `o${++seq}`, createdAt: new Date(AS_OF.getTime() - daysAgo * DAY + 3_600_000), campaignKey: null, platform: null,
  delivered: true, contribution: 1000, lines: [{ variantId: "v1", quantity: 1 }], city: "Lahore", courier: "trax", payment: "cod", ...o,
});

function store(o: { stock?: StockItem[] | null } = {}): SimData {
  const orders: SimOrder[] = [];
  const spend: SpendDay[] = [];
  for (let d = 22; d <= 111; d++) {
    spend.push({ day: day(d), level: "platform", key: "facebook", platform: "facebook", amount: 1500 });
    spend.push({ day: day(d), level: "campaign", key: "facebook:A", platform: "facebook", amount: 1000 });
    spend.push({ day: day(d), level: "campaign", key: "facebook:B", platform: "facebook", amount: 500 });
    // A: 1 order a day, 3,000 each delivered (3 per rupee); B: one order every 9 days.
    orders.push(order(d, { campaignKey: "facebook:A", platform: "facebook", contribution: 3000 }));
    if (d % 9 === 0) orders.push(order(d, { campaignKey: "facebook:B", platform: "facebook", contribution: 600 }));
    // And one not credited to any ad.
    orders.push(order(d));
  }
  return {
    asOf: AS_OF, today: day(0), currency: "PKR", orders, spend,
    campaignNames: new Map([["facebook:A", "Strong"], ["facebook:B", "Thin"]]),
    stock: o.stock ?? null,
    deliveryDays: { median: 5, p90: 10 },
    payers: [{ payer: "leopards", share: 1, lag: 3, basis: "measured", reason: null }],
    recentDailySpend: 1500,
    gate: {
      historyDays: 200, adDaysFetched: 90, adDaysWindow: 90, deliveredOrders: 180, deliveredWithCost: 180, productsMissingCost: [],
      orders: 200, attributedOrders: 150, links: { costs: { label: "Add missing product costs in Financify", href: "https://x/costs" }, adAccounts: null, courierify: null },
    },
  };
}
const request = (o: Partial<SimRequest> = {}): SimRequest => ({
  budget: 100_000, horizonDays: 30, include: { ads: true, stock: false, buffer: true }, keepInStock: [], minBuffer: 0, excludePlatforms: [], leadTimes: {}, payoutLags: {}, ...o,
});

describe("the gate", () => {
  it("passes a store with the data, and refuses one without it, saying what to fix and where", () => {
    expect(gateFixes(store(), request())).toEqual([]);
    const thin = store();
    thin.gate = { ...thin.gate, historyDays: 40, deliveredWithCost: 100, productsMissingCost: ["Lawn suit", "Shawl"], attributedOrders: 100 };
    thin.deliveryDays = null;
    const fixes = gateFixes(thin, request());
    expect(fixes.map((f) => f.check)).toEqual(["history", "product_cost", "attribution", "delivery_times"]);
    expect(fixes[1]).toMatchObject({ action: { href: "https://x/costs" } });
    expect(fixes[1]!.detail).toContain("these 2 products in Financify: Lawn suit, Shawl");
  });

  it("asks for a payout lag where the cycle is unknown, until the merchant gives one (P11-5)", () => {
    const s = store();
    s.payers = [{ payer: "orio", share: 0.6, lag: null, basis: "unknown", reason: "57% unpaid" }, { payer: "tiny", share: 0.01, lag: null, basis: "unknown", reason: null }];
    expect(gateFixes(s, request()).map((f) => [f.check, f.payer])).toEqual([["payout_lag", "orio"]]);
    expect(gateFixes(s, request({ payoutLags: { orio: 10 } }))).toEqual([]);
    expect(simulate(s, request()).status).toBe("refused");
  });
});

describe("the hierarchy", () => {
  it("plans one line per platform while campaign lines are off", () => {
    expect(buildNodes(store()).nodes.map((n) => [n.kind, n.label, n.n])).toEqual([["platform_group", "Facebook ads", 100]]);
  });

  it("with campaign lines on, gives a well-measured campaign its own line; the thin rest is left out", () => {
    const { nodes, window, thin } = buildNodes(store(), [], { campaignLines: true });
    expect(window).toEqual(windowOf(store()));
    expect(nodes.map((n) => [n.kind, n.key, n.n])).toEqual([["campaign", "facebook:A", 90]]);
    // The other campaigns have 10 decided orders: a line needs 30.
    expect(thin).toEqual([{ label: "Other campaigns on facebook", n: 10, spendDays: 90 }]);
    // A's own 3.0 per rupee, pooled with the platform's (90×3000 + 10×600) / 135,000 = 2.04.
    const w = 90 / (90 + K);
    expect(nodes[0]!.perRupee).toBeCloseTo(w * 3 + (1 - w) * (276_000 / 135_000));
  });

  it("leaves out a platform too thin to plan, and says why", () => {
    const s = store();
    for (let d = 22; d <= 26; d++) s.spend.push({ day: day(d), level: "platform", key: "snapchat", platform: "snapchat", amount: 300 });
    s.orders.push(order(23, { platform: "snapchat", campaignKey: "snapchat:1" }));
    const built = buildNodes(s);
    expect(built.nodes.map((n) => n.label)).toEqual(["Facebook ads"]);
    expect(built.thin).toEqual([{ label: "Snapchat ads", n: 1, spendDays: 5 }]);
    const plan = simulate(s, request());
    if (plan.status !== "plan") throw new Error("refused");
    expect(plan.leftOut).toContain("Snapchat ads: not enough data to plan (1 decided orders and 5 days of spend; a line needs 30 and 14)");
  });

  it("leaves out a platform the merchant excludes", () => {
    expect(buildNodes(store(), ["Facebook"]).nodes).toEqual([]);
  });

  it("bends sales with spend, bounded, and falls back to 0.7 on a thin or loose fit", () => {
    const days = Array.from({ length: 40 }, (_, i) => ({ spend: 1000 + i * 100, orders: Math.round(2 * (1000 + i * 100) ** 0.8) }));
    const c = fitCurve(days);
    expect(c.stable).toBe(true);
    expect(c.b).toBeCloseTo(0.8, 1);
    expect(fitCurve(days.slice(0, 10))).toEqual({ b: 0.7, stable: false, days: 10 });
    expect(fitCurve(days.map((d) => ({ ...d, orders: d.spend ** 2 })))).toMatchObject({ b: 1 });
    // Doubling spend at b = 0.5 brings √2 the orders.
    const node = { dailyAvg: 1000, perRupee: 2, ordersPerRupee: 0.001 };
    expect(atSpend(node, 0.5, 2000, 30).orders / atSpend(node, 0.5, 1000, 30).orders).toBeCloseTo(Math.SQRT2);
  });
});

describe("the plan", () => {
  it("fills the buffer first, then puts steps where a rupee earns most, never past 1.5× the highest day", () => {
    const plan = simulate(store(), request());
    if (plan.status !== "plan") throw new Error("refused");
    const delay = cashDelay(store(), request());
    expect(delay).toMatchObject({ median: 8, p90: 13, lag: 3 });
    const [buffer, ...rest] = plan.lines;
    expect(buffer).toMatchObject({ kind: "buffer", amount: Math.round((100_000 * 8) / 38) });
    const a = rest.find((l) => l.key === "facebook:other")!;
    expect(a.amount).toBeGreaterThan(0);
    // The platform has spent 1,500 a day: never more than 1.5× that.
    expect(a.amount / 30).toBeLessThanOrEqual(1.5 * 1500 + 1e-6);
    expect(a.profit.low).toBeLessThanOrEqual(a.profit.likely);
    expect(a.cashBackBy).toBe(day(-43));
    expect(plan.totals.allocated + plan.totals.kept).toBeCloseTo(100_000);
  });

  it("keeps cash rather than spend it where it earns less than it costs, and says so", () => {
    const s = store();
    for (const o of s.orders) o.contribution = 100;
    const plan = simulate(s, request());
    if (plan.status !== "plan") throw new Error("refused");
    expect(plan.lines.map((l) => l.kind)).toEqual(["buffer"]);
    expect(plan.leftOut.some((l) => l.includes("kept as cash"))).toBe(true);
  });

  it("buys the stock an ad line's sales need when it can arrive in time, and doesn't count sales that can't be served", () => {
    const item = (lead: number | null): StockItem => ({ variantId: "v1", title: "Lawn suit", stock: 0, onOrder: 0, netPerDay: 0.5, leadTimeDays: lead, leadSource: "setting", unitCost: 400, unitMargin: 500 });
    const inTime = simulate(store({ stock: [item(7)] }), request({ include: { ads: true, stock: true, buffer: false } }));
    if (inTime.status !== "plan") throw new Error("refused");
    expect(inTime.lines.some((l) => l.kind === "stock")).toBe(true);
    const tooLate = simulate(store({ stock: [item(45)] }), request({ include: { ads: true, stock: true, buffer: false } }));
    if (tooLate.status !== "plan") throw new Error("refused");
    expect(tooLate.lines.filter((l) => l.kind === "stock")).toEqual([]);
    expect(tooLate.lines.every((l) => l.kind !== "campaign")).toBe(true);
  });

  it("steps PKR 5,000 and AED 250 (P11-12)", () => {
    expect([stepFor("PKR", 1e5), stepFor("AED", 5e3), stepFor("USD", 2e3)]).toEqual([5000, 250, 100]);
  });
});

describe("what-ifs", () => {
  it("refuses without enough history, and prices a courier switch from the city's own rates", () => {
    const s = store();
    const plan = simulate(s, request());
    expect(switchCourier(plan, s, "Lahore", "trax", "leopards")).toMatchObject({ status: "refused" });
    // 40 Lahore orders by leopards, all delivered; trax's Lahore orders: 1 in 4 returned.
    for (let i = 0; i < 40; i++) s.orders.push(order(30 + i, { courier: "leopards", campaignKey: "facebook:A", platform: "facebook" }));
    s.orders.filter((o) => o.courier === "trax" && o.campaignKey).forEach((o, i) => i % 4 === 0 && ((o.delivered = false), (o.contribution = -300)));
    const w = switchCourier(plan, s, "Lahore", "trax", "leopards");
    expect(w.status).toBe("ok");
    if (w.status === "ok") expect(w.profit.likely).toBeGreaterThan(0);
    expect(requireAdvance(plan, s, "Lahore")).toMatchObject({ status: "refused", reason: expect.stringContaining("prepaid") });
  });
});

describe("the replay", () => {
  it("predicts a line at the spend it had and scores it against what it made", () => {
    const now = store();
    // What happened after: A kept going at 1,000 a day for 30 days.
    for (let d = 1; d <= 30; d++) {
      now.spend.push({ day: day(-d + 1), level: "campaign", key: "facebook:A", platform: "facebook", amount: 1000 });
      now.orders.push(order(-d + 1, { campaignKey: "facebook:A", platform: "facebook", contribution: 2500 }));
    }
    const lines = replayAt(store(), now, { campaignLines: true });
    const a = lines.find((l) => l.key === "facebook:A")!;
    expect(a.spend).toBe(30_000);
    expect(a.actual).toBeCloseTo(2.5);
    expect(scoreReplay(lines).tested).toBe(lines.length);
  });
});
