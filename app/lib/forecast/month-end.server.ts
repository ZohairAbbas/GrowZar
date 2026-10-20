import { prisma } from "../db.server";
import { localDayOf } from "../metrics/order-grain";
import { loadForecastBase, type ForecastBase } from "./base.server";
import { monthOf, previousMonth, projectMonth, type MonthEnd } from "./month-end";
import { DAY_MS } from "./stats";

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Ad spend with fees (as Finance's profit counts it) over ad-platform days
 * `from`…`to`, or null unless every day was fetched.
 */
export async function adSpendWithFees(storeId: string, currency: string | null, from: string, to: string): Promise<{ amount: number; days: number } | null> {
  if (to < from || !currency) return null;
  const rows = await prisma.adSpend.findMany({ where: { storeId, level: "day", day: { gte: from, lte: to } }, select: { day: true, spendAmount: true, feesAmount: true, currency: true } });
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (new Set(rows.map((r) => r.day)).size < days) return null;
  const amount = rows.filter((r) => r.currency === currency).reduce((s, r) => s + Number(r.spendAmount) + Number(r.feesAmount), 0);
  return { amount, days };
}

/** This month's projection, and last month's, as the store's data stood at `asOf` (G-GZR11-3). */
export async function monthEnd(storeId: string, asOf: Date = new Date(), base?: ForecastBase): Promise<{ current: MonthEnd; previous: MonthEnd }> {
  const b = base ?? (await loadForecastBase(storeId, asOf));
  const today = localDayOf(asOf, b.timezone);
  const month = monthOf(today);
  const prev = previousMonth(month);
  const prevLast = addDays(`${month}-01`, -1);
  const common = { asOf, today, currency: b.currency, rows: b.rows, odds: b.odds, spreads: b.spreads, financifyOnly: b.parcels.length === 0 };
  return {
    current: projectMonth({ ...common, adSoFar: await adSpendWithFees(storeId, b.currency, `${month}-01`, addDays(today, -1)) }, month),
    previous: projectMonth({ ...common, adSoFar: await adSpendWithFees(storeId, b.currency, `${prev}-01`, prevLast) }, prev),
  };
}
