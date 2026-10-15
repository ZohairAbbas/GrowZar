import type { DetectorId } from "../insights/detectors";
import type { Band } from "../metrics/buyer-history";
import type { Money } from "../metrics/money";
import type { RollupOrder } from "../metrics/rollups";
import { AFTER_DAYS, BEFORE_DAYS, add, emptyTally, stateOf, type Side, type WindowTally } from "./measure";

/**
 * Who is in the subject and who in the comparison, per detector (pack §5),
 * the way each detector drew the line when it fired. Pure.
 */

/** Detectors G-GZR9-2 measures from order history. */
export const ORDER_BASED = new Set<DetectorId>([
  "courier_for_city",
  "city_returns",
  "unconfirmed_returns",
  "product_loss",
  "variant_returns",
  "campaign_returns",
  "returners",
  "network_risk",
  "offer_returns",
]);

/** What the classifiers may need beyond the order itself, loaded once per store. */
export type GroupContext = {
  currency: string;
  /** I5: each order's band from the buyer's own earlier orders (bandOrders). */
  bands?: ReadonlyMap<string, Band>;
  /** I5 network: Courierify's label for the buyer when each order was placed. */
  labels?: ReadonlyMap<string, string>;
  /** I10: each new buyer's first order and the campaign Financify ties it to. */
  firsts?: ReadonlyMap<string, string | null>;
  /** I9: the offer types each form order took (empty: none). */
  offers?: ReadonlyMap<string, readonly string[]>;
};

export type Classifier = { classify: (o: RollupOrder) => Side | null; comparison: boolean; label: string };

/** Why a watch cannot be measured; null when it can. */
export type Unmeasurable = { reason: string };

const viaCourierify = (o: RollupOrder) => o.parcelCount > 0;

/** The subject and comparison for a watch, from its detector, subject and baseline finding. */
export function classifierFor(
  detector: string,
  subject: string,
  finding: Record<string, unknown> | null,
  ctx: GroupContext,
): Classifier | Unmeasurable {
  const domestic = (o: RollupOrder) => o.currency === ctx.currency;
  const sameCity = (o: RollupOrder) => !!o.city && o.city.toLowerCase() === subject.toLowerCase();
  switch (detector as DetectorId) {
    case "variant_returns":
      return {
        label: "orders with this product, against the rest of the store",
        comparison: true,
        classify: (o) => (!domestic(o) ? null : o.lines.some((l) => l.variantId === subject) ? "subject" : "rest"),
      };
    case "city_returns":
      return { label: "the city's orders, against the rest of the store", comparison: true, classify: (o) => (!domestic(o) ? null : sameCity(o) ? "subject" : "rest") };
    case "courier_for_city":
      // The detector's universe: Courierify-booked orders with a city.
      return {
        label: "the city's Courierify orders, against the store's other cities",
        comparison: true,
        classify: (o) => (!domestic(o) || !viaCourierify(o) || !o.city ? null : sameCity(o) ? "subject" : "rest"),
      };
    case "unconfirmed_returns":
      // Pack §5: against the store's own earlier rate.
      return { label: "the store's orders, against its own earlier rate", comparison: false, classify: (o) => (domestic(o) ? "subject" : null) };
    case "returners":
      if (!ctx.bands) return { reason: "buyer history is not loaded" };
      return {
        label: "orders from buyers who returned before, against everyone else's",
        comparison: true,
        classify: (o) => {
          const b = domestic(o) ? ctx.bands!.get(o.orderId) : undefined;
          return !b ? null : b === "returned_before" ? "subject" : "rest";
        },
      };
    case "network_risk":
      if (!ctx.labels) return { reason: "Courierify's buyer labels are not loaded" };
      return {
        label: "orders from buyers Courierify rated high risk, against other rated buyers",
        comparison: true,
        classify: (o) => {
          const l = domestic(o) && viaCourierify(o) ? ctx.labels!.get(o.orderId) : undefined;
          return !l ? null : l === "high" ? "subject" : "rest";
        },
      };
    case "campaign_returns": {
      const flagged = Array.isArray(finding?.flagged) ? new Set((finding.flagged as Array<{ key: string }>).map((c) => c.key)) : null;
      if (!flagged?.size) return { reason: "the baseline does not say which campaigns were flagged" };
      if (!ctx.firsts) return { reason: "first orders are not loaded" };
      return {
        label: "new buyers' first orders from the flagged campaigns, against other new buyers'",
        comparison: true,
        classify: (o) => {
          if (!domestic(o) || !ctx.firsts!.has(o.orderId)) return null;
          const key = ctx.firsts!.get(o.orderId);
          return key && flagged.has(key) ? "subject" : "rest";
        },
      };
    }
    case "offer_returns":
      if (!ctx.offers) return { reason: "Preventify's form orders are not loaded" };
      return {
        label: "form orders that took the offer, against form orders with none",
        comparison: true,
        classify: (o) => {
          const types = domestic(o) ? ctx.offers!.get(o.orderId) : undefined;
          return !types ? null : types.includes(subject) ? "subject" : types.length ? null : "rest";
        },
      };
    default:
      return { reason: `${detector} is not measured from order history` };
  }
}

// ── Windows ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Store-local days: before = the 90 days before acting, after = days 1–28
 * after. The before window starts no earlier than the store's first
 * delivered order: before it, a store's grain can hold only imported returns
 * (yx4fu1-ax before July 2026), a 100% return rate that never was.
 */
export function windowsOf(actedDay: string, historyFrom: string | null = null) {
  const from = addDays(actedDay, -BEFORE_DAYS);
  return {
    before: { from: historyFrom && historyFrom > from ? historyFrom : from, to: addDays(actedDay, -1) },
    after: { from: addDays(actedDay, 1), to: addDays(actedDay, AFTER_DAYS) },
  };
}

/** The first day the store's history has a delivery on: where a before window may start. */
export const historyFromOf = (orders: readonly RollupOrder[]): string | null =>
  orders.reduce<string | null>((min, o) => (o.outcome === "delivered" && o.localDay && (!min || o.localDay < min) ? o.localDay : min), null);

export type Windows = ReturnType<typeof windowsOf>;
const inWindow = (o: RollupOrder, w: { from: string; to: string }) => !!o.localDay && o.localDay >= w.from && o.localDay <= w.to;

/** Count both windows' orders as they stand at `asOf`. */
export function tally(orders: readonly RollupOrder[], c: Classifier, w: Windows, asOf: Date): { before: WindowTally; after: WindowTally } {
  const make = (): WindowTally => ({ subject: emptyTally(), rest: c.comparison ? emptyTally() : null });
  const before = make();
  const after = make();
  for (const o of orders) {
    const into = inWindow(o, w.before) ? before : inWindow(o, w.after) ? after : null;
    if (!into) continue;
    const side = c.classify(o);
    if (!side) continue;
    const state = stateOf(o, asOf);
    if (!state) continue;
    const t = side === "subject" ? into.subject : into.rest;
    if (t) add(t, state);
  }
  return { before, after };
}

// ── I2: a product's profit as delivered ──────────────────────────────────────

export type ProfitWindow = {
  /** Per 30 days, in the store's currency, millionths as a number of whole units. */
  per30: { asDelivered: number; ifOpenDeliver: number };
  orders: number;
  decided: number;
  open: number;
  adSpend: number;
  days: number;
};

const units = (m: Money | null | undefined, currency: string) => (m && m.currency === currency ? Number(m.amount) : 0);

/**
 * The product's delivered value less its cost and its ad spend, per 30 days
 * (I2's own "as delivered" figure, PLAN §4). Open orders are counted both
 * ways: returned (nothing) and delivered (their value less cost).
 */
export function productProfit(
  orders: readonly RollupOrder[],
  variantId: string,
  currency: string,
  w: { from: string; to: string },
  days: number,
  adSpend: number,
  asOf: Date,
): ProfitWindow {
  let delivered = 0;
  let openValue = 0;
  let n = 0;
  let decided = 0;
  let open = 0;
  for (const o of orders) {
    if (o.currency !== currency || !inWindow(o, w)) continue;
    const lines = o.lines.filter((l) => l.variantId === variantId);
    if (!lines.length) continue;
    const state = stateOf(o, asOf);
    if (!state || state === "stale") continue;
    n += 1;
    const net = lines.reduce((a, l) => a + units(l.value, currency) - units(l.cost, currency), 0);
    if (state === "delivered") delivered += net;
    if (state === "open") {
      open += 1;
      openValue += net;
    } else decided += 1;
  }
  const per30 = (x: number) => Math.round(((x - adSpend) * 30) / days);
  return { per30: { asDelivered: per30(delivered), ifOpenDeliver: per30(delivered + openValue) }, orders: n, decided, open, adSpend: Math.round(adSpend), days };
}

/** I2 improved when even with every open order returned the loss per 30 days at least halved; worse when it at least grew by half. */
export const PRODUCT_LOSS_CHANGE = 0.5;

export function productVerdict(before: ProfitWindow, after: ProfitWindow): "improved" | "worse" | "no_change" | null {
  const base = before.per30.asDelivered;
  const step = Math.abs(base) * PRODUCT_LOSS_CHANGE;
  if (!step) return null;
  if (after.per30.asDelivered >= base + step) return "improved";
  if (after.per30.ifOpenDeliver <= base - step) return "worse";
  if (after.per30.asDelivered > base - step && after.per30.ifOpenDeliver < base + step) return "no_change";
  return null;
}
