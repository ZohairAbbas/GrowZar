/**
 * The simulator's data gate (G-GZR11-5, P11-2, P11-5, P11-7). Pure.
 *
 * A store that fails any check is refused, with what to fix and where. No
 * half-plans, no wide-range guesses. Payout timing is not a refusal of the
 * store (P11-5): a payer without a measured cycle needs the merchant's own
 * lag, asked for in the form.
 */

import type { Fix, SimData, SimRequest } from "./types";

export const GATE = {
  historyDays: 60,
  adFetchedShare: 0.9,
  productCostShare: 0.8,
  attributedShare: 0.6,
} as const;
/** A payer carrying less COD than this share does not hold a plan up. */
export const MIN_PAYER_SHARE = 0.05;

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function gateFixes(data: SimData, req: Pick<SimRequest, "payoutLags">): Fix[] {
  const g = data.gate;
  const fixes: Fix[] = [];
  if (g.historyDays < GATE.historyDays)
    fixes.push({ check: "history", detail: `The store has ${g.historyDays} days of orders; a plan needs ${GATE.historyDays}. Come back in ${GATE.historyDays - g.historyDays} days.`, action: null });
  const adShare = g.adDaysWindow ? g.adDaysFetched / g.adDaysWindow : 0;
  if (adShare < GATE.adFetchedShare)
    fixes.push({
      check: "ad_spend",
      detail: `Ad spend reached Growzar for ${g.adDaysFetched} of the last ${g.adDaysWindow} days (${pct(adShare)}); a plan needs ${pct(GATE.adFetchedShare)}. Check your ad accounts are connected in Financify.`,
      action: g.links.adAccounts,
    });
  const costShare = g.deliveredOrders ? g.deliveredWithCost / g.deliveredOrders : 0;
  if (costShare < GATE.productCostShare) {
    const n = g.productsMissingCost.length;
    const named = g.productsMissingCost.slice(0, 5).join(", ");
    fixes.push({
      check: "product_cost",
      detail: `Product cost is known on ${pct(costShare)} of delivered orders in the last 90 days; a plan needs ${pct(GATE.productCostShare)}. Add product costs for ${n === 1 ? "this product" : `these ${n} products`} in Financify${named ? `: ${named}${n > 5 ? ` and ${n - 5} more` : ""}` : ""}.`,
      action: g.links.costs,
    });
  }
  const attributed = g.orders ? g.attributedOrders / g.orders : 0;
  if (attributed < GATE.attributedShare)
    fixes.push({
      check: "attribution",
      detail: `${pct(attributed)} of the last 90 days' orders are credited to a campaign; a plan needs ${pct(GATE.attributedShare)}. Connect every ad account in Financify and keep UTM tags on your ads.`,
      action: g.links.adAccounts,
    });
  if (!data.deliveryDays)
    fixes.push({ check: "delivery_times", detail: "No courier-timed deliveries to learn how long orders take. Connect Courierify.", action: g.links.courierify });
  for (const p of data.payers) {
    if (p.basis !== "unknown" || p.share < MIN_PAYER_SHARE || req.payoutLags[p.payer] !== undefined) continue;
    fixes.push({
      check: "payout_lag",
      detail: `How many days does ${p.payer} take to pay you after delivery? Growzar can't measure it: ${p.reason ?? "no settlement recorded"}. It carries ${pct(p.share)} of your COD.`,
      action: null,
      payer: p.payer,
    });
  }
  return fixes;
}
