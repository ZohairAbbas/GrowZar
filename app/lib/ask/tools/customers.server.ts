import { z } from "zod";

import { buyerHistorySection } from "../../metrics/buyer-history.server";
import { previousPeriod } from "../../metrics/compare";
import { NO_SCOPE } from "../../metrics/scope";
import { customersView } from "../../metrics/screens.server";
import { memo, summaryFor } from "../load.server";
import { periodArg, periodOf, resolvePeriod } from "../period.server";
import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { FORBIDDEN_STORE, gapsFor, oneStoreArg, pickOneStore, refusal, screenLink } from "./common.server";

/**
 * The Customers section's numbers, as counts and rates only. No buyer is ever
 * named, numbered or listed: the section's top-buyers list is left out
 * entirely (B3), and cohorts are months, not people.
 */

export const customersSchema = z
  .object({
    store: oneStoreArg,
    view: z
      .enum(["repeat", "repeat_curve", "cohorts", "returners"])
      .describe(
        "repeat: buyers in the period and how many are repeat buyers. repeat_curve: share of buyers who ordered again within 7–90 days. cohorts: buyers by month of first delivered order and how many came back each month. returners: return rate of orders from buyers who returned before, delivered before, or are new.",
      ),
    period: periodArg.nullable(),
  })
  .strict();

const BAND_LABELS: Record<string, string> = {
  returned_before: "Buyer returned a parcel before",
  delivered_before: "Buyer's earlier orders delivered",
  first: "First order (nothing decided before)",
};

export async function runCustomers(args: z.infer<typeof customersSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "customers";
  const store = pickOneStore(ctx, args.store);
  if (store === "ambiguous") return refusal(name, "invalid", "Which store? Buyers are per store; call list_stores for the ids.");
  if (!store) return refusal(name, "forbidden", FORBIDDEN_STORE);
  const period = resolvePeriod(args.period, store.timezone, ctx.now);
  if ("error" in period) return refusal(name, "invalid", period.error);
  const s = await summaryFor(ctx, store.id, period, NO_SCOPE);
  const before = previousPeriod(period.from, period.to);
  const meta = { period: periodOf(period), stores: [{ id: store.id, name: store.name }], gaps: await gapsFor(ctx, s, "customers") };
  const link = { href: screenLink("customers", store, period.query), label: "Open Customers", exact: true };

  if (args.view === "returners") {
    const h = await buyerHistorySection(store.id, period);
    if (!h) return { ...refusal(name, "no_data", "No orders with a buyer record in this period."), link };
    return {
      tool: name,
      status: "ok",
      title: "Returns by what the buyer did before",
      columns: [
        { key: "label", label: "Buyer's history", kind: "text" },
        { key: "orders", label: "Orders", kind: "count" },
        { key: "delivered", label: "Delivered", kind: "count" },
        { key: "returned", label: "Returned", kind: "count" },
        { key: "return_rate", label: "Return rate", kind: "percent" },
      ],
      rows: h.bands.map((b) => ({ label: BAND_LABELS[b.band] ?? b.band, orders: b.orders, delivered: b.delivered, returned: b.returned, return_rate: b.rate })),
      meta: {
        ...meta,
        rules: ["Each order is banded by what the same buyer's earlier orders had come to before it was placed, with this store only, so nothing is judged with hindsight."],
        notes: [
          ...(h.returnsFromReturners !== null ? [`${h.returnsFromReturners}% of the period's returns came from buyers who had returned before`] : []),
          ...(h.formShare !== null ? [`${h.formShare}% of the period's orders came through Preventify's COD form`] : []),
          ...(h.otpEnabled !== null ? [`Preventify buyer verification is ${h.otpEnabled ? "on" : "off"}`] : []),
        ],
      },
      link,
    };
  }

  const prev = await summaryFor(ctx, store.id, before, NO_SCOPE);
  // Without money: the cohorts' gross profit is Finance's, and this tool answers counts.
  const view = await memo(ctx, `customers:${store.id}:${period.from}:${period.to}`, () => customersView(store.id, s, prev, false));
  const r = view.retention;

  if (args.view === "repeat") {
    const share = view.compare.repeatShare.delta;
    return {
      tool: name,
      status: view.buyersInPeriod ? "ok" : "no_data",
      title: "Buyers and repeat buyers",
      columns: [
        { key: "buyers", label: "Buyers in period", kind: "count" },
        { key: "repeat_buyers", label: "Repeat buyers (2+ orders ever)", kind: "count" },
        { key: "repeat_share", label: "Repeat share", kind: "percent" },
        { key: "repeat_share_before", label: "Repeat share, previous period", kind: "percent" },
        { key: "repeat_share_change", label: "Change (points)", kind: "points" },
        { key: "customers", label: "Customers ever", kind: "count" },
      ],
      rows: [{ buyers: view.buyersInPeriod, repeat_buyers: view.repeatBuyers, repeat_share: share.current, repeat_share_before: share.previous, repeat_share_change: share.change, customers: view.customers }],
      meta: {
        ...meta,
        rules: [
          "A buyer is Growzar's own customer record: one person however they spell their number (rule #19).",
          "Repeat buyer: 2 or more orders up to the period's end (lifetime, rule #20). No share under 20 buyers.",
        ],
        notes: [],
      },
      link,
    };
  }

  if (args.view === "repeat_curve") {
    return {
      tool: name,
      status: r.repeat.some((p) => p.share !== null) ? "ok" : "not_enough_data",
      title: "Buyers who ordered again within N days of their first delivered order",
      columns: [
        { key: "days", label: "Within (days)", kind: "days" },
        { key: "eligible", label: "Buyers old enough to count", kind: "count" },
        { key: "repeated", label: "Ordered again", kind: "count" },
        { key: "share", label: "Share", kind: "percent" },
      ],
      rows: r.repeat.map((p) => ({ days: p.days, eligible: p.eligible, repeated: p.repeated, share: p.share })),
      meta: {
        ...meta,
        rules: ["Over every delivered order Growzar holds, as of the period's end; a buyer counts for N days only once their first delivered order is N days old. No share under 20 buyers."],
        notes: [
          ...(r.medianDaysToSecond !== null ? [`Median ${r.medianDaysToSecond} days from first to second delivered order, over ${r.secondOrders} buyers who came back`] : []),
          ...(r.historyFrom ? [`History from ${r.historyFrom}`] : []),
        ],
      },
      link,
    };
  }

  const offsets = Math.min(r.maxOffset, 6);
  const columns: Column[] = [
    { key: "month", label: "First delivered order in", kind: "text" },
    { key: "buyers", label: "Buyers", kind: "count" },
    ...Array.from({ length: offsets }, (_, i): Column => ({ key: `m${i + 1}`, label: `Back in month ${i + 1}`, kind: "percent" })),
  ];
  const rows: Array<Record<string, Cell>> = r.cohorts.map((c) => ({
    month: c.month,
    buyers: c.buyers,
    ...Object.fromEntries(Array.from({ length: offsets }, (_, i) => [`m${i + 1}`, c.cells.find((x) => x.offset === i + 1)?.share ?? null])),
  }));
  return {
    tool: name,
    status: rows.length ? "ok" : "no_data",
    title: "Monthly cohorts: share of buyers who ordered again",
    columns,
    rows,
    meta: {
      ...meta,
      rules: ["A cohort is the buyers whose first delivered order fell in that month; each later month shows the share with another delivered order then. No share for a cohort under 20 buyers; the current month is still filling."],
      notes: r.cohorts.some((c) => c.partialFirstMonth) ? ["The first month is when Growzar's history starts, so it began mid-month"] : [],
    },
    link,
  };
}

export const customers: AskTool<typeof customersSchema> = {
  name: "customers",
  description: "Buyers for one store, as counts and rates only (never who they are): buyers and repeat share, the repeat curve, monthly cohorts, or return rates by the buyer's past behaviour.",
  schema: customersSchema,
  sections: () => ["customers"],
  run: runCustomers,
};
