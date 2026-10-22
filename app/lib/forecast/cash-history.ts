/**
 * Earlier cash forecasts against what happened (D-94). Pure.
 *
 * Plan keeps the forecast it made at the start of each week. Once that week
 * is over, its first week is shown against what then happened, read from
 * today's data the way the backtest reads it (`cashActuals`): COD delivered,
 * COD paid out by payers whose cycle was measured (Courierify), and, where
 * the store's books have bank statements matched, the courier payouts dated
 * that week that reached the bank (Books, net of the couriers' charges).
 */
import type { CashForecast } from "./cash";
import type { Range } from "./stats";

const DAY_MS = 86_400_000;

/** The Monday (UTC) of a day's week, as YYYY-MM-DD: the key a week's forecast is kept under. */
export function mondayOf(d: Date): string {
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const back = (new Date(day0).getUTCDay() + 6) % 7;
  return new Date(day0 - back * DAY_MS).toISOString().slice(0, 10);
}

export type BankWeek = { received: number; payouts: number; inBank: number };

export type HistoryRow = {
  from: string;
  to: string;
  due: Range;
  dueActual: number;
  /** Null when no payer's cycle was measured then: nothing was forecast by week. */
  paid: Range | null;
  paidActual: number | null;
  /** Null when Books can't tell (no book, Books off, no statement matched). */
  bank: BankWeek | null;
};

/** One kept forecast's first week against what happened. */
export function historyRow(f: CashForecast, actual: ReadonlyMap<string, number>, bank: BankWeek | null): HistoryRow | null {
  const w = f.weeks[0];
  const due = f.due.weeks[0];
  if (!w || !due) return null;
  let dueActual = 0;
  let paidActual = 0;
  for (const [key, v] of actual) {
    const [kind, , k] = key.split("|");
    if (k !== "0") continue;
    if (kind === "due") dueActual += v;
    else if (kind === "paid") paidActual += v;
  }
  const measured = f.paid.byPayer.some((p) => p.basis === "measured");
  return { from: w.from, to: w.to, due, dueActual, paid: measured ? (f.paid.weeks[0] ?? null) : null, paidActual: measured ? paidActual : null, bank };
}
