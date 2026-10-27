/**
 * Plan's pieces that need no database (G-GZR11-6): reading the simulator form,
 * taking money out of a plan for a viewer without finance:view, and where each
 * forecast stands against its backtest. Pure.
 */

import type { CashForecast } from "./cash";
import type { MonthEnd } from "./month-end";
import type { Plan, SimRequest } from "./simulator/types";
import type { Range } from "./stats";

/** Saved with every plan, so an old one is read by the rules it was made with. */
export const SIM_VERSION = "11.5.0";

/**
 * Each forecast against its backtest bar (G-GZR11-8; pack §7). `note` is the
 * backtest itself, for internal viewers only: it names stores. `line` is
 * what merchants read. The two that failed open as Beta (pre-Wave-1 pack 2,
 * 2026-10-27): labelled, always with their range, and a "this looks wrong"
 * button.
 */
export const FORECAST_STATUS = {
  cash: {
    passes: false,
    beta: true,
    note: "Backtest 2026-10-20: 78% of payer-weeks inside low–high on both PKR stores (bar 80%).",
    line: "New. Checked against past weeks; real figures landed inside the shown range about 3 times in 4. Tell us when it's off.",
  },
  monthEnd: {
    passes: false,
    beta: true,
    note: "Backtest 2026-10-20: orders 67% / 75% inside low–high, revenue 50% on 0dscam-qn; only 3 months can be tested yet.",
    line: "New. Checked against past months; real order counts landed inside the shown range about 2 times in 3, revenue about half the time. Tell us when it's off.",
  },
  simulator: {
    passes: true,
    beta: false,
    note: "Replay 2026-10-20, one line per platform: 5 of 6 of 0dscam-qn's lines inside low–high, bias 0% (bar 80%, ±15%). Accurate on totals, but the evidence is thin: three dates.",
    line: "Checked against past budgets; accurate on totals so far, on little history.",
  },
} as const;

export type ForecastStatus = (typeof FORECAST_STATUS)[keyof typeof FORECAST_STATUS];

export const HORIZONS = { min: 7, max: 60, default: 30 } as const;

const number = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
};

/** The form as a SimRequest, or what is wrong with it. */
export function parseSimRequest(form: FormData): { request: SimRequest } | { error: string } {
  const budget = number(form.get("budget"));
  if (!(budget > 0) || budget > 1e10) return { error: "Enter a budget above zero." };
  const horizon = form.get("horizon") ? number(form.get("horizon")) : HORIZONS.default;
  if (!Number.isInteger(horizon) || horizon < HORIZONS.min || horizon > HORIZONS.max) return { error: `Days must be a whole number from ${HORIZONS.min} to ${HORIZONS.max}.` };
  const minBuffer = form.get("minBuffer") ? number(form.get("minBuffer")) : 0;
  if (!(minBuffer >= 0) || minBuffer > budget) return { error: "The minimum buffer must be between zero and the budget." };
  const include = { ads: form.get("ads") === "on", stock: form.get("stock") === "on", buffer: form.get("buffer") === "on" };
  if (!include.ads && !include.stock && !include.buffer) return { error: "Pick at least one of ads, stock and a cash buffer." };
  const days = (prefix: string) => {
    const out: Record<string, number> = {};
    for (const [k, v] of form.entries()) {
      if (!k.startsWith(prefix) || String(v).trim() === "") continue;
      const n = number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 365) out[k.slice(prefix.length)] = n;
    }
    return out;
  };
  return {
    request: {
      budget,
      horizonDays: horizon,
      include,
      keepInStock: form.getAll("keep").map(String).filter(Boolean),
      minBuffer,
      excludePlatforms: form.getAll("exclude").map(String).filter(Boolean),
      leadTimes: days("lead:"),
      payoutLags: days("lag:"),
    },
  };
}

/** A plan with every amount taken out, for a viewer without finance:view: orders and dates only. */
export function withoutMoney(plan: Plan): Plan {
  if (plan.status !== "plan") return plan;
  const none = { low: 0, likely: 0, high: 0 };
  return {
    ...plan,
    request: { ...plan.request, budget: 0, minBuffer: 0 },
    lines: plan.lines.map((l) => ({ ...l, amount: 0, profit: none, buys: "", notes: [] })),
    totals: { ...plan.totals, allocated: 0, kept: 0, profit: none },
    assumptions: [],
    leftOut: plan.leftOut.filter((l) => !/\d{3}/.test(l)),
  };
}

// ── "This looks wrong" on the Beta forecasts (pre-Wave-1 pack 2) ────────────

/** A range as the page shows it: whole numbers. */
const shown = (r: Range | null) => (r ? { low: Math.round(r.low), likely: Math.round(r.likely), high: Math.round(r.high) } : null);

/** The cash forecast's figures as shown, for its feedback. The card only renders for a viewer with finance:view. */
export function cashFeedbackInputs(cash: CashForecast) {
  const paid = cash.paid.byPayer.length > 0;
  return {
    asOf: cash.asOf,
    currency: cash.currency,
    weeks: cash.weeks.map((w, i) => ({ from: w.from, to: w.to, due: shown(cash.due.weeks[i]!), paid: paid ? shown(cash.paid.weeks[i]!) : null })),
    untimed: cash.untimed.map((u) => ({ payer: u.payer, deliveredUnpaid: Math.round(u.deliveredUnpaid), expected: shown(u.expected) })),
    overdue: cash.overdue.map((o) => ({ payer: o.payer, amount: Math.round(o.amount), parcels: o.parcels })),
    notTracked: { orders: cash.notTracked.orders, expected: shown(cash.notTracked.expected) },
  };
}

/** The month end's figures as shown, for its feedback: orders always, money only for a viewer with finance:view. */
export function monthEndFeedbackInputs(month: { current: MonthEnd; previous: MonthEnd }, canSeeMoney: boolean) {
  const figures = (x: MonthEnd) => ({
    month: x.month,
    orders: shown(x.orders.total),
    ...(canSeeMoney ? { deliveredRevenue: shown(x.deliveredRevenue), profit: shown(x.profit) } : {}),
  });
  const m = month.current;
  return { day: m.daysElapsed, daysInMonth: m.daysInMonth, ordersSoFar: m.orders.soFar, currency: canSeeMoney ? m.currency : null, current: figures(m), previous: figures(month.previous) };
}
