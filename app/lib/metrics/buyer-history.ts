import { MIN_ROUTE_Z, zScore } from "./findings";

/**
 * I5, is buyer verification worth turning on (Phase 5, G-GZR5-11), with
 * buyers scored by their own history with this store only (D-51) until the
 * buyer network exists (D-52).
 *
 * Each order is banded by what the same buyer's earlier orders had come to
 * *before it was placed* (`outcomeAt`), so nothing is judged with hindsight:
 *  - returned_before: an earlier order had come back;
 *  - delivered_before: earlier orders delivered, none came back;
 *  - first: nothing decided yet (a first order, or earlier ones still open).
 * The card compares returns from buyers who returned before with everyone
 * else's. No money: what verification would save waits for a backtest.
 */

export type Band = "returned_before" | "delivered_before" | "first";
export const BANDS: Band[] = ["returned_before", "delivered_before", "first"];

/** Decided orders in the "returned before" band before I5 speaks. */
export const MIN_DECIDED = 30;
/** Return-rate gap in points over everyone else. */
export const GAP_POINTS = 10;

export type HistoryOrder = { orderId: string; customerId: string; createdAt: Date; outcome: string; outcomeAt: Date | null };

const decided = (o: string) => o === "delivered" || o === "returned";

/** Each order's band, from that buyer's earlier orders whose outcome was already known. */
export function bandOrders(orders: readonly HistoryOrder[]): Map<string, Band> {
  const byBuyer = new Map<string, HistoryOrder[]>();
  for (const o of orders) byBuyer.set(o.customerId, [...(byBuyer.get(o.customerId) ?? []), o]);
  const band = new Map<string, Band>();
  for (const list of byBuyer.values()) {
    for (const o of list) {
      const t = o.createdAt.getTime();
      const known = list.filter((p) => p !== o && p.createdAt.getTime() < t && decided(p.outcome) && p.outcomeAt !== null && p.outcomeAt.getTime() < t);
      band.set(o.orderId, known.some((p) => p.outcome === "returned") ? "returned_before" : known.length ? "delivered_before" : "first");
    }
  }
  return band;
}

export type BandRow = { band: Band; orders: number; delivered: number; returned: number; rate: number | null };

export type BuyerHistoryView = {
  bands: BandRow[];
  /** Of the period's returns, the share from buyers who had returned before. */
  returnsFromReturners: number | null;
  /** Preventify's verification switch for the store, when Preventify is connected. */
  otpEnabled: boolean | null;
  /** Share of the period's orders placed through Preventify's COD form (OTP reaches only these); null without Preventify. */
  formShare: number | null;
};

/** The period's orders (by id) in each band, with what they did. */
export function buyerHistoryView(input: {
  history: readonly HistoryOrder[];
  periodOrderIds: ReadonlySet<string>;
  otpEnabled: boolean | null;
  /** The period's orders that came through Preventify's form, when Preventify is connected. */
  formOrderIds?: ReadonlySet<string> | null;
}): BuyerHistoryView {
  const band = bandOrders(input.history);
  const rows = new Map<Band, BandRow>(BANDS.map((b) => [b, { band: b, orders: 0, delivered: 0, returned: 0, rate: null }]));
  for (const o of input.history) {
    if (!input.periodOrderIds.has(o.orderId)) continue;
    const r = rows.get(band.get(o.orderId)!)!;
    r.orders += 1;
    if (o.outcome === "delivered") r.delivered += 1;
    if (o.outcome === "returned") r.returned += 1;
  }
  for (const r of rows.values()) {
    const d = r.delivered + r.returned;
    r.rate = d ? Math.round((1000 * r.returned) / d) / 10 : null;
  }
  const returns = [...rows.values()].reduce((n, r) => n + r.returned, 0);
  return {
    bands: BANDS.map((b) => rows.get(b)!),
    returnsFromReturners: returns ? Math.round((1000 * rows.get("returned_before")!.returned) / returns) / 10 : null,
    otpEnabled: input.otpEnabled,
    formShare: input.formOrderIds
      ? Math.round((1000 * [...input.periodOrderIds].filter((id) => input.formOrderIds!.has(id)).length) / input.periodOrderIds.size) / 10
      : null,
  };
}

export type ReturnersFinding = {
  kind: "returners";
  orders: number;
  decided: number;
  rate: number;
  restDecided: number;
  restRate: number;
  gapPoints: number;
  z: number;
  returnsFromReturners: number | null;
  otpEnabled: boolean | null;
  formShare: number | null;
};

type Skip = { kind: "skip"; status: "not_enough_data" | "nothing_found"; reason: string };

/** I5 (per store): buyers who returned before come back far more often than everyone else. */
export function returnersFinding(v: BuyerHistoryView | null | undefined): ReturnersFinding | Skip {
  if (!v) return { kind: "skip", status: "not_enough_data", reason: "No orders with a known buyer in this period" };
  const r = v.bands.find((b) => b.band === "returned_before")!;
  const rest = v.bands.filter((b) => b.band !== "returned_before");
  const d = r.delivered + r.returned;
  const restReturned = rest.reduce((n, b) => n + b.returned, 0);
  const restDecided = rest.reduce((n, b) => n + b.delivered + b.returned, 0);
  if (d < MIN_DECIDED || restDecided < MIN_DECIDED) {
    return { kind: "skip", status: "not_enough_data", reason: `${d} delivered or returned orders from buyers who returned before; ${MIN_DECIDED} are needed` };
  }
  const rate = (100 * r.returned) / d;
  const restRate = (100 * restReturned) / restDecided;
  const z = zScore(r.returned, d, restReturned, restDecided);
  if (rate - restRate < GAP_POINTS || z < MIN_ROUTE_Z) {
    return {
      kind: "skip",
      status: "nothing_found",
      reason: `Buyers who returned before come back ${rate.toFixed(1)}% of the time against ${restRate.toFixed(1)}% for everyone else: not a clear enough gap`,
    };
  }
  return {
    kind: "returners",
    orders: r.orders,
    decided: d,
    rate: Math.round(rate * 10) / 10,
    restDecided,
    restRate: Math.round(restRate * 10) / 10,
    gapPoints: Math.round((rate - restRate) * 10) / 10,
    z: Math.round(z * 100) / 100,
    returnsFromReturners: v.returnsFromReturners,
    otpEnabled: v.otpEnabled,
    formShare: v.formShare,
  };
}
