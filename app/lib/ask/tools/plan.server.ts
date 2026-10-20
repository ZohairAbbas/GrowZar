import { z } from "zod";

import { prisma } from "../../db.server";
import { FORECAST_STATUS } from "../../forecast/plan-form";
import { forecasts, runAndSave, savedPlan } from "../../forecast/plan.server";
import { storeRisk } from "../../forecast/return-risk.server";
import type { SimRequest } from "../../forecast/simulator/types";
import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { FORBIDDEN_STORE, oneStoreArg, pickOneStore, refusal, screenLink } from "./common.server";

/**
 * Plan's four tools (G-GZR11-7, pack §5.6): the cash forecast, the month-end
 * projection, return risk on orders not yet with the courier, and the budget
 * simulator. Each reads exactly what /plan (or Orders) shows, so Ask and the
 * screen give the same figures for the same inputs: ranges are seeded.
 *
 * Gated like the screens (pack §10, P11-14): Plan's tools only where the
 * viewer can see Plan, the risk tool only where return risk is on. A
 * forecast that failed its backtest says so in its rules, every time.
 */

const r0 = (x: number) => Math.round(x);
const planGate = (ctx: AskContext) => !!ctx.planTools;

function storeOf(ctx: AskContext, store: string | null, tool: string) {
  const s = pickOneStore(ctx, store);
  if (s === "ambiguous") return refusal(tool, "invalid", "Which store? This is per store; call list_stores for the ids.");
  if (!s) return refusal(tool, "forbidden", FORBIDDEN_STORE);
  if (!s.currency) return refusal(tool, "no_data", `${s.name} has no currency yet, so there is nothing to forecast.`);
  return s;
}

const statusRule = (s: { passes: boolean; note: string }) => (s.passes ? s.note : `This forecast failed its backtest, so treat it as rough and say so: ${s.note}`);

// ── cash_forecast ───────────────────────────────────────────────────────────

const storeOnly = z.object({ store: oneStoreArg }).strict();

async function runCashForecast(args: z.infer<typeof storeOnly>, ctx: AskContext): Promise<ToolResult> {
  const name = "cash_forecast";
  const store = storeOf(ctx, args.store, name);
  if ("tool" in store) return store;
  const cur = store.currency!;
  const { cash } = await forecasts(store.id);
  const paid = cash.paid.byPayer.length > 0;
  const columns: Column[] = [
    { key: "week", label: "Week", kind: "text" },
    { key: "due_low", label: "COD due, low", kind: "money", currency: cur },
    { key: "due_likely", label: "COD due, likely", kind: "money", currency: cur },
    { key: "due_high", label: "COD due, high", kind: "money", currency: cur },
    ...(paid
      ? ([
          { key: "paid_low", label: "Paid out, low", kind: "money", currency: cur },
          { key: "paid_likely", label: "Paid out, likely", kind: "money", currency: cur },
          { key: "paid_high", label: "Paid out, high", kind: "money", currency: cur },
        ] as Column[])
      : []),
  ];
  const rows: Array<Record<string, Cell>> = cash.weeks.map((w, i) => ({
    week: `${w.from} to ${w.to}`,
    due_low: r0(cash.due.weeks[i]!.low), due_likely: r0(cash.due.weeks[i]!.likely), due_high: r0(cash.due.weeks[i]!.high),
    ...(paid ? { paid_low: r0(cash.paid.weeks[i]!.low), paid_likely: r0(cash.paid.weeks[i]!.likely), paid_high: r0(cash.paid.weeks[i]!.high) } : {}),
  }));
  return {
    tool: name,
    status: cash.due.byPayer.length || cash.untimed.length ? "ok" : "no_data",
    title: "COD becoming due and paid out, by week, for the next 4 weeks (low / likely / high)",
    columns,
    rows,
    meta: {
      stores: [{ id: store.id, name: store.name }],
      currency: cur,
      rules: [
        statusRule(FORECAST_STATUS.cash),
        "COD becoming due = parcels in transit delivered at their courier and city's odds for their age, on the days such parcels take. Paid out = only for couriers whose payout cycle Growzar measures, or whose lag the merchant gave in a plan.",
        "Low and high are the 10th and 90th percentiles of 1,000 runs; the low end is the one to count on.",
      ],
      gaps: [],
      notes: [
        ...cash.untimed.map((u) => `${u.payer}: payout timing unknown (${u.reason}); holds ${r0(u.deliveredUnpaid)} ${cur} delivered and unpaid on ${u.deliveredParcels} parcels`),
        ...cash.overdue.map((o) => `${o.payer}: ${r0(o.amount)} ${cur} on ${o.parcels} parcels is older than any payout it has made`),
        ...(cash.notTracked.orders ? [`${cash.notTracked.orders} open orders have no Courierify parcel to time (about ${r0(cash.notTracked.expected.likely)} ${cur}, week unknown)`] : []),
      ],
    },
    link: { href: screenLink("plan", store, ""), label: "Open Plan (cash coming back)", exact: true },
  };
}

export const cashForecastTool: AskTool<typeof storeOnly> = {
  name: "cash_forecast",
  description: "Forecast for one store: how much COD will become due (delivered) and be paid out by couriers, week by week over the next 4 weeks, with low / likely / high. For 'when will my cash come back' or 'how much will couriers pay next week'.",
  schema: storeOnly,
  sections: () => ["plan", "finance"],
  gate: planGate,
  run: runCashForecast,
};

// ── month_end ───────────────────────────────────────────────────────────────

async function runMonthEnd(args: z.infer<typeof storeOnly>, ctx: AskContext): Promise<ToolResult> {
  const name = "month_end";
  const store = storeOf(ctx, args.store, name);
  if ("tool" in store) return store;
  const cur = store.currency!;
  const { month } = await forecasts(store.id);
  const { current: m, previous: p } = month;
  const money = (k: string, label: string): Column[] =>
    (["low", "likely", "high"] as const).map((x) => ({ key: `${k}_${x}`, label: `${label}, ${x}`, kind: "money" as const, currency: cur }));
  const columns: Column[] = [
    { key: "month", label: "Month", kind: "text" },
    { key: "orders_low", label: "Orders, low", kind: "count" },
    { key: "orders_likely", label: "Orders, likely", kind: "count" },
    { key: "orders_high", label: "Orders, high", kind: "count" },
    ...money("revenue", "Delivered revenue"),
    ...money("profit", "Profit"),
  ];
  const row = (label: string, x: typeof m): Record<string, Cell> => ({
    month: label,
    orders_low: r0(x.orders.total.low), orders_likely: r0(x.orders.total.likely), orders_high: r0(x.orders.total.high),
    revenue_low: x.deliveredRevenue ? r0(x.deliveredRevenue.low) : null, revenue_likely: x.deliveredRevenue ? r0(x.deliveredRevenue.likely) : null, revenue_high: x.deliveredRevenue ? r0(x.deliveredRevenue.high) : null,
    profit_low: x.profit ? r0(x.profit.low) : null, profit_likely: x.profit ? r0(x.profit.likely) : null, profit_high: x.profit ? r0(x.profit.high) : null,
  });
  return {
    tool: name,
    status: "ok",
    title: `${m.month} projected to month end, and ${p.month}, by the day orders were placed (low / likely / high)`,
    columns,
    rows: [row(`${m.month} (projected, day ${m.daysElapsed} of ${m.daysInMonth})`, m), row(`${p.month}`, p)],
    meta: {
      stores: [{ id: store.id, name: store.name }],
      currency: cur,
      rules: [
        statusRule(FORECAST_STATUS.monthEnd),
        "Orders to come: the last 8 weeks' same-weekday orders, adjusted for the last 4 weeks' trend (at most ±20%); open orders resolved at their delivery odds. Profit is Finance's: delivered revenue less product cost, courier fees, other costs and ad spend at this month's rate.",
      ],
      gaps: [],
      notes: [
        `${m.orders.soFar} orders placed so far this month`,
        ...(m.unresolvedAtMonthEnd !== null ? [`about ${r0(m.unresolvedAtMonthEnd * 100)}% of this month's orders will still be undecided on its last day`] : []),
        ...m.notes,
      ],
    },
    link: { href: screenLink("plan", store, ""), label: "Open Plan (month end)", exact: true },
  };
}

export const monthEndTool: AskTool<typeof storeOnly> = {
  name: "month_end",
  description: "Projection for one store of this month's orders, delivered revenue and profit at month end (low / likely / high), beside last month's. For 'how will this month end' or 'will I beat last month'.",
  schema: storeOnly,
  sections: () => ["plan"],
  gate: planGate,
  run: runMonthEnd,
};

// ── order_risk_summary ──────────────────────────────────────────────────────

async function runRiskSummary(args: z.infer<typeof storeOnly>, ctx: AskContext): Promise<ToolResult> {
  const name = "order_risk_summary";
  const store = storeOf(ctx, args.store, name);
  if ("tool" in store) return store;
  const courierify = await prisma.appConnection.findFirst({ where: { storeId: store.id, app: "COURIERIFY", status: "CONNECTED" }, select: { app: true } });
  if (!courierify) return refusal(name, "no_data", `Return risk needs Courierify, which ${store.name} doesn't have connected.`);
  const risk = await storeRisk(store.id);
  const bands = (["high", "medium", "low"] as const).map((band) => ({ band, orders: [...risk.orders.values()].filter((o) => o.band === band).length }));
  // The most common reasons among high-risk orders, by what they are about (the words before the figures).
  const reasons = new Map<string, number>();
  for (const o of risk.orders.values()) if (o.band === "high") for (const r of o.reasons) reasons.set(r.split(":")[0]!, (reasons.get(r.split(":")[0]!) ?? 0) + 1);
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    tool: name,
    status: risk.orders.size ? "ok" : "no_data",
    title: "Orders not yet with the courier (last 30 days), by return risk",
    columns: [
      { key: "band", label: "Return risk", kind: "text" },
      { key: "orders", label: "Orders", kind: "count" },
    ],
    rows: bands,
    meta: {
      stores: [{ id: store.id, name: store.name }],
      rules: [
        "A band and its reasons, never a percentage. Scored from this store's own history only: the buyer's earlier orders, first or repeat, Courierify's network label, the route, the product, the WhatsApp confirmation, offers and payment method.",
        `High = the riskiest slice whose return rate was at least twice the store's odds (${r0(risk.cuts.storeRate * 100)}% of its recent orders came back); ${risk.cuts.high === null ? "no slice reached it, so no order is high" : "low = half the odds or less"}.`,
        "The bands are still waiting for approval, so this is for internal use.",
      ],
      gaps: [],
      notes: top.map(([r, n]) => `${n} high-risk order(s): ${r}`),
    },
    link: { href: screenLink("orders", store, "risk=high"), label: "Open Orders (high return risk)", exact: true },
  };
}

export const orderRiskSummary: AskTool<typeof storeOnly> = {
  name: "order_risk_summary",
  description: "For one store: how many orders not yet with the courier (last 30 days) are high, medium or low return risk, and the commonest reasons for the high ones. For 'which orders might come back' or 'should I confirm anything before shipping'.",
  schema: storeOnly,
  sections: () => ["orders"],
  gate: (ctx) => !!ctx.riskTools,
  run: runRiskSummary,
};

// ── plan_budget ─────────────────────────────────────────────────────────────

const planSchema = z
  .object({
    store: oneStoreArg,
    budget: z.number().positive().describe("The amount to plan, in the store's currency."),
    days: z.number().int().min(7).max(60).nullable().describe("Days the plan covers. Null for 30."),
    include: z
      .array(z.enum(["ads", "stock", "buffer"]))
      .nullable()
      .describe("What the money may go to. Null for all three."),
    exclude_platforms: z.array(z.string()).nullable().describe("Ad platforms to leave out, e.g. [\"tiktok\"]. Null for none."),
    payout_lags: z
      .array(z.object({ payer: z.string(), days: z.number().min(0).max(365) }).strict())
      .nullable()
      .describe("Days each courier takes to pay after delivery, as the merchant said, for couriers Growzar can't measure. Null when not given."),
  })
  .strict();

async function runPlanBudget(args: z.infer<typeof planSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "plan_budget";
  const store = storeOf(ctx, args.store, name);
  if ("tool" in store) return store;
  const cur = store.currency!;
  const include = args.include ?? ["ads", "stock", "buffer"];
  const request: SimRequest = {
    budget: args.budget,
    horizonDays: args.days ?? 30,
    include: { ads: include.includes("ads"), stock: include.includes("stock"), buffer: include.includes("buffer") },
    keepInStock: [],
    minBuffer: 0,
    excludePlatforms: args.exclude_platforms ?? [],
    leadTimes: {},
    payoutLags: Object.fromEntries((args.payout_lags ?? []).map((l) => [l.payer, l.days])),
  };
  const id = await runAndSave(store.id, ctx.organizationId, ctx.userId, request);
  const plan = await savedPlan(store.id, id);
  const link = { href: screenLink("plan", store, "", { id }), label: "Open the plan in Plan", exact: true };
  const meta = { stores: [{ id: store.id, name: store.name }], currency: cur, gaps: [] as string[] };
  if (!plan || plan.status === "refused") {
    const fixes = plan?.status === "refused" ? plan.fixes : [];
    const lags = fixes.filter((f) => f.check === "payout_lag");
    return {
      tool: name,
      status: "not_enough_data",
      title: "No plan: the data a plan rests on isn't there yet",
      columns: [{ key: "fix", label: "What to fix", kind: "text" }],
      rows: fixes.map((f) => ({ fix: f.detail })),
      meta: {
        ...meta,
        rules: ["A store that fails the data gate gets no plan, only what to fix (no half-plans, no wide guesses)."],
        notes: lags.length && lags.length === fixes.length ? [`Ask the merchant how many days ${lags.map((l) => l.payer).join(", ")} take to pay after delivery, then call plan_budget again with payout_lags.`] : [],
      },
      link,
    };
  }
  const columns: Column[] = [
    { key: "line", label: "Line", kind: "text" },
    { key: "amount", label: "Amount", kind: "money", currency: cur },
    { key: "orders_low", label: "Delivered orders, low", kind: "count" },
    { key: "orders_likely", label: "Delivered orders, likely", kind: "count" },
    { key: "orders_high", label: "Delivered orders, high", kind: "count" },
    { key: "profit_low", label: "Profit, low", kind: "money", currency: cur },
    { key: "profit_likely", label: "Profit, likely", kind: "money", currency: cur },
    { key: "profit_high", label: "Profit, high", kind: "money", currency: cur },
    { key: "cash_back_by", label: "Cash back by", kind: "date" },
  ];
  const rows: Array<Record<string, Cell>> = plan.lines.map((l) => ({
    line: l.label, amount: r0(l.amount),
    orders_low: l.deliveredOrders ? r0(l.deliveredOrders.low) : null, orders_likely: l.deliveredOrders ? r0(l.deliveredOrders.likely) : null, orders_high: l.deliveredOrders ? r0(l.deliveredOrders.high) : null,
    profit_low: r0(l.profit.low), profit_likely: r0(l.profit.likely), profit_high: r0(l.profit.high), cash_back_by: l.cashBackBy,
  }));
  const t = plan.totals;
  rows.push({
    line: "Whole plan", amount: r0(t.allocated),
    orders_low: r0(t.deliveredOrders.low), orders_likely: r0(t.deliveredOrders.likely), orders_high: r0(t.deliveredOrders.high),
    profit_low: r0(t.profit.low), profit_likely: r0(t.profit.likely), profit_high: r0(t.profit.high), cash_back_by: t.cashBackBy,
  });
  return {
    tool: name,
    status: "ok",
    title: `A plan for ${r0(args.budget)} ${cur} over ${request.horizonDays} days: where it goes, what it brings, when the cash is back`,
    columns,
    rows,
    meta: {
      ...meta,
      rules: [statusRule(FORECAST_STATUS.simulator), "Profit is delivered profit after the line's spend; the low end is the one to count on.", ...plan.assumptions],
      notes: [...(t.kept > 0 ? [`${r0(t.kept)} ${cur} kept as cash: no further spend earned more than it cost`] : []), ...plan.leftOut.slice(0, 5)],
    },
    link,
  };
}

export const planBudget: AskTool<typeof planSchema> = {
  name: "plan_budget",
  description: "Runs the budget simulator for one store and saves the plan: where a budget should go across ad lines, stock and a cash buffer, with delivered orders, profit (low / likely / high) and when the cash is back. Refuses, with what to fix, where the data isn't there. For 'I have X for the next 30 days, where should it go?'.",
  schema: planSchema,
  sections: () => ["plan", "finance"],
  gate: planGate,
  run: runPlanBudget,
};
