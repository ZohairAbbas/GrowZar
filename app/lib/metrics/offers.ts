import { formatAmount, parseAmount, type Money } from "./money";
import { MIN_ROUTE_Z, zScore } from "./findings";

/**
 * I9, offers that raise order value and returns at the same time (Phase 5,
 * G-GZR5-10), from Preventify's form orders (which offer each order took)
 * joined by Shopify order id to Growzar's own orders.
 *
 * Order value is Financify's placed amount, never Preventify's: its line
 * prices may be in the buyer's currency on Markets shops. Outcomes are the
 * order grain's (Courierify, else Financify). An order with several offers
 * counts in each of their groups; "no offer" is form orders that took none.
 * No money estimate: the card states the lift in order value and in returns,
 * and waits for a backtest before saying what it costs.
 */

export type OfferType = "bundle" | "one_tick" | "upsell" | "downsell";
export const OFFER_TYPES: OfferType[] = ["bundle", "one_tick", "upsell", "downsell"];
export const OFFER_LABEL: Record<OfferType | "none", string> = {
  bundle: "Bundles",
  one_tick: "One-tick add-ons",
  upsell: "Upsells",
  downsell: "Downsells (discount to stay)",
  none: "No offer",
};

/** Decided orders (delivered or returned) on each side before a return rate is compared. */
export const MIN_DECIDED = 30;
/** Decided orders before a group's return rate is shown at all. */
export const MIN_SHOWN = 10;
/** Return-rate gap, in points, that makes an offer worth a card. */
export const GAP_POINTS = 5;
/** And it must be unlikely to be chance: the same one-sided z as I1's routes. */
export const MIN_Z = MIN_ROUTE_Z;

export type FormOrder = {
  orderId: string;
  createdAt: Date;
  offers: Array<{ type: OfferType; offerId: string | null; source: string | null }>;
};

export type OrderFacts = { placed: Money | null; outcome: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseFormOrder(p: unknown): FormOrder | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const orderId = str(r.orderId);
  const createdAt = typeof r.createdAt === "string" && !Number.isNaN(Date.parse(r.createdAt)) ? new Date(r.createdAt) : null;
  if (!orderId || !createdAt) return null;
  const offers: FormOrder["offers"] = [];
  for (const l of Array.isArray(r.lines) ? r.lines : []) {
    const o = l && typeof l === "object" ? ((l as Record<string, unknown>).offer as Record<string, unknown> | null) : null;
    const type = str(o?.type) as OfferType | null;
    if (o && type && OFFER_TYPES.includes(type)) offers.push({ type, offerId: str(o.offerId), source: str(o.source) });
  }
  const d = r.downsell && typeof r.downsell === "object" ? (r.downsell as Record<string, unknown>) : null;
  if (d) offers.push({ type: "downsell", offerId: str(d.offerId), source: "preventify" });
  return { orderId, createdAt, offers };
}

export type OfferGroup = {
  key: string;
  type: OfferType | "none";
  label: string;
  offerId: string | null;
  orders: number;
  delivered: number;
  returned: number;
  /** Returned ÷ (delivered + returned), when at least MIN_SHOWN are decided. */
  returnRate: number | null;
  /** Mean placed order value in the store's currency, over orders that have one. */
  avgPlaced: Money | null;
};

function group(key: string, type: OfferType | "none", label: string, offerId: string | null, rows: OrderFacts[], currency: string | null): OfferGroup {
  const delivered = rows.filter((r) => r.outcome === "delivered").length;
  const returned = rows.filter((r) => r.outcome === "returned").length;
  const decided = delivered + returned;
  const values = currency ? rows.map((r) => (r.placed?.currency === currency ? parseAmount(r.placed.amount) : null)).filter((v): v is bigint => v !== null) : [];
  return {
    key,
    type,
    label,
    offerId,
    orders: rows.length,
    delivered,
    returned,
    returnRate: decided >= MIN_SHOWN ? Math.round((1000 * returned) / decided) / 10 : null,
    avgPlaced: values.length && currency ? { amount: formatAmount(values.reduce((a, b) => a + b, 0n) / BigInt(values.length)), currency } : null,
  };
}

export type OffersView = {
  currency: string | null;
  formOrders: number;
  /** "No offer" first, then each offer type that occurs. */
  byType: OfferGroup[];
  /** Each offer that occurs, by orders. */
  byOffer: OfferGroup[];
  /** Offer events since Preventify started dating them (2026-10-09): shown and clicked, indicative. */
  events: Array<{ offerId: string; shown: number; accepted: number }>;
};

export function offersView(input: {
  formOrders: readonly FormOrder[];
  facts: ReadonlyMap<string, OrderFacts>;
  offerNames: ReadonlyMap<string, { name: string; type: string }>;
  events: ReadonlyArray<{ offerId: string; kind: string }>;
  currency: string | null;
}): OffersView {
  const known = input.formOrders.filter((o) => input.facts.has(o.orderId));
  const factsOf = (orders: readonly FormOrder[]) => orders.map((o) => input.facts.get(o.orderId)!);
  const byType: OfferGroup[] = [group("none", "none", OFFER_LABEL.none, null, factsOf(known.filter((o) => !o.offers.length)), input.currency)];
  for (const t of OFFER_TYPES) {
    const rows = known.filter((o) => o.offers.some((x) => x.type === t));
    if (rows.length) byType.push(group(t, t, OFFER_LABEL[t], null, factsOf(rows), input.currency));
  }
  const ids = new Map<string, { type: OfferType; source: string | null }>();
  for (const o of known) for (const x of o.offers) if (x.offerId) ids.set(x.offerId, { type: x.type, source: x.source });
  const byOffer = [...ids.entries()]
    .map(([id, meta]) => {
      const name = input.offerNames.get(id)?.name ?? (meta.source === "third_party" ? "Another app's bundle" : "Offer not synced");
      return group(id, meta.type, name, id, factsOf(known.filter((o) => o.offers.some((x) => x.offerId === id))), input.currency);
    })
    .sort((a, b) => b.orders - a.orders || a.label.localeCompare(b.label));
  const ev = new Map<string, { shown: number; accepted: number }>();
  for (const e of input.events) {
    const v = ev.get(e.offerId) ?? { shown: 0, accepted: 0 };
    if (e.kind === "shown") v.shown += 1;
    if (e.kind === "accepted") v.accepted += 1;
    ev.set(e.offerId, v);
  }
  return {
    currency: input.currency,
    formOrders: known.length,
    byType,
    byOffer,
    events: [...ev.entries()].map(([offerId, v]) => ({ offerId, ...v })).sort((a, b) => b.shown - a.shown),
  };
}

export type OfferReturnsFinding = {
  kind: "offer_returns";
  type: OfferType;
  label: string;
  orders: number;
  decided: number;
  returnRate: number;
  /** Two-proportion z of the gap (one-sided); at least MIN_Z. */
  z: number;
  baselineDecided: number;
  baselineRate: number;
  gapPoints: number;
  /** Order value lift over orders with no offer, in percent; null without values. */
  valueLiftPct: number | null;
  avgPlaced: Money | null;
  baselineAvg: Money | null;
};

type Skip = { kind: "skip"; status: "not_enough_data" | "nothing_found"; reason: string };

const decidedOf = (g: OfferGroup) => g.delivered + g.returned;
const rate = (g: OfferGroup) => (decidedOf(g) ? (100 * g.returned) / decidedOf(g) : 0);

/** I9: offer types that raise order value and returns at the same time. */
export function offerReturnsFindings(v: OffersView | null | undefined): OfferReturnsFinding[] | Skip {
  if (!v || !v.formOrders) return { kind: "skip", status: "not_enough_data", reason: "Preventify has sent no form orders that match the store's orders" };
  const base = v.byType.find((g) => g.type === "none")!;
  const offers = v.byType.filter((g) => g.type !== "none");
  if (!offers.length) return { kind: "skip", status: "nothing_found", reason: "No form order took an offer" };
  const ready = offers.filter((g) => decidedOf(g) >= MIN_DECIDED);
  if (decidedOf(base) < MIN_DECIDED || !ready.length) {
    const best = [...offers].sort((a, b) => decidedOf(b) - decidedOf(a))[0]!;
    return {
      kind: "skip",
      status: "not_enough_data",
      reason: `${MIN_DECIDED} delivered or returned orders are needed on each side; ${best.label.toLowerCase()} have ${decidedOf(best)}, orders with no offer ${decidedOf(base)}`,
    };
  }
  const lift = (g: OfferGroup) => {
    const a = g.avgPlaced ? parseAmount(g.avgPlaced.amount) : null;
    const b = base.avgPlaced ? parseAmount(base.avgPlaced.amount) : null;
    return a !== null && b !== null && b > 0n ? Number(((a - b) * 1000n) / b) / 10 : null;
  };
  const found = ready
    .map((g): OfferReturnsFinding => ({
      kind: "offer_returns",
      type: g.type as OfferType,
      label: g.label,
      orders: g.orders,
      decided: decidedOf(g),
      returnRate: Math.round(rate(g) * 10) / 10,
      baselineDecided: decidedOf(base),
      baselineRate: Math.round(rate(base) * 10) / 10,
      gapPoints: Math.round((rate(g) - rate(base)) * 10) / 10,
      z: Math.round(zScore(g.returned, decidedOf(g), base.returned, decidedOf(base)) * 100) / 100,
      valueLiftPct: lift(g),
      avgPlaced: g.avgPlaced,
      baselineAvg: base.avgPlaced,
    }))
    .filter((f) => f.gapPoints >= GAP_POINTS && (f.valueLiftPct ?? 0) > 0);
  const sure = found.filter((f) => f.z >= MIN_Z);
  if (!sure.length) {
    return {
      kind: "skip",
      status: found.length ? "not_enough_data" : "nothing_found",
      reason: found.length
        ? `${found[0]!.label} return ${found[0]!.gapPoints} points more (${found[0]!.returnRate}% of ${found[0]!.decided}), but too few orders to tell it from chance yet`
        : `No offer type returns ${GAP_POINTS} points more than orders with no offer`,
    };
  }
  return sure.sort((a, b) => b.gapPoints - a.gapPoints);
}
