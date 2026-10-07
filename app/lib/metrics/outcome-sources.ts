/**
 * Outcome sources that can only say one thing (or nothing), and couriers whose payouts
 * Growzar cannot see. Pure.
 *
 * One-sided outcomes: for parcels Courierify did not book, the outcome comes
 * from Financify (rule #7's fallback). On some stores Financify hears about
 * returns for a carrier but never about deliveries: `yx4fu1-ax`'s orders with
 * no carrier had 121 returns and 0 deliveries in 90 days. Counting those
 * returns with no deliveries beside them drags every delivery rate down, so
 * a slice like that has its outcomes withheld — set to "unknown" — before
 * anything is added up. Detected per store from its own history, never
 * hard-coded: `0dscam-qn`'s Financify outcomes include deliveries and stay.
 *
 * Untracked couriers: COD a courier has not paid is "owed" only if Growzar can
 * see that courier's payouts at all. A courier with no settlement ever
 * recorded in Courierify looks exactly like one that was paid and never
 * recorded, so its delivered COD is reported apart, never as owed.
 */
import { byCourier, type RollupOrder } from "./rollups";

/** Returns a slice needs, with no delivery, before it is treated as one-sided. */
export const MIN_RETURNS_FOR_ONE_SIDED = 5;
/**
 * Or: shipped orders this many days old still with no outcome, and no
 * delivery at all. A source that never reports anything is one-sided too —
 * Financify confirmed (2026-10-07) that parcels booked with a courier outside
 * Shopify and Courierify are never tracked by any app.
 */
export const STALE_OPEN_DAYS = 14;
export const MIN_STALE_OPEN_FOR_ONE_SIDED = 10;
/** Days of history the check reads. */
export const ONE_SIDED_HISTORY_DAYS = 90;

/**
 * Financify-decided orders (no Courierify parcel) per carrier key, over the
 * history window: delivered, returned, and shipped orders older than
 * STALE_OPEN_DAYS still in transit.
 */
export type SliceHistory = Array<{ courier: string; delivered: number; returned: number; staleOpen?: number }>;

export function oneSidedSlices(history: SliceHistory): string[] {
  const by = new Map<string, { delivered: number; returned: number; staleOpen: number }>();
  for (const h of history) {
    const e = by.get(h.courier) ?? { delivered: 0, returned: 0, staleOpen: 0 };
    e.delivered += h.delivered;
    e.returned += h.returned;
    e.staleOpen += h.staleOpen ?? 0;
    by.set(h.courier, e);
  }
  return [...by.entries()]
    .filter(([, e]) => e.delivered === 0 && (e.returned >= MIN_RETURNS_FOR_ONE_SIDED || e.staleOpen >= MIN_STALE_OPEN_FOR_ONE_SIDED))
    .map(([k]) => k)
    .sort();
}

/** Outcomes withheld in a one-sided slice: anything shipped, since a delivery would never be reported. */
const WITHHELD = ["delivered", "returned", "partially_delivered", "in_transit"];

export function withholdOneSided(
  rows: readonly RollupOrder[],
  slices: readonly string[],
): { rows: RollupOrder[]; withheld: { orders: number; returned: number; inTransit: number } } {
  if (!slices.length) return { rows: [...rows], withheld: { orders: 0, returned: 0, inTransit: 0 } };
  let orders = 0;
  let returned = 0;
  let inTransit = 0;
  const out = rows.map((o) => {
    if (o.parcelCount > 0 || !WITHHELD.includes(o.outcome) || !slices.includes(byCourier(o)[0]!)) return o;
    orders += 1;
    if (o.outcome === "returned") returned += 1;
    if (o.outcome === "in_transit") inTransit += 1;
    return { ...o, outcome: "unknown" as const, delivered: null, outcomeTiming: null };
  });
  return { rows: out, withheld: { orders, returned, inTransit } };
}

/** Couriers with at least one settlement recorded in Courierify, ever. */
export function trackedPayers(payers: readonly string[]): Set<string> {
  return new Set(payers.map((p) => p.toLowerCase()));
}
