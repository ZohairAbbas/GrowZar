import { z } from "zod";

import {
  breakdownTable,
  DIMENSIONS,
  DIMENSION_LABELS,
  mergeRaws,
  METRICS,
  METRIC_DEFS,
  rawGroups,
  TIME_DIMS,
  unsupported,
  type Dimension,
  type Metric,
  type Raw,
} from "../engine";
import { prisma } from "../../db.server";
import { memo, sliceFor, summaryFor } from "../load.server";
import { periodArg, periodOf, resolvePeriod, type AskPeriod } from "../period.server";
import type { AskContext, AskStore, AskTool, ToolResult } from "../types";
import type { Section } from "../../permissions";
import {
  CURRENCY_RULE,
  FORBIDDEN_STORE,
  filtersArg,
  gapsFor,
  limitArg,
  pickStores,
  refusal,
  scopeOf,
  screenLink,
  storeArg,
} from "./common.server";

/**
 * Any metric by any dimension (agreed 2026-10-19): "which products lost
 * money", "delivery rate by city", "repeat orders by week". The numbers are
 * the engine's, which reads the screens' own roll-ups and profit tables.
 */

export const breakdownSchema = z
  .object({
    store: storeArg,
    metrics: z.array(z.enum(METRICS)).min(1).max(4).describe("1–4 metrics; rows are ranked by the first."),
    by: z.enum(DIMENSIONS).describe('What to group by. "none" for one total row.'),
    period: periodArg.nullable(),
    filters: filtersArg,
    variant: z.string().nullable().describe("Only orders containing this variant id (from a previous result's key). Counts and rates only."),
    order: z.enum(["top", "bottom"]).nullable().describe("top: highest first (default); bottom: lowest first. Time dimensions are always in date order."),
    limit: limitArg,
  })
  .strict();

type Args = z.infer<typeof breakdownSchema>;

const MONEY_SECTIONS: Section[] = ["finance"];

/** The store's first order day: a comparison never reaches back before it. */
const firstDay = (ctx: AskContext, storeId: string) =>
  memo(ctx, `first-day:${storeId}`, async () => (await prisma.orderGrain.aggregate({ where: { storeId }, _min: { localDay: true } }))._min.localDay);

/** Where the same view is on a screen, if anywhere; `exact` when the screen shows these figures for these rows. */
const FINANCE_TAB = new Set<Metric>(["orders", "delivered", "returned", "return_rate", "delivered_revenue", "product_cost", "courier_fees", "other_costs", "ad_spend", "profit", "margin"]);
const SHIPPING_TABLE = new Set<Metric>(["orders", "delivered", "returned", "still_open", "delivery_rate"]);
const HOME = new Set<Metric>(["orders", "delivered", "returned", "delivery_rate", "still_open"]);
const FINANCE_TOTAL = new Set<Metric>(["placed_revenue", "delivered_revenue", "collected", "refunded", "courier_fees", "product_cost", "other_costs", "ad_spend", "profit"]);

function screenFor(by: Dimension, metrics: readonly Metric[]): { section: Section; exact: boolean } {
  const all = (set: ReadonlySet<Metric>) => metrics.every((m) => set.has(m));
  switch (by) {
    case "none":
      if (all(HOME)) return { section: "home", exact: true };
      if (all(FINANCE_TOTAL)) return { section: "finance", exact: true };
      return { section: metrics.some((m) => METRIC_DEFS[m].money) ? "finance" : "home", exact: false };
    case "city":
    case "courier":
      if (all(SHIPPING_TABLE)) return { section: "shipping", exact: true };
      if (all(FINANCE_TAB)) return { section: "finance", exact: true };
      return { section: metrics.some((m) => METRIC_DEFS[m].money) ? "finance" : "shipping", exact: false };
    case "variant":
    case "campaign":
      if (all(FINANCE_TAB)) return { section: "finance", exact: true };
      return { section: by === "campaign" ? "marketing" : "inventory", exact: false };
    case "channel":
      return { section: "shipping", exact: all(new Set<Metric>(["orders", "delivery_rate"])) };
    case "week":
      return { section: "shipping", exact: all(new Set<Metric>(["delivery_rate"])) };
    case "buyer_type":
      return { section: "customers", exact: false };
    default:
      return { section: metrics.some((m) => METRIC_DEFS[m].money) ? "finance" : "home", exact: false };
  }
}

/** What `loadGroups` needs: the breakdown's arguments less the presentation. */
export type GroupArgs = Pick<Args, "store" | "metrics" | "by" | "filters" | "variant">;

export type Loaded = {
  stores: AskStore[];
  periods: AskPeriod[];
  metrics: Metric[];
  anyMoney: boolean;
  merged: Map<string, Raw>;
  labels: Record<string, string>;
  gaps: string[];
  notes: string[];
  currency: string | null;
  orders: number;
  /** Each store's first order day, for comparisons that reach back before it. */
  historyFrom: Array<string | null>;
};

/**
 * Every store's groups for the period, added up. A refusal when the stores,
 * metrics, dimension or currencies make no answer. `periodFor` resolves the
 * period per store (each store's own days and timezone).
 */
export async function loadGroups(
  name: string,
  args: GroupArgs,
  ctx: AskContext,
  periodFor: (store: AskStore) => AskPeriod | { error: string },
): Promise<Loaded | ToolResult> {
  const stores = pickStores(ctx, args.store);
  if (!stores) return refusal(name, "forbidden", FORBIDDEN_STORE);
  if (!stores.length) return refusal(name, "no_data", "No stores are connected to this organization yet.");
  const metrics = [...new Set(args.metrics)];
  for (const m of metrics) {
    const why = unsupported(m, args.by);
    if (why) return refusal(name, "invalid", `Can't break ${METRIC_DEFS[m].label.toLowerCase()} down by ${DIMENSION_LABELS[args.by].toLowerCase()}: ${why}.`);
  }
  const anyMoney = metrics.some((m) => METRIC_DEFS[m].money);
  if (args.variant && anyMoney) {
    return refusal(name, "invalid", "With a variant filter only counts and rates are possible: an order's money is not the variant's. Break down by variant instead to get each variant's share.");
  }

  const periods: AskPeriod[] = [];
  for (const s of stores) {
    const p = periodFor(s);
    if ("error" in p) return refusal(name, "invalid", p.error);
    periods.push(p);
  }
  const needsProfit = metrics.some((m) => m === "profit" || m === "ad_spend" || m === "margin") || ((args.by === "variant" || args.by === "product") && anyMoney);

  const groups: Array<Map<string, Raw>> = [];
  const labels: Record<string, string> = {};
  const gaps = new Set<string>();
  const notes: string[] = [];
  const currencies = new Set<string | null>();
  const historyFrom: Array<string | null> = [];
  let orders = 0;
  for (const [i, store] of stores.entries()) {
    const period = periods[i]!;
    // Match the filter to the keys this period has ("lahore" → "Lahore").
    const options = args.filters ? (await summaryFor(ctx, store.id, period, scopeOf(null))).scopeOptions : undefined;
    const scope = scopeOf(args.filters, options);
    const { summary, slice } = await sliceFor(ctx, store, period, scope, { dimension: args.by, profit: needsProfit });
    const rows = args.variant ? slice.rows.filter((o) => o.lines.some((l) => l.variantId === args.variant)) : slice.rows;
    groups.push(rawGroups({ ...slice, rows }, args.by));
    Object.assign(labels, slice.labels);
    currencies.add(summary.store.currency);
    historyFrom.push(await firstDay(ctx, store.id));
    orders += rows.length;
    const section = screenFor(args.by, metrics).section;
    for (const g of await gapsFor(ctx, summary, section)) gaps.add(stores.length > 1 ? `${store.name}: ${g}` : g);
    if (anyMoney && summary.profit && metrics.some((m) => m === "profit" || m === "margin")) {
      for (const m of summary.profit.missing) gaps.add(stores.length > 1 ? `${store.name}: ${m}` : m);
    }
    if (anyMoney && !summary.store.currency) notes.push(`${store.name} has no currency yet, so no money figures`);
  }

  const oneCurrency = currencies.size === 1 && !currencies.has(null);
  if (anyMoney && stores.length > 1 && !oneCurrency) {
    return refusal(
      name,
      "invalid",
      "These stores sell in different currencies, so their money is not added up by row. Ask about one store at a time, or use summary for organization totals converted to the base currency.",
    );
  }
  return {
    stores,
    periods,
    metrics,
    anyMoney,
    merged: stores.length === 1 ? groups[0]! : mergeRaws(groups, anyMoney && oneCurrency),
    labels,
    gaps: [...gaps],
    notes,
    currency: oneCurrency ? [...currencies][0]! : null,
    orders,
    historyFrom,
  };
}

export const isRefusal = (x: Loaded | ToolResult): x is ToolResult => "tool" in x;

export async function runBreakdown(args: Args, ctx: AskContext): Promise<ToolResult> {
  const name = "breakdown";
  const loaded = await loadGroups(name, args, ctx, (s) => resolvePeriod(args.period, s.timezone, ctx.now));
  if (isRefusal(loaded)) return loaded;
  const { stores, periods, metrics, anyMoney, merged, labels, gaps, currency, orders } = loaded;
  const notes = [...loaded.notes];
  if (!orders) {
    return {
      ...refusal(name, "no_data", "No orders in this period" + (args.filters?.city || args.filters?.courier || args.variant ? " with these filters." : ".")),
      meta: { period: periodOf(periods[0]!), stores: stores.map(({ id, name }) => ({ id, name })), rules: [], gaps, notes: [] },
    };
  }

  const time = TIME_DIMS.has(args.by);
  const table = breakdownTable({
    groups: merged,
    dimension: args.by,
    metrics,
    currency,
    labels,
    sort: time ? "time" : (args.order ?? "top"),
    limit: Math.min(args.limit ?? (time ? 50 : 10), 50),
  });

  const screen = screenFor(args.by, metrics);
  const period = periods[0]!;
  const single: AskStore | null = stores.length === 1 ? stores[0]! : null;
  const filterQuery = { city: args.filters?.city ?? null, courier: args.filters?.courier ?? null };
  const link = args.variant
    ? { href: screenLink("orders", single, period.query, { variant: args.variant }), label: "Orders with this variant", exact: false }
    : single
      ? { href: screenLink(screen.section, single, period.query, screen.section === "home" ? {} : filterQuery), label: `Open ${screen.section}`, exact: screen.exact }
      : { href: screenLink("compare", null, period.query), label: "Compare stores", exact: false };

  const filtersSaid = [
    args.filters?.city ? `city ${args.filters.city}` : null,
    args.filters?.courier ? `courier ${args.filters.courier}` : null,
    args.variant ? `orders containing variant ${args.variant}` : null,
  ].filter(Boolean);
  if (filtersSaid.length) notes.push(`Filtered to ${filtersSaid.join(", ")}`);
  if (args.by === "week") notes.push("Weeks are 7-day blocks ending on the period's last day; the first may be partial");
  if ((args.filters?.city || args.filters?.courier) && anyMoney) notes.push("With a city or courier filter, ad spend is store-wide and not subtracted, as on the screens");
  if (stores.length > 1) notes.push(`Added up over ${stores.length} stores, each over its own local days`);

  return {
    tool: name,
    status: "ok",
    title: `${metrics.map((m) => METRIC_DEFS[m].label).join(", ")}${args.by === "none" ? "" : ` by ${DIMENSION_LABELS[args.by].toLowerCase()}`}`,
    columns: table.columns,
    rows: table.rows,
    meta: {
      period: periodOf(period),
      stores: stores.map(({ id, name }) => ({ id, name })),
      currency: anyMoney ? currency : undefined,
      rules: [...metrics.map((m) => METRIC_DEFS[m].rule), ...(args.by === "city" ? ["Cities are Courierify's canonical names; a spelling no app could place is \"Unmapped city\" (rule #12)."] : []), ...(stores.length > 1 && anyMoney ? [CURRENCY_RULE] : [])],
      gaps,
      notes: [...notes, ...table.notes, `${orders} orders in the period`],
      ...(table.total > table.rows.length ? { truncated: { shown: table.rows.length, total: table.total } } : {}),
    },
    link,
  };
}

export const breakdown: AskTool<typeof breakdownSchema> = {
  name: "breakdown",
  description:
    "Any metric by any dimension for a period: e.g. delivery rate by city, profit by product, orders by day, returns by courier, first vs repeat orders. Also a single total with by=none. Ranks rows top or bottom by the first metric.",
  schema: breakdownSchema,
  sections: (args) => {
    const s: Section[] = ["home"];
    if (args.metrics.some((m) => METRIC_DEFS[m].money)) s.push(...MONEY_SECTIONS);
    // Buyers are the Customers section's; campaigns and channels Marketing's.
    if (args.metrics.includes("buyers") || args.by === "buyer_type") s.push("customers");
    if (args.by === "campaign" || args.by === "channel") s.push("marketing");
    // A view by city or courier is the Shipping section's; by product, the Orders section's (its lines and variant filter).
    if (args.by === "city" || args.by === "courier" || args.filters?.city || args.filters?.courier) s.push("shipping");
    if (args.by === "product" || args.by === "variant" || args.variant) s.push("orders");
    return s;
  },
  run: runBreakdown,
};
