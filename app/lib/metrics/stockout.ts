import { PO_USE_DAYS, PO_USE_MIN, type InventoryView } from "./inventory";
import { productLines, type RollupOrder } from "./rollups";

/**
 * I3, a stock-out that costs real sales (Phase 5, G-GZR5-4).
 *
 * A selling variant whose stock runs out before a reorder placed today could
 * arrive, with nothing on order in Inventorify; or one that has just run out.
 * Everything comes from the Inventory section's own figures, so the card and
 * the table never disagree.
 *
 * "Just ran out" is a fact and shows for every store. "Will run out" is a
 * forecast, and shows only for a store that reorders through Inventorify
 * (`reordersInInventorify`): elsewhere "nothing on order" is not "nothing on
 * the way", and on 0dscam-qn, which restocks outside it, the forecast flagged
 * 11 variant-days in 60 and none ran out. No money yet: an estimate of lost profit waits for
 * a backtest (PLAN.md §3), as with every other detector.
 */

/** Units a day over the last 30 full days below which a stock-out is noise. */
export const MIN_PER_DAY = 0.5;
/** Cards at most: the most units short first. */
export const MAX_STOCKOUTS = 3;

export type StockoutFinding = {
  kind: "stockout";
  variantId: string;
  title: string;
  variantTitle: string | null;
  situation: "runs_out" | "out";
  stock: number;
  perDay: number;
  /** Whole days the stock lasts; 0 when already out. */
  daysOfCover: number;
  leadTimeDays: number;
  leadSource: "measured" | "setting";
  /** Days with nothing to sell if it is reordered today: lead time less cover. */
  shortDays: number;
  /** Demand in those days at the current rate, rounded up. */
  unitsShort: number;
  /** Its share of units ordered in the period (Financify lines), when there are any. */
  orderedShare: number | null;
  periodDays: number;
};

type Skip = { kind: "skip"; status: "not_enough_data" | "nothing_found"; reason: string };

export function stockoutFindings(input: {
  inventory?: InventoryView | null;
  rows: readonly RollupOrder[];
  /** The period the rows cover, for the share's wording. */
  period?: { from: string; to: string };
}): StockoutFinding[] | Skip {
  const periodDays = input.period ? Math.round((Date.parse(input.period.to) - Date.parse(input.period.from)) / 86_400_000) + 1 : 0;
  const inv = input.inventory;
  if (!inv || inv.variants === 0) {
    return { kind: "skip", status: "not_enough_data", reason: "Inventorify has not sent stock for this store yet" };
  }

  const lines = productLines(input.rows);
  const totalUnits = lines.reduce((n, l) => n + l.units, 0);
  const unitsOf = new Map(lines.map((l) => [l.variantId, l.units]));

  const found = inv.rows.flatMap((r): StockoutFinding[] => {
    if (r.state !== "out" && !(r.state === "reorder" && inv.reordersInInventorify)) return [];
    if (r.perDay < MIN_PER_DAY || r.leadTimeDays === null || r.leadSource === null || r.daysOfCover === null) return [];
    const shortDays = Math.max(0, r.leadTimeDays - r.daysOfCover);
    if (shortDays === 0) return [];
    const ordered = unitsOf.get(r.variantId) ?? 0;
    return [
      {
        kind: "stockout",
        variantId: r.variantId,
        title: r.title,
        variantTitle: r.variantTitle,
        situation: r.state === "out" ? "out" : "runs_out",
        stock: r.stock,
        perDay: r.perDay,
        daysOfCover: r.daysOfCover,
        leadTimeDays: r.leadTimeDays,
        leadSource: r.leadSource,
        shortDays,
        unitsShort: Math.ceil(r.perDay * shortDays),
        orderedShare: totalUnits > 0 && ordered > 0 ? Math.round((1000 * ordered) / totalUnits) / 10 : null,
        periodDays,
      },
    ];
  });

  if (!found.length) {
    return {
      kind: "skip",
      status: "nothing_found",
      reason: inv.reordersInInventorify
        ? `No product selling ${MIN_PER_DAY} or more a day runs out before a reorder could arrive`
        : `No product selling ${MIN_PER_DAY} or more a day is out of stock. Running-out forecasts start once the store receives ${PO_USE_MIN} purchase orders through Inventorify in ${PO_USE_DAYS} days (${inv.receivedOrders} so far)`,
    };
  }
  return found.sort((a, b) => b.unitsShort - a.unitsShort || a.variantId.localeCompare(b.variantId)).slice(0, MAX_STOCKOUTS);
}
