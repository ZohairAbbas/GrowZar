/**
 * Plan's pieces that need no database (G-GZR11-6): reading the simulator form,
 * taking money out of a plan for a viewer without finance:view, and where each
 * forecast stands against its backtest. Pure.
 */

import type { Plan, SimRequest } from "./simulator/types";

/** Saved with every plan, so an old one is read by the rules it was made with. */
export const SIM_VERSION = "11.5.0";

/**
 * Each forecast against its backtest bar (G-GZR11-8 approves; pack §7: a
 * forecast that fails stays off for merchants). Internal viewers see it on
 * the page while Plan is internal-only.
 */
export const FORECAST_STATUS = {
  cash: { passes: false, note: "Backtest 2026-10-20: 78% of payer-weeks inside low–high on both PKR stores (bar 80%)." },
  monthEnd: { passes: false, note: "Backtest 2026-10-20: orders 67% / 75% inside low–high, revenue 50% on 0dscam-qn; only 3 months can be tested yet." },
  simulator: { passes: true, note: "Replay 2026-10-20: 89% of 0dscam-qn's lines inside low–high, bias −5% (bar 80%, ±15%); campaign lines +28%, platform groups −20%." },
} as const;

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
