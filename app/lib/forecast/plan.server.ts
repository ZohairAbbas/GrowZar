import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { loadForecastBase } from "./base.server";
import { forecastCash, type CashForecast } from "./cash";
import type { HistoryRow } from "./cash-history";
import { forecastHistory, keepWeekForecast } from "./cash-history.server";
import { monthEnd } from "./month-end.server";
import type { MonthEnd } from "./month-end";
import { SIM_VERSION } from "./plan-form";
import { MIN_PAYER_SHARE } from "./simulator/gate";
import { simulate } from "./simulator/plan";
import { loadSimData } from "./simulator/simulator.server";
import type { Plan, SimData, SimRequest } from "./simulator/types";
import { ADVANCE_LOSS, requireAdvance, switchCourier, type WhatIf } from "./simulator/whatif";

/**
 * Plan's data (G-GZR11-6, pack §5.6): the cash forecast and month-end
 * projection for the active store, the simulator's form options, saved plans,
 * and the what-ifs on a saved plan. Ask's tools (G-GZR11-7) call the same.
 */

const SIM_CACHE_MS = 3 * 60_000;
const simCache = new Map<string, { at: number; data: SimData }>();

/** Today's simulator data for a store, cached for three minutes. */
export async function simDataNow(storeId: string): Promise<SimData> {
  const hit = simCache.get(storeId);
  if (hit && Date.now() - hit.at < SIM_CACHE_MS) return hit.data;
  const data = await loadSimData(storeId, new Date());
  simCache.set(storeId, { at: Date.now(), data });
  return data;
}

/** The lags the merchant gave in their last plan for this store, to reuse in the form and the cash forecast. */
export async function lastLags(storeId: string): Promise<Record<string, number>> {
  const last = await prisma.plan.findFirst({ where: { storeId }, orderBy: { createdAt: "desc" }, select: { inputs: true } });
  const lags = (last?.inputs as SimRequest | null)?.payoutLags;
  return lags && typeof lags === "object" ? lags : {};
}

export async function forecasts(storeId: string): Promise<{ cash: CashForecast; month: { current: MonthEnd; previous: MonthEnd }; history: HistoryRow[] }> {
  const now = new Date();
  const base = await loadForecastBase(storeId, now);
  const lags = await lastLags(storeId);
  const cash = forecastCash(base, { merchantLags: new Map(Object.entries(lags)) });
  // D-94: the week's first forecast is kept, and earlier weeks' are shown against what happened.
  await keepWeekForecast(storeId, cash);
  return { cash, month: await monthEnd(storeId, now, base), history: await forecastHistory(storeId, base) };
}

export type FormOptions = {
  currency: string;
  platforms: string[];
  /** Payers whose payout lag the merchant must give (P11-5), with last plan's value. */
  lags: Array<{ payer: string; share: number; reason: string | null; last: number | null }>;
  /** The best-selling products, for "keep in stock" and their lead times. */
  products: Array<{ variantId: string; title: string; lead: number | null; leadSource: string | null; cover: number | null }>;
  cities: string[];
  couriers: string[];
  hasStock: boolean;
};

export async function formOptions(storeId: string): Promise<FormOptions> {
  const data = await simDataNow(storeId);
  const lags = await lastLags(storeId);
  const count = <T,>(xs: T[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>())].sort((a, b) => b[1] - a[1]).map(([x]) => x);
  const recent = data.orders.filter((o) => o.createdAt.getTime() > data.asOf.getTime() - 90 * 86_400_000);
  return {
    currency: data.currency,
    platforms: [...new Set(data.spend.map((s) => s.platform))].sort(),
    lags: data.payers
      .filter((p) => p.basis !== "measured" && p.share >= MIN_PAYER_SHARE)
      .map((p) => ({ payer: p.payer, share: p.share, reason: p.reason, last: lags[p.payer] ?? null })),
    products: (data.stock ?? [])
      .filter((s) => s.netPerDay > 0)
      .sort((a, b) => b.netPerDay - a.netPerDay)
      .slice(0, 12)
      .map((s) => ({ variantId: s.variantId, title: s.title, lead: s.leadTimeDays, leadSource: s.leadSource, cover: s.netPerDay > 0 ? Math.floor((s.stock + s.onOrder) / s.netPerDay) : null })),
    cities: count(recent.map((o) => o.city).filter((c): c is string => !!c)).slice(0, 15),
    couriers: count(recent.map((o) => o.courier).filter((c): c is string => !!c)).slice(0, 8),
    hasStock: data.stock !== null,
  };
}

/** Run the simulator on today's data and save the plan (or its refusal). */
export async function runAndSave(storeId: string, organizationId: string, userId: string, request: SimRequest): Promise<string> {
  const data = await loadSimData(storeId, new Date());
  simCache.set(storeId, { at: Date.now(), data });
  const plan = simulate(data, request);
  const row = await prisma.plan.create({
    data: {
      storeId, organizationId, createdById: userId, asOf: data.asOf, version: SIM_VERSION, status: plan.status,
      inputs: request as unknown as Prisma.InputJsonValue,
      output: plan as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return row.id;
}

export async function savedPlans(storeId: string) {
  return prisma.plan.findMany({ where: { storeId }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, createdAt: true, status: true, inputs: true } });
}

export async function savedPlan(storeId: string, id: string): Promise<(Plan & { id: string; createdAt: string; version: string }) | null> {
  const row = await prisma.plan.findFirst({ where: { id, storeId } });
  return row ? { ...(row.output as unknown as Plan), id: row.id, createdAt: row.createdAt.toISOString(), version: row.version } : null;
}

export type WhatIfAsk = { kind: "switch"; city: string; from: string; to: string } | { kind: "advance"; city: string; loss: number };

export function parseWhatIf(params: URLSearchParams): WhatIfAsk | null {
  const city = params.get("city")?.trim();
  if (!city) return null;
  if (params.get("whatif") === "switch") {
    const from = params.get("from")?.trim();
    const to = params.get("to")?.trim();
    return from && to && from !== to ? { kind: "switch", city, from, to } : null;
  }
  if (params.get("whatif") === "advance") {
    const loss = Number(params.get("loss") ?? ADVANCE_LOSS.likely * 100) / 100;
    return Number.isFinite(loss) && loss >= 0 && loss < 1 ? { kind: "advance", city, loss } : null;
  }
  return null;
}

/** A what-if on a saved plan, against today's data. */
export async function whatIfOn(storeId: string, plan: Plan, ask: WhatIfAsk): Promise<WhatIf> {
  const data = await simDataNow(storeId);
  if (ask.kind === "switch") return switchCourier(plan, data, ask.city, ask.from, ask.to);
  // The merchant's likely loss, with the range kept 15 points either side (P11-11).
  return requireAdvance(plan, data, ask.city, { low: Math.min(0.95, ask.loss + 0.15), likely: ask.loss, high: Math.max(0, ask.loss - 0.15) });
}
