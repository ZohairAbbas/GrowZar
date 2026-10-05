/**
 * Courier settlements as payout history (G-GZR3-5, I4). Pure.
 *
 * I4 judges "late" against each payer's own rhythm on this store (PLAN.md
 * §4: "each shop × courier's own median settlement gap"), so it needs, per
 * payer, the days it actually paid. Only `received` payouts count: on
 * 0dscam-qn TCS's three `disputed` statements are monthly statements whose
 * delivered parcels were mostly paid in the weekly payouts beside them, so
 * summing their net amounts as "owed" would invent 1.63M PKR.
 */

export type Payout = { payer: string; day: string; status: string };

export type PayerHistory = {
  payer: string;
  /** Received payouts on distinct days. */
  payouts: number;
  lastPaidDay: string | null;
  /** Median days between consecutive payout days; null below MIN_PAYOUTS_FOR_CYCLE. */
  medianGapDays: number | null;
  /** Statements Courierify marks disputed and never received (said, not summed). */
  disputed: number;
};

/** Payout days needed to know a payer's rhythm (two gaps). */
export const MIN_PAYOUTS_FOR_CYCLE = 3;

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One settlement row from Courierify's feed, or null if it is not a payout we can date. */
export function readPayout(payload: Record<string, unknown>): Payout | null {
  const payer = text(payload.courier)?.toLowerCase();
  const date = text(payload.settlementDate);
  const status = text(payload.status) ?? "unknown";
  if (!payer || !date || (payload.direction !== undefined && payload.direction !== "payout")) return null;
  return { payer, day: date.slice(0, 10), status };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function payerHistories(payouts: readonly Payout[]): PayerHistory[] {
  const by = new Map<string, Payout[]>();
  for (const p of payouts) by.set(p.payer, [...(by.get(p.payer) ?? []), p]);
  return [...by.entries()]
    .map(([payer, list]) => {
      const days = [...new Set(list.filter((p) => p.status === "received").map((p) => p.day))].sort();
      const gaps = days.slice(1).map((d, i) => daysBetween(days[i]!, d)).sort((a, b) => a - b);
      const mid = Math.floor(gaps.length / 2);
      const median = gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
      return {
        payer,
        payouts: days.length,
        lastPaidDay: days.at(-1) ?? null,
        medianGapDays: days.length >= MIN_PAYOUTS_FOR_CYCLE ? median : null,
        disputed: list.filter((p) => p.status === "disputed").length,
      };
    })
    .sort((a, b) => a.payer.localeCompare(b.payer));
}
