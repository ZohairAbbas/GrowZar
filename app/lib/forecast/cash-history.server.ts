import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { payoutsInBank } from "../books-app/bank-receipts.server";
import { cashActuals, forecastCash, type CashForecast } from "./cash";
import { historyRow, mondayOf, type HistoryRow } from "./cash-history";
import type { ForecastBase } from "./base.server";
import { loadForecastBase } from "./base.server";

/** How many past weeks Plan shows. */
export const HISTORY_WEEKS = 4;

/** Keep this week's forecast, once: the first one made in the week stays (D-94). */
export async function keepWeekForecast(storeId: string, cash: CashForecast): Promise<void> {
  const asOf = new Date(cash.asOf);
  await prisma.cashForecastSnapshot.createMany({
    data: [{ storeId, week: new Date(`${mondayOf(asOf)}T00:00:00Z`), asOf, forecast: cash as unknown as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
}

/** The kept forecasts whose first week is over, newest first, against what happened (read from `now`'s data). */
export async function forecastHistory(storeId: string, now: ForecastBase): Promise<HistoryRow[]> {
  const today = now.asOf.toISOString().slice(0, 10);
  const kept = await prisma.cashForecastSnapshot.findMany({ where: { storeId }, orderBy: { week: "desc" }, take: HISTORY_WEEKS + 1 });
  const rows: HistoryRow[] = [];
  for (const k of kept) {
    const f = k.forecast as unknown as CashForecast;
    const w = f.weeks?.[0];
    if (!w || w.to >= today) continue;
    const books = await payoutsInBank(storeId, { from: w.from, to: w.to });
    const bank = books
      ? {
          received: books.payouts.reduce((a, p) => a + (p.inBankOn ? Number(p.net) : 0), 0) / 10 ** books.decimals,
          payouts: books.payouts.length,
          inBank: books.payouts.filter((p) => p.inBankOn).length,
        }
      : null;
    const row = historyRow(f, cashActuals(f, { parcels: now.parcels, rows: now.rows }, f.currency), bank);
    if (row) rows.push(row);
    if (rows.length === HISTORY_WEEKS) break;
  }
  return rows;
}

/**
 * The worker's net under Plan visits (D-94): stores with Courierify whose
 * forecast for this week isn't kept yet get one, so a week nobody opened Plan
 * still has its forecast. One store at a time.
 */
export async function keepDueForecasts(now = new Date(), lagsOf: (storeId: string) => Promise<Record<string, number>>): Promise<number> {
  const week = new Date(`${mondayOf(now)}T00:00:00Z`);
  const stores = await prisma.store.findMany({
    where: { connections: { some: { app: "COURIERIFY", status: "CONNECTED" } }, cashForecasts: { none: { week } } },
    select: { id: true },
  });
  for (const s of stores) {
    const base = await loadForecastBase(s.id, now);
    await keepWeekForecast(s.id, forecastCash(base, { merchantLags: new Map(Object.entries(await lagsOf(s.id))) }));
  }
  return stores.length;
}
