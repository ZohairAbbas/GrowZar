/**
 * What-ifs on top of a plan (G-GZR11-5, pack §5.2). Pure.
 *
 * - **Switch courier in a city**: the plan's orders that would go to that
 *   city with one courier are delivered at another courier's rate there
 *   (I1's comparison: both need MIN_DECIDED decided orders in the city).
 * - **Require advance payment in a city** (P11-11): a share of those orders
 *   is lost (low / likely / high = 50 / 35 / 20%, or the merchant's), and the
 *   rest come back at the store's prepaid return rate (needs MIN_DECIDED
 *   decided prepaid orders; I12's city return rate gives the "before").
 *
 * The plan's orders are split by city and courier as the store's recent
 * ad-credited orders were. Effects are on delivered orders and profit.
 */

import type { Range } from "../stats";
import { windowOf } from "./nodes";
import type { Plan, SimData } from "./types";

export const MIN_DECIDED = 30;
/** P11-11: share of orders lost when advance payment is required, for the low / likely / high profit. */
export const ADVANCE_LOSS = { low: 0.5, likely: 0.35, high: 0.2 } as const;

export type WhatIf =
  | { status: "ok"; deliveredOrders: Range; profit: Range; basis: string[] }
  | { status: "refused"; reason: string };

const pct = (x: number) => `${Math.round(x * 100)}%`;
const lower = (s: string | null) => s?.toLowerCase() ?? null;

function history(data: SimData) {
  const win = windowOf(data);
  const decided = data.orders.filter((o) => {
    const d = o.createdAt.toISOString().slice(0, 10);
    return o.delivered !== null && d >= win.from && d < win.to;
  });
  const credited = decided.filter((o) => o.campaignKey || o.platform);
  const del = decided.filter((o) => o.delivered);
  const ret = decided.filter((o) => !o.delivered);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
  return {
    decided,
    credited,
    storeRate: decided.length ? del.length / decided.length : 0,
    valueDelivered: mean(del.map((o) => o.contribution)),
    valueReturned: mean(ret.map((o) => o.contribution)),
  };
}

/** Orders the plan places (delivered ÷ delivery rate), per its range. */
const placedOf = (plan: Extract<Plan, { status: "plan" }>, rate: number): Range => {
  const d = plan.totals.deliveredOrders;
  return rate ? { low: d.low / rate, likely: d.likely / rate, high: d.high / rate } : { low: 0, likely: 0, high: 0 };
};

export function switchCourier(plan: Plan, data: SimData, city: string, from: string, to: string): WhatIf {
  if (plan.status !== "plan") return { status: "refused", reason: "there is no plan to apply it to" };
  const h = history(data);
  const inCity = (c: string) => h.decided.filter((o) => lower(o.city) === city.toLowerCase() && lower(o.courier) === c.toLowerCase());
  const a = inCity(from);
  const b = inCity(to);
  if (a.length < MIN_DECIDED || b.length < MIN_DECIDED)
    return { status: "refused", reason: `needs ${MIN_DECIDED} decided orders in ${city} with each courier (${from}: ${a.length}, ${to}: ${b.length})` };
  const rate = (xs: typeof a) => xs.filter((o) => o.delivered).length / xs.length;
  const gap = rate(b) - rate(a);
  const share = h.credited.length ? h.credited.filter((o) => lower(o.city) === city.toLowerCase() && lower(o.courier) === from.toLowerCase()).length / h.credited.length : 0;
  const placed = placedOf(plan, h.storeRate);
  const per = h.valueDelivered - h.valueReturned;
  const d = (n: number) => n * share * gap;
  return {
    status: "ok",
    deliveredOrders: { low: d(placed.low), likely: d(placed.likely), high: d(placed.high) },
    profit: { low: d(placed.low) * per, likely: d(placed.likely) * per, high: d(placed.high) * per },
    basis: [
      `In ${city}, ${from} delivered ${pct(rate(a))} of ${a.length} decided orders and ${to} ${pct(rate(b))} of ${b.length}.`,
      `${pct(share)} of the plan's orders are expected to go to ${city} with ${from}.`,
      `A delivered order is worth ${Math.round(per).toLocaleString("en-US")} more than a returned one.`,
    ],
  };
}

export function requireAdvance(plan: Plan, data: SimData, city: string, loss: { low: number; likely: number; high: number } = ADVANCE_LOSS): WhatIf {
  if (plan.status !== "plan") return { status: "refused", reason: "there is no plan to apply it to" };
  const h = history(data);
  const prepaid = h.decided.filter((o) => o.payment === "prepaid");
  if (prepaid.length < MIN_DECIDED) return { status: "refused", reason: `needs ${MIN_DECIDED} decided prepaid orders to know how prepaid orders come back (the store has ${prepaid.length})` };
  const cityOrders = h.decided.filter((o) => lower(o.city) === city.toLowerCase());
  if (cityOrders.length < MIN_DECIDED) return { status: "refused", reason: `needs ${MIN_DECIDED} decided orders in ${city} (the store has ${cityOrders.length})` };
  const rateCity = cityOrders.filter((o) => o.delivered).length / cityOrders.length;
  const ratePrepaid = prepaid.filter((o) => o.delivered).length / prepaid.length;
  const share = h.credited.length ? h.credited.filter((o) => lower(o.city) === city.toLowerCase()).length / h.credited.length : 0;
  const placed = placedOf(plan, h.storeRate);
  const value = (rate: number) => rate * h.valueDelivered + (1 - rate) * h.valueReturned;
  // Per order placed in the city: before, everyone pays on delivery; after, `l` of them don't order.
  const effect = (n: number, l: number) => {
    const orders = n * share;
    return {
      delivered: orders * ((1 - l) * ratePrepaid - rateCity),
      profit: orders * ((1 - l) * value(ratePrepaid) - value(rateCity)),
    };
  };
  const lo = effect(placed.low, loss.low);
  const li = effect(placed.likely, loss.likely);
  const hi = effect(placed.high, loss.high);
  return {
    status: "ok",
    deliveredOrders: { low: Math.min(lo.delivered, li.delivered), likely: li.delivered, high: Math.max(hi.delivered, li.delivered) },
    profit: { low: Math.min(lo.profit, li.profit), likely: li.profit, high: Math.max(hi.profit, li.profit) },
    basis: [
      `${city}: ${pct(rateCity)} of ${cityOrders.length} decided orders delivered; prepaid orders store-wide: ${pct(ratePrepaid)} of ${prepaid.length}.`,
      `${pct(loss.likely)} of ${city}'s orders assumed lost when advance payment is asked (range ${pct(loss.high)}–${pct(loss.low)}); nobody has measured this.`,
      `${pct(share)} of the plan's orders are expected to go to ${city}.`,
    ],
  };
}
