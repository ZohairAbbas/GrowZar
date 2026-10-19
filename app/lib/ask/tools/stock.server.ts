import { z } from "zod";

import { STOCK_STATES } from "../../metrics/inventory";
import { inventorySection } from "../../metrics/inventory.server";
import { parseAmount } from "../../metrics/money";
import { NO_SCOPE } from "../../metrics/scope";
import { productProfit } from "../../metrics/screens.server";
import { loadSettledHistory } from "../../metrics/summaries.server";
import { toMajor } from "../engine";
import { memo, summaryFor } from "../load.server";
import { periodArg, periodOf, resolvePeriod } from "../period.server";
import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { FORBIDDEN_STORE, limitArg, oneStoreArg, pickOneStore, refusal, screenLink } from "./common.server";

/**
 * The Inventory section's stock table (Inventorify): stock, cover,
 * stock-outs, slow movers and what to reorder, per variant, with its profit
 * for a viewer who may see Finance.
 */

export const stockSchema = z
  .object({
    store: oneStoreArg,
    state: z.enum(STOCK_STATES).nullable().describe("Only variants in this state: out, reorder (runs out within its lead time), on_order, ok, slow (no sale in 30 days), untracked, not_selling (none in 90). Null for all."),
    search: z.string().nullable().describe("Only variants whose title or SKU contains this text."),
    sort: z.enum(["days_of_cover", "sold", "stock", "profit"]).nullable().describe("Order: days_of_cover (fewest first, default), sold (most first), stock (most first), profit (most first)."),
    period: periodArg.nullable().describe("The sales period. Null for the last 30 days."),
    limit: limitArg,
  })
  .strict();

export async function runStock(args: z.infer<typeof stockSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "stock";
  const store = pickOneStore(ctx, args.store);
  if (store === "ambiguous") return refusal(name, "invalid", "Which store? Stock is per store; call list_stores for the ids.");
  if (!store) return refusal(name, "forbidden", FORBIDDEN_STORE);
  const period = resolvePeriod(args.period, store.timezone, ctx.now);
  if ("error" in period) return refusal(name, "invalid", period.error);
  const money = ctx.can("finance");
  if (args.sort === "profit" && !money) return refusal(name, "forbidden", "Money figures need access to Finance, which your role does not have. Counts and rates are available.");

  const s = await summaryFor(ctx, store.id, period, NO_SCOPE);
  const [history, profit] = await Promise.all([
    memo(ctx, `settled:${store.id}:${period.today}`, () => loadSettledHistory(store.id, period.today)),
    money ? memo(ctx, `product-profit:${store.id}:${period.from}:${period.to}`, () => productProfit(store.id, s)) : null,
  ]);
  const view = await inventorySection(store.id, period, s.store.currency, 100_000, args.state, { history, profit });
  if (!view.variants) return { ...refusal(name, "no_data", "No stock data: Inventorify is not connected for this store, or has sent no variants yet."), link: { href: screenLink("inventory", store, period.query), label: "Open Inventory", exact: true } };

  const needle = args.search?.trim().toLowerCase();
  let list = needle ? view.rows.filter((r) => `${r.title} ${r.variantTitle ?? ""} ${r.sku ?? ""}`.toLowerCase().includes(needle)) : view.rows;
  const sort = args.sort ?? "days_of_cover";
  const num = (v: number | null) => v ?? Number.POSITIVE_INFINITY;
  list = [...list].sort((a, b) =>
    sort === "sold"
      ? b.soldInPeriod - a.soldInPeriod
      : sort === "stock"
        ? b.stock - a.stock
        : sort === "profit"
          ? Number(b.profit?.amount ?? -Infinity) - Number(a.profit?.amount ?? -Infinity)
          : num(a.daysOfCover) - num(b.daysOfCover) || b.perDay - a.perDay,
  );
  const limit = Math.min(args.limit ?? 10, 50);
  const shown = list.slice(0, limit);
  const rows: Array<Record<string, Cell>> = shown.map((r) => ({
    key: r.variantId,
    label: r.variantTitle && r.variantTitle !== "Default Title" ? `${r.title} — ${r.variantTitle}` : r.title,
    sku: r.sku,
    state: r.state.replace("_", " "),
    stock: r.stock,
    sold: r.soldInPeriod,
    per_day: Math.round(r.perDay * 10) / 10,
    days_of_cover: r.daysOfCover,
    net_days_of_cover: r.netDaysOfCover,
    on_order: r.onOrder,
    reorder_units: r.reorderUnits,
    delivery_rate: r.deliveryRate,
    ...(money ? { profit: r.profit ? toMajor(parseAmount(r.profit.amount)!) : null } : {}),
  }));
  const columns: Column[] = [
    { key: "key", label: "Variant id", kind: "text" },
    { key: "label", label: "Product", kind: "text" },
    { key: "sku", label: "SKU", kind: "text" },
    { key: "state", label: "State", kind: "text" },
    { key: "stock", label: "In stock", kind: "count" },
    { key: "sold", label: "Sold in period", kind: "count" },
    { key: "per_day", label: "Sold per day (last 30 days)", kind: "number" },
    { key: "days_of_cover", label: "Days of cover", kind: "days" },
    { key: "net_days_of_cover", label: "Days of cover after returns", kind: "days" },
    { key: "on_order", label: "On order", kind: "count" },
    { key: "reorder_units", label: "Reorder now (units)", kind: "count" },
    { key: "delivery_rate", label: "Delivery rate", kind: "percent" },
    ...(money && s.store.currency ? ([{ key: "profit", label: "Profit in period", kind: "money", currency: s.store.currency }] satisfies Column[]) : []),
  ];
  return {
    tool: name,
    status: shown.length ? "ok" : "no_data",
    title: args.state ? `Variants in state "${args.state.replace("_", " ")}"` : "Stock by variant",
    columns,
    rows,
    meta: {
      period: periodOf(period),
      stores: [{ id: store.id, name: store.name }],
      currency: money ? s.store.currency : undefined,
      rules: [
        "Days of cover = stock ÷ units sold per day over the last 30 full days; none when nothing sold.",
        "After returns: the daily rate times the variant's delivery rate, since returned parcels come back on the shelf.",
        "Reorder now = units to last the lead time plus 30 days, less stock and units on order, only for a variant that is out or runs out within its lead time.",
        ...(money ? ["Profit in period is Finance's product tab, to the cent."] : []),
      ],
      gaps: view.untracked ? [`${view.untracked} selling variant(s) have stock counts that are not the real shelf`] : [],
      notes: [
        `${view.variants} variants, ${view.selling} selling; ${view.outNow} out of stock, ${view.reorderNow} to reorder now`,
        ...(view.reordersInInventorify ? [] : ["The store does not reorder through Inventorify, so \"nothing on order\" may not mean nothing is coming"]),
      ],
      ...(list.length > shown.length ? { truncated: { shown: shown.length, total: list.length } } : {}),
    },
    link: { href: screenLink("inventory", store, period.query, { stock: args.state }), label: "Open Inventory", exact: !needle && sort === "days_of_cover" },
  };
}

export const stock: AskTool<typeof stockSchema> = {
  name: "stock",
  description: "Stock per variant for one store from Inventorify: in stock, sold, days of cover, stock-outs, slow movers, what to reorder now, and (with Finance access) profit. Filter by state or search a title.",
  schema: stockSchema,
  sections: (args) => (args.sort === "profit" ? ["inventory", "finance"] : ["inventory"]),
  run: runStock,
};
