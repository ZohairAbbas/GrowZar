import { z } from "zod";

import { cashTimeline } from "../../metrics/cash";
import { parseAmount, type Money } from "../../metrics/money";
import { trackedPayers } from "../../metrics/outcome-sources";
import { NO_SCOPE } from "../../metrics/scope";
import { storePayoutAgeing } from "../../metrics/screens.server";
import { loadPayerHistories, loadStatements } from "../../metrics/settlements.server";
import { labelOf, toMajor } from "../engine";
import { memo, summaryFor } from "../load.server";
import { periodArg, periodOf, resolvePeriod } from "../period.server";
import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { FORBIDDEN_STORE, gapsFor, oneStoreArg, pickOneStore, refusal, screenLink } from "./common.server";

/**
 * Finance's cash views, as they are on the screen: COD couriers owe by age
 * (payout ageing, as of today, any order date), each payer's payout rhythm,
 * and where the period's money is (the cash timeline).
 */

export const cashSchema = z
  .object({
    store: oneStoreArg,
    view: z
      .enum(["owed", "payouts", "stages"])
      .describe("owed: delivered COD not yet paid, by courier and age (as of today). payouts: when each courier last paid and how often. stages: where the period's order money is now."),
    period: periodArg.nullable().describe("For stages only. Null for the last 30 days."),
  })
  .strict();

const major = (m: Money) => toMajor(parseAmount(m.amount)!);
const DAY = 86_400_000;

export async function runCash(args: z.infer<typeof cashSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "cash";
  const store = pickOneStore(ctx, args.store);
  if (store === "ambiguous") return refusal(name, "invalid", "Which store? Cash is per store; call list_stores for the ids.");
  if (!store) return refusal(name, "forbidden", FORBIDDEN_STORE);
  if (!store.currency) return refusal(name, "no_data", `${store.name} has no currency yet, so there are no cash figures.`);
  const cur = store.currency;
  const base = { stores: [{ id: store.id, name: store.name }], currency: cur };

  if (args.view === "owed") {
    const ageing = await storePayoutAgeing(store.id, cur, NO_SCOPE);
    if (!ageing || (!ageing.couriers.length && !ageing.untracked.length)) {
      return { ...refusal(name, "no_data", "No delivered COD is waiting for a courier payout."), link: { href: screenLink("finance", store, "days=30"), label: "Open Finance", exact: true } };
    }
    const columns: Column[] = [
      { key: "courier", label: "Courier", kind: "text" },
      { key: "paid_by", label: "Paid by", kind: "text" },
      { key: "owed", label: "Owed", kind: "money", currency: cur },
      { key: "orders", label: "Orders", kind: "count" },
      ...ageing.buckets.map((b): Column => ({ key: `age_${b.key}`, label: `Delivered ${b.label} ago`, kind: "money", currency: cur })),
    ];
    const rows: Array<Record<string, Cell>> = ageing.couriers.map((c) => ({
      courier: labelOf("courier", c.courier, {}),
      paid_by: c.paidBy ? labelOf("courier", c.paidBy, {}) : null,
      owed: major(c.total),
      orders: c.orders,
      ...Object.fromEntries(ageing.buckets.map((b) => [`age_${b.key}`, major(c.cells[b.key]!.amount)])),
    }));
    rows.push({ courier: "All tracked couriers", paid_by: null, owed: major(ageing.total), orders: ageing.orders });
    return {
      tool: name,
      status: "ok",
      title: "COD delivered and not yet paid by couriers, by age",
      columns,
      rows,
      meta: {
        ...base,
        rules: ["Owed = COD of delivered parcels no courier settlement covers yet, as Courierify last saw it, as of today and whatever the order date.", "Only couriers whose payouts Courierify records are counted as owing."],
        gaps: [],
        notes: [
          ...ageing.untracked.map((u) => `${labelOf("courier", u.courier, {})}: ${major(u.total)} ${cur} on ${u.orders} delivered orders, but no payout from it has ever been recorded, so it is listed apart and not counted as owed`),
          ...ageing.otherCurrencies.map((m) => `${major(m)} ${m.currency} in another currency not added in (rule #4)`),
        ],
      },
      link: { href: screenLink("finance", store, "days=30"), label: "Open Finance (payout ageing)", exact: true },
    };
  }

  if (args.view === "payouts") {
    const histories = await memo(ctx, `payers:${store.id}`, () => loadPayerHistories(store.id));
    if (!histories.length) return refusal(name, "no_data", "No courier payouts are recorded for this store.");
    const rows = histories.map((h) => ({
      courier: labelOf("courier", h.payer, {}),
      payouts: h.payouts,
      last_paid: h.lastPaidDay,
      every_days: h.medianGapDays,
      next_expected: h.lastPaidDay && h.medianGapDays !== null ? new Date(Date.parse(`${h.lastPaidDay}T00:00:00Z`) + Math.round(h.medianGapDays) * DAY).toISOString().slice(0, 10) : null,
      disputed: h.disputed,
    }));
    return {
      tool: name,
      status: "ok",
      title: "Courier payouts: when each last paid and how often",
      columns: [
        { key: "courier", label: "Courier", kind: "text" },
        { key: "payouts", label: "Payouts received", kind: "count" },
        { key: "last_paid", label: "Last paid", kind: "date" },
        { key: "every_days", label: "Usually pays every (days)", kind: "days" },
        { key: "next_expected", label: "Next payout expected around", kind: "date" },
        { key: "disputed", label: "Disputed statements", kind: "count" },
      ],
      rows,
      meta: {
        ...base,
        rules: ["A payout rhythm is the median days between payout days, and needs at least 3 payouts; the next payout is the last one plus that rhythm, an expectation and not a promise."],
        gaps: [],
        notes: [],
      },
      link: { href: screenLink("finance", store, "days=30"), label: "Open Finance", exact: false },
    };
  }

  const period = resolvePeriod(args.period, store.timezone, ctx.now);
  if ("error" in period) return refusal(name, "invalid", period.error);
  const s = await summaryFor(ctx, store.id, period, NO_SCOPE);
  const statements = await memo(ctx, `statements:${store.id}`, () => loadStatements(store.id));
  const t = cashTimeline(s.rows, cur, trackedPayers(statements.map((x) => x.payer)), ctx.now);
  return {
    tool: name,
    status: t.stages.length ? "ok" : "no_data",
    title: "Where the period's order money is now",
    columns: [
      { key: "stage", label: "Stage", kind: "text" },
      { key: "orders", label: "Orders", kind: "count" },
      { key: "amount", label: "Amount", kind: "money", currency: cur },
    ],
    rows: t.stages.map((x) => ({ stage: x.label, orders: x.orders, amount: major(x.amount) })),
    meta: {
      ...base,
      period: periodOf(period),
      rules: ["Each order of the period is in exactly one stage, as of today. \"Awaiting payout\" counts only couriers whose payouts are recorded; another courier's delivered order is \"payout not tracked\", never owed."],
      gaps: await gapsFor(ctx, s, "finance"),
      notes: t.stuck.booked + t.stuck.inTransit ? [`${t.stuck.booked + t.stuck.inTransit} parcels have had no status change for days (${t.stuck.booked} booked, ${t.stuck.inTransit} in transit), worth ${major(t.stuck.amount)} ${cur}`] : [],
    },
    link: { href: screenLink("finance", store, period.query), label: "Open Finance (where the cash is)", exact: true },
  };
}

export const cash: AskTool<typeof cashSchema> = {
  name: "cash",
  description: "Cash for one store: what couriers owe (delivered COD not yet paid, by age), each courier's payout rhythm and next expected payout, or where the period's order money is now (not dispatched, with courier, awaiting payout, paid, returned).",
  schema: cashSchema,
  sections: () => ["finance"],
  run: runCash,
};
