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

import type { Money } from "./money";

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

// ── Statements: what a courier deducted (Phase 4c, A4) ─────────────────────

/** One courier settlement with its deductions, as Courierify sends it. */
export type Statement = {
  payer: string;
  day: string;
  status: string;
  /** courier_api | csv_import | manual */
  source: string;
  shipments: number;
  returned: number;
  totalCod: Money | null;
  codFees: Money | null;
  deliveryFees: Money | null;
  /** Null where the courier bills returns inside delivery fees. */
  reversalFees: Money | null;
  withholdingTax: Money | null;
  miscDeduction: Money | null;
  carryForward: Money | null;
  netPaid: Money | null;
};

const asMoney = (v: unknown): Money | null => {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  return typeof m.amount === "string" && typeof m.currency === "string" ? { amount: m.amount, currency: m.currency } : null;
};

/** A settlement row with its money, or null if it is not a payout we can date. */
export function readStatement(payload: Record<string, unknown>): Statement | null {
  const p = readPayout(payload);
  if (!p) return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    ...p,
    source: text(payload.source) ?? "unknown",
    shipments: count(payload.shipmentsCount),
    returned: count(payload.returnedCount),
    totalCod: asMoney(payload.totalCod),
    codFees: asMoney(payload.codFees),
    deliveryFees: asMoney(payload.deliveryFees),
    reversalFees: asMoney(payload.reversalFees),
    withholdingTax: asMoney(payload.withholdingTax),
    miscDeduction: asMoney(payload.miscDeduction),
    carryForward: asMoney(payload.carryForward),
    netPaid: asMoney(payload.netPaid),
  };
}
