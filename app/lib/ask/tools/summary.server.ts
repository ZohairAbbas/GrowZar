import { z } from "zod";

import { convertDated } from "../../metrics/fx";
import { loadFxSource } from "../../metrics/fx.server";
import { parseAmount, type Money } from "../../metrics/money";
import { MIN_DECIDED_TO_RATE } from "../../metrics/compare";
import { NO_SCOPE } from "../../metrics/scope";
import type { StoreSummary } from "../../metrics/summaries.server";
import { memo, summaryFor } from "../load.server";
import { toMajor } from "../engine";
import { periodArg, periodOf, resolvePeriod, type AskPeriod } from "../period.server";
import type { AskTool, Cell, Column, ToolResult } from "../types";
import { CURRENCY_RULE, FORBIDDEN_STORE, gapsFor, pickStores, refusal, screenLink, storeArg } from "./common.server";

/**
 * The headline figures Home shows, for one store or every store the viewer
 * sees, with an "All stores" row. One store's money is in its own currency;
 * several stores' money is in the organization's base currency at each
 * order day's rate (rule #4, as Compare does it), and a figure that cannot be
 * converted is left empty and said, never added at 1.
 */

export const summarySchema = z.object({ store: storeArg, period: periodArg.nullable() }).strict();

const SHIPPED = ["delivered", "returned", "partially_delivered", "in_transit"];

const COUNT_COLUMNS: Column[] = [
  { key: "orders", label: "Orders", kind: "count" },
  { key: "confirmed", label: "Confirmed", kind: "count" },
  { key: "shipped", label: "Shipped", kind: "count" },
  { key: "delivered", label: "Delivered", kind: "count" },
  { key: "returned", label: "Returned", kind: "count" },
  { key: "still_open", label: "Still open", kind: "count" },
  { key: "delivery_rate", label: "Delivery rate", kind: "percent" },
  { key: "decided", label: "Decided orders", kind: "count" },
  { key: "paid_by_courier", label: "Paid by courier", kind: "count" },
];

function counts(s: StoreSummary): Record<string, Cell> {
  const rows = s.rows;
  const r = s.orders.deliveryRate;
  const decided = r.delivered + r.returned;
  return {
    orders: rows.length,
    confirmed: rows.some((o) => o.confirmation) ? rows.filter((o) => o.confirmation === "confirmed").length : null,
    shipped: rows.filter((o) => SHIPPED.includes(o.outcome)).length,
    delivered: r.delivered,
    returned: r.returned,
    still_open: r.stillOpen,
    delivery_rate: decided >= MIN_DECIDED_TO_RATE ? Math.round((1000 * r.delivered) / decided) / 10 : null,
    decided,
    paid_by_courier: rows.filter((o) => o.collected).length,
  };
}

const pick = (list: Money[], currency: string | null) => {
  const m = currency ? list.find((x) => x.currency === currency) : undefined;
  return m ? toMajor(parseAmount(m.amount)!) : currency ? 0 : null;
};

export async function runSummary(args: z.infer<typeof summarySchema>, ctx: Parameters<AskTool["run"]>[1]): Promise<ToolResult> {
  const name = "summary";
  const stores = pickStores(ctx, args.store);
  if (!stores) return refusal(name, "forbidden", FORBIDDEN_STORE);
  if (!stores.length) return refusal(name, "no_data", "No stores are connected to this organization yet.");
  const money = ctx.can("finance");
  const periods: AskPeriod[] = [];
  for (const s of stores) {
    const p = resolvePeriod(args.period, s.timezone, ctx.now);
    if ("error" in p) return refusal(name, "invalid", p.error);
    periods.push(p);
  }
  const summaries = await Promise.all(stores.map((s, i) => summaryFor(ctx, s.id, periods[i]!, NO_SCOPE)));
  const single = stores.length === 1;
  const base = single ? summaries[0]!.store.currency : ctx.baseCurrency;
  const gaps: string[] = [];
  const notes: string[] = [];

  const rows: Array<Record<string, Cell>> = [];
  const totals = { placed: 0n, delivered: 0n, profit: 0n, ads: 0n };
  const complete = { placed: true, delivered: true, profit: true, ads: true };
  for (const [i, s] of summaries.entries()) {
    const store = stores[i]!;
    const row: Record<string, Cell> = { key: store.id, label: store.name, ...counts(s) };
    if (money) {
      const cur = s.store.currency;
      if (single || cur === base) {
        row.placed_revenue = pick(s.orders.placed, cur);
        row.delivered_revenue = pick(s.orders.deliveredRevenue, cur);
        row.profit = s.profit ? toMajor(parseAmount(s.profit.amount)!) : null;
        row.ad_spend = s.profit?.parts.adSpend != null ? toMajor(parseAmount(s.profit.parts.adSpend)!) : null;
      } else {
        // Another currency: converted at each order day's rate (rule #4).
        const fx = await memo(ctx, `fx:${store.id}:${s.period.from}:${s.period.to}:${base}`, () => loadFxSource(base!, s.rows));
        const dated = (f: (o: StoreSummary["rows"][number]) => Money | null) =>
          s.rows.flatMap((o) => {
            const m = f(o);
            return m && o.localDay ? [{ day: o.localDay, money: m }] : [];
          });
        const placed = convertDated(dated((o) => o.placed), base!, fx.source);
        const delivered = convertDated(dated((o) => (o.outcome === "delivered" ? o.delivered : null)), base!, fx.source);
        row.placed_revenue = placed.complete ? toMajor(parseAmount(placed.total.amount)!) : null;
        row.delivered_revenue = delivered.complete ? toMajor(parseAmount(delivered.total.amount)!) : null;
        row.profit = null;
        row.ad_spend = null;
        if (!placed.complete || !delivered.complete) notes.push(`${store.name}: some ${cur} orders have no ${cur}→${base} rate for their day, so its revenue is not converted`);
        else notes.push(`${store.name}: revenue converted from ${cur} to ${base} at ${placed.ratesUsed.length + delivered.ratesUsed.length} daily rate(s) (${placed.source})`);
        notes.push(`${store.name}: profit is in ${cur} and not converted; ask about this store alone for it`);
      }
      row.roas = s.roas === null ? null : Math.round(s.roas * 100) / 100;
      for (const [k, f] of [["placed", "placed_revenue"], ["delivered", "delivered_revenue"], ["profit", "profit"], ["ads", "ad_spend"]] as const) {
        const v = row[f];
        if (typeof v === "number") totals[k] += parseAmount(v.toFixed(2))!;
        else complete[k] = false;
      }
      for (const m of s.profit?.missing ?? []) gaps.push(single ? m : `${store.name}: ${m}`);
      if (s.adSpend && s.adSpend.dateBasis === "ad_platform_day") notes.push(`${single ? "" : `${store.name}: `}ad spend is by the ad platform's days, not the shop's`);
    }
    for (const g of await gapsFor(ctx, s, "home")) gaps.push(single ? g : `${store.name}: ${g}`);
    rows.push(row);
  }

  if (!single) {
    const sum = (k: string) => rows.reduce((a, r) => a + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
    const delivered = sum("delivered");
    const decided = sum("decided");
    const total: Record<string, Cell> = {
      key: "all",
      label: "All stores",
      orders: sum("orders"),
      confirmed: rows.some((r) => r.confirmed !== null) ? sum("confirmed") : null,
      shipped: sum("shipped"),
      delivered,
      returned: sum("returned"),
      still_open: sum("still_open"),
      delivery_rate: decided >= MIN_DECIDED_TO_RATE ? Math.round((1000 * delivered) / decided) / 10 : null,
      decided,
      paid_by_courier: sum("paid_by_courier"),
    };
    if (money) {
      total.placed_revenue = complete.placed ? toMajor(totals.placed) : null;
      total.delivered_revenue = complete.delivered ? toMajor(totals.delivered) : null;
      total.profit = complete.profit ? toMajor(totals.profit) : null;
      total.ad_spend = complete.ads ? toMajor(totals.ads) : null;
      total.roas = null;
      if (!complete.profit) notes.push("No all-stores profit: not every store's profit is known in the base currency");
    }
    rows.push(total);
  }

  const columns: Column[] = [
    { key: "key", label: "Store id", kind: "text" },
    { key: "label", label: "Store", kind: "text" },
    ...COUNT_COLUMNS,
    ...(money && base
      ? ([
          { key: "placed_revenue", label: "Placed revenue", kind: "money", currency: base },
          { key: "delivered_revenue", label: "Delivered revenue", kind: "money", currency: base },
          { key: "profit", label: "Profit after returns", kind: "money", currency: base },
          { key: "ad_spend", label: "Ad spend (with platform fees)", kind: "money", currency: base },
          { key: "roas", label: "ROAS", kind: "number", money: true },
        ] satisfies Column[])
      : []),
  ];
  const period = periods[0]!;
  return {
    tool: name,
    status: rows.some((r) => (r.orders as number) > 0) ? "ok" : "no_data",
    title: single ? `${stores[0]!.name}: the period's headline figures` : "Headline figures by store",
    columns,
    rows,
    meta: {
      period: periodOf(period),
      stores: stores.map(({ id, name }) => ({ id, name })),
      currency: money ? base : undefined,
      rules: [
        `Delivery rate = delivered ÷ (delivered + returned), by order; no rate under ${MIN_DECIDED_TO_RATE} decided orders (rule #8).`,
        "Placed, delivered and collected revenue are never added together (rule #2).",
        ...(money ? ["Profit after returns = delivered revenue − product cost − courier fees − ad spend − other costs.", "ROAS = delivered revenue ÷ ad spend with platform fees (rule #16)."] : []),
        ...(!single && money ? [CURRENCY_RULE] : []),
      ],
      gaps: [...new Set(gaps)],
      notes: [...new Set(notes)],
    },
    link: single
      ? { href: screenLink("home", stores[0]!, period.query), label: "Open Home", exact: true }
      : { href: screenLink("compare", null, period.query), label: "Compare stores", exact: false },
  };
}

export const summary: AskTool<typeof summarySchema> = {
  name: "summary",
  description:
    "Headline figures for a period: orders, confirmed, shipped, delivered, returned, still open, delivery rate, and (with Finance access) placed and delivered revenue, profit after returns, ad spend and ROAS. One store, or every store with an all-stores row. Use compare_periods for changes.",
  schema: summarySchema,
  sections: () => ["home"],
  run: runSummary,
};
