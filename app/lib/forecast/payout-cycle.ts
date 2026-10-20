/**
 * How long each payer takes to pay a delivered parcel's COD (G-GZR11-1,
 * pack §5.1). Pure.
 *
 * Measured per parcel, from delivered to settled, using Courierify's
 * settlement mark on the parcel. I4's payer history measures something else
 * (the gap between one payout and the next) and is not used here.
 *
 * Only parcels delivered at least MATURE_DAYS before `asOf` are read, so a
 * parcel delivered last week and not yet paid does not pull the figure down.
 * If many of those mature parcels are still unpaid, the settled ones are not
 * a fair sample (on 0dscam-qn, Orio statements stopped being uploaded after
 * August), and the payer's cycle is not measured. A payer without a measured
 * cycle takes the merchant's own payout lag, labelled as their estimate
 * (pack §10, P11-5).
 */

import { DAY_MS, daysBetween, quantile } from "./stats";

/** About twice the slowest measured payer's 90th percentile (TCS 10 days, Orio 12, on 0dscam-qn). */
export const MATURE_DAYS = 21;
export const PAYOUT_WINDOW_DAYS = 180;
export const MIN_SETTLED = 30;
/** Above this share of mature parcels still unpaid, the settled ones are not a fair sample. */
export const MAX_UNSETTLED_SHARE = 0.2;

export type PaidParcel = {
  /** Who pays the COD: the 3PL that booked it, else the courier (I4's `payerOf`), lower-cased. */
  payer: string;
  deliveredAt: Date;
  settledAt: Date | null;
};

export type PayoutCycle = {
  payer: string;
  /** Delivered parcels old enough to judge. */
  mature: number;
  /** Of those, paid by `asOf`. */
  settled: number;
  unsettledShare: number;
  /** Days from delivered to paid, ascending (settled mature parcels). */
  lags: number[];
  median: number | null;
  low: number | null;
  high: number | null;
  measured: boolean;
  /** Why it is not measured, in words a merchant can act on. */
  reason: string | null;
};

export function payoutCycles(parcels: readonly PaidParcel[], asOf: Date): Map<string, PayoutCycle> {
  const to = asOf.getTime() - MATURE_DAYS * DAY_MS;
  const from = asOf.getTime() - PAYOUT_WINDOW_DAYS * DAY_MS;
  const byPayer = new Map<string, PaidParcel[]>();
  for (const p of parcels) {
    const t = p.deliveredAt.getTime();
    if (t < from || t > to) continue;
    byPayer.set(p.payer, [...(byPayer.get(p.payer) ?? []), p]);
  }
  const out = new Map<string, PayoutCycle>();
  for (const [payer, list] of byPayer) {
    const paid = list.filter((p) => p.settledAt && p.settledAt <= asOf);
    const lags = paid.map((p) => Math.max(0, daysBetween(p.deliveredAt, p.settledAt!))).sort((a, b) => a - b);
    const unsettledShare = 1 - paid.length / list.length;
    const reason =
      paid.length === 0
        ? "no settlement has been recorded for its parcels"
        : paid.length < MIN_SETTLED
          ? `only ${paid.length} paid parcels to measure from (${MIN_SETTLED} needed)`
          : unsettledShare > MAX_UNSETTLED_SHARE
            ? `${Math.round(unsettledShare * 100)}% of its parcels delivered over ${MATURE_DAYS} days ago show no payment`
            : null;
    out.set(payer, {
      payer,
      mature: list.length,
      settled: paid.length,
      unsettledShare,
      lags,
      median: quantile(lags, 0.5),
      low: quantile(lags, 0.1),
      high: quantile(lags, 0.9),
      measured: reason === null,
      reason,
    });
  }
  return out;
}
