import { z } from "zod";

import { checkoutsSection, formAbandonmentsSection } from "../../metrics/checkouts.server";
import { messagingSection } from "../../metrics/messaging.server";
import { parseAmount, type Money } from "../../metrics/money";
import { offersSection } from "../../metrics/offers.server";
import { NO_SCOPE } from "../../metrics/scope";
import { marketingView } from "../../metrics/screens.server";
import { labelOf, toMajor } from "../engine";
import { memo, summaryFor } from "../load.server";
import { periodArg, periodOf, resolvePeriod } from "../period.server";
import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { FORBIDDEN_STORE, gapsFor, limitArg, oneStoreArg, pickOneStore, refusal, screenLink } from "./common.server";

/**
 * The Marketing section's panels: what each ad campaign's orders did,
 * messages sent and what followed, abandoned checkouts and what was
 * recovered, and Preventify's form offers. Counts for everyone; money columns
 * only for a viewer who may see Finance.
 */

export const marketingSchema = z
  .object({
    store: oneStoreArg,
    view: z
      .enum(["campaigns", "messages", "checkouts", "cod_forms", "offers"])
      .describe(
        "campaigns: each ad campaign's spend, orders, deliveries, returns and ROAS. messages: Retainify/WhatKaBot messages by channel and journey, and the orders that followed. checkouts: abandoned Shopify checkouts, followed up and recovered. cod_forms: abandoned COD forms. offers: Preventify form offers and their return rates.",
      ),
    period: periodArg.nullable(),
    limit: limitArg,
  })
  .strict();

const one = (list: Money[], cur: string | null) => {
  const m = cur ? list.find((x) => x.currency === cur) : undefined;
  return m ? toMajor(parseAmount(m.amount)!) : cur ? 0 : null;
};
const major = (m: Money | null) => (m ? toMajor(parseAmount(m.amount)!) : null);

export async function runMarketing(args: z.infer<typeof marketingSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "marketing";
  const store = pickOneStore(ctx, args.store);
  if (store === "ambiguous") return refusal(name, "invalid", "Which store? Marketing is per store; call list_stores for the ids.");
  if (!store) return refusal(name, "forbidden", FORBIDDEN_STORE);
  const period = resolvePeriod(args.period, store.timezone, ctx.now);
  if ("error" in period) return refusal(name, "invalid", period.error);
  const money = ctx.can("finance");
  const s = await summaryFor(ctx, store.id, period, NO_SCOPE);
  const cur = s.store.currency;
  const limit = Math.min(args.limit ?? 10, 50);
  const base = { period: periodOf(period), stores: [{ id: store.id, name: store.name }], currency: money ? cur : undefined, gaps: await gapsFor(ctx, s, "marketing") };
  const link = { href: screenLink("marketing", store, period.query), label: "Open Marketing", exact: true };
  const cut = (n: number) => (n > limit ? { truncated: { shown: limit, total: n } } : {});

  if (args.view === "campaigns") {
    const view = await memo(ctx, `marketing:${store.id}:${period.from}:${period.to}`, () => marketingView(store.id, s));
    const out = view.outcomes;
    if (!out || !out.campaigns.length) return { ...refusal(name, "no_data", "No orders tied to ad campaigns in this period (Financify sends the link from order to campaign)."), link };
    const rows: Array<Record<string, Cell>> = out.campaigns.slice(0, limit).map((c) => ({
      key: c.key,
      label: c.name,
      platform: labelOf("channel", c.platform, {}),
      orders: c.orders,
      delivered: c.delivered,
      returned: c.returned,
      still_open: c.stillOpen,
      return_rate: c.returnRate,
      ...(money ? { spend: major(c.spend), delivered_revenue: major(c.deliveredRevenue), roas: c.roas, cost_per_delivered: major(c.costPerDelivered) } : {}),
    }));
    const columns: Column[] = [
      { key: "key", label: "Campaign key", kind: "text" },
      { key: "label", label: "Campaign", kind: "text" },
      { key: "platform", label: "Platform", kind: "text" },
      { key: "orders", label: "Orders", kind: "count" },
      { key: "delivered", label: "Delivered", kind: "count" },
      { key: "returned", label: "Returned", kind: "count" },
      { key: "still_open", label: "Still open", kind: "count" },
      { key: "return_rate", label: "Return rate", kind: "percent" },
      ...(money && cur
        ? ([
            { key: "spend", label: "Spend", kind: "money", currency: cur },
            { key: "delivered_revenue", label: "Delivered revenue", kind: "money", currency: cur },
            { key: "roas", label: "ROAS", kind: "number", money: true },
            { key: "cost_per_delivered", label: "Cost per delivered order", kind: "money", currency: cur },
          ] satisfies Column[])
        : []),
    ];
    return {
      tool: name,
      status: "ok",
      title: "What each ad campaign's orders did",
      columns,
      rows,
      meta: {
        ...base,
        rules: [
          "Orders are tied to campaigns by Financify; outcomes are Growzar's own.",
          "Return rate needs 20 decided orders. ROAS = delivered revenue ÷ (spend + platform fees), withheld when over 20% of a campaign's orders can never be tracked.",
        ],
        notes: [
          `${out.matched} of ${out.of} orders Financify knows are tied to a campaign`,
          ...(out.unattributed.untracked ? [`${out.unattributed.untracked} orders had no campaign (organic, direct or untagged)`] : []),
          ...(out.storeReturnRate !== null ? [`Store return rate over the same orders: ${out.storeReturnRate}%`] : []),
        ],
        ...cut(out.campaigns.length),
      },
      link,
    };
  }

  if (args.view === "messages") {
    const m = await messagingSection(store.id, period);
    if (!m || !m.messages) return { ...refusal(name, "no_data", "No messages sent in this period (Retainify or WhatKaBot sends them)."), link };
    const rows: Array<Record<string, Cell>> = m.journeys.slice(0, limit).map((j) => ({
      label: j.name,
      kind: j.kind,
      sent: j.sent,
      reached: j.reached,
      opened: j.opened,
      clicked: j.clicked,
      failed: j.failed,
      orders_after: j.orders,
      delivered_after: j.delivered,
      ...(money ? { delivered_revenue_after: one(j.deliveredRevenue, cur) } : {}),
    }));
    return {
      tool: name,
      status: "ok",
      title: "Messages by journey, and the orders that followed",
      columns: [
        { key: "label", label: "Journey", kind: "text" },
        { key: "kind", label: "Kind", kind: "text" },
        { key: "sent", label: "Sent", kind: "count" },
        { key: "reached", label: "Reached", kind: "count" },
        { key: "opened", label: "Opened", kind: "count" },
        { key: "clicked", label: "Clicked", kind: "count" },
        { key: "failed", label: "Failed", kind: "count" },
        { key: "orders_after", label: "Orders after", kind: "count" },
        { key: "delivered_after", label: "Delivered after", kind: "count" },
        ...(money && cur ? ([{ key: "delivered_revenue_after", label: "Delivered revenue after", kind: "money", currency: cur }] satisfies Column[]) : []),
      ],
      rows,
      meta: {
        ...base,
        rules: ["\"Orders after\" are orders the messaged buyer placed after the message; they followed it, which is not proof the message caused them."],
        notes: [
          `${m.messages} messages; ${m.matched} matched a buyer of the store`,
          ...m.channels.map((c) => `${c.channel}: ${c.sent} sent, ${c.reached} reached, ${c.clicked} clicked`),
          `${m.followed.orders} orders followed a message (${m.followed.viaClick} after a click)`,
        ],
        ...cut(m.journeys.length),
      },
      link,
    };
  }

  if (args.view === "checkouts" || args.view === "cod_forms") {
    const c = args.view === "checkouts" ? await checkoutsSection(store.id, period, ctx.now) : await formAbandonmentsSection(store.id, period, ctx.now);
    const what = args.view === "checkouts" ? "abandoned checkouts" : "abandoned COD forms";
    if (!c || !c.started) return { ...refusal(name, "no_data", `No ${what} data in this period.`), link };
    const row: Record<string, Cell> = {
      started: c.started,
      abandoned: c.abandoned,
      open: c.open,
      settled: c.settled,
      followed_up: c.followedUp,
      not_followed_up: c.notFollowedUp,
      recovered: c.recovered,
      came_back: c.cameBack,
      ...(money ? { abandoned_value: one(c.abandonedValue, cur), recovered_value: one(c.recoveredValue, cur), not_followed_up_value: one(c.notFollowedUpValue, cur) } : {}),
    };
    return {
      tool: name,
      status: "ok",
      title: args.view === "checkouts" ? "Abandoned checkouts and what was recovered" : "Abandoned COD forms",
      columns: [
        { key: "started", label: "Started", kind: "count" },
        { key: "abandoned", label: "Abandoned", kind: "count" },
        { key: "open", label: "Still in the 7-day window", kind: "count" },
        { key: "settled", label: "Past the window", kind: "count" },
        { key: "followed_up", label: "Got a reminder", kind: "count" },
        { key: "not_followed_up", label: "Got no reminder", kind: "count" },
        { key: "recovered", label: "Recovered", kind: "count" },
        { key: "came_back", label: "Came back on their own", kind: "count" },
        ...(money && cur
          ? ([
              { key: "abandoned_value", label: "Abandoned value", kind: "money", currency: cur },
              { key: "recovered_value", label: "Recovered value", kind: "money", currency: cur },
              { key: "not_followed_up_value", label: "Value with no reminder", kind: "money", currency: cur },
            ] satisfies Column[])
          : []),
      ],
      rows: [row],
      meta: {
        ...base,
        rules: ["A checkout is settled 7 days after it was abandoned; recovered means the buyer ordered after a reminder."],
        notes: c.cartJourneys.map((j) => `Cart journey "${j.name}": ${j.status ?? "status unknown"}${j.lastSent ? `, last sent ${j.lastSent}` : ""}`),
      },
      link,
    };
  }

  const o = await offersSection(store.id, period);
  if (!o || !o.formOrders) return { ...refusal(name, "no_data", "No Preventify form orders in this period."), link };
  const rows: Array<Record<string, Cell>> = o.byOffer.slice(0, limit).map((g) => ({
    label: g.label,
    type: g.type.replace("_", " "),
    orders: g.orders,
    delivered: g.delivered,
    returned: g.returned,
    return_rate: g.returnRate,
    ...(money ? { avg_order_value: major(g.avgPlaced) } : {}),
  }));
  return {
    tool: name,
    status: "ok",
    title: "Preventify form offers",
    columns: [
      { key: "label", label: "Offer", kind: "text" },
      { key: "type", label: "Type", kind: "text" },
      { key: "orders", label: "Orders", kind: "count" },
      { key: "delivered", label: "Delivered", kind: "count" },
      { key: "returned", label: "Returned", kind: "count" },
      { key: "return_rate", label: "Return rate", kind: "percent" },
      ...(money && cur ? ([{ key: "avg_order_value", label: "Average order value", kind: "money", currency: cur }] satisfies Column[]) : []),
    ],
    rows,
    meta: {
      ...base,
      rules: ["Return rate = returned ÷ (delivered + returned), shown only with enough decided orders."],
      notes: [`${o.formOrders} orders came through the form`, ...o.byType.map((t) => `${t.label}: ${t.orders} orders${t.returnRate !== null ? `, ${t.returnRate}% returned` : ""}`)],
      ...cut(o.byOffer.length),
    },
    link,
  };
}

export const marketing: AskTool<typeof marketingSchema> = {
  name: "marketing",
  description: "Marketing for one store: what each ad campaign's orders did (and spend, ROAS with Finance access), messages and the orders that followed, abandoned checkouts or COD forms and what was recovered, or Preventify form offers and their return rates.",
  schema: marketingSchema,
  sections: () => ["marketing"],
  run: runMarketing,
};
