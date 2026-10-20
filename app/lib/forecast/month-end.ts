/**
 * The month-end projection (G-GZR11-3, pack §5.4). Pure.
 *
 * What it projects is the month as Finance will show it once its orders are
 * decided: orders placed in the month, their delivered revenue, and profit
 * after returns (`profitAfterReturns`: delivered revenue − product cost −
 * courier fees − Financify's other costs − ad spend), all by the day the
 * order was placed.
 *
 * - **Orders already placed and decided** count as they are.
 * - **Orders already placed and still open** are delivered or returned at
 *   their courier × city odds for their age.
 * - **Orders still to come**: each remaining day draws one of the last 8
 *   weeks' order counts for that weekday, times the last 4 weeks' trend
 *   (bounded to TREND_BOUNDS), times one volume level per run
 *   (`volumeLevelSd`): volume moves in runs, and drawing days alone gave
 *   0dscam-qn's June 707–893 orders against 527. Each order is a draw from
 *   the store's recent orders whose outcome is known, with that order's
 *   revenue and profit; each run shifts how often a drawn order is a
 *   delivered one by the store's weekly spread, because a month's delivery
 *   rate moves as a whole (0dscam-qn's June).
 * - **Ad spend** at the month's run rate so far.
 *
 * Ranges come from SIMULATIONS seeded runs; each run moves all open orders'
 * odds together (sampling error plus the courier's weekly spread), as the
 * cash forecast does.
 */

import type { Money } from "../metrics/money";
import { bucketOf, profitAfterReturns, type RollupOrder } from "../metrics/rollups";
import { courierKey, type OutcomeOdds, type Spreads } from "./outcome-odds";
import { DAY_MS, daysBetween, DEFAULT_SEED, median, rangeOf, rng, type Range } from "./stats";

export const SIMULATIONS = 1000;
/** The last 4 weeks against the last 8, never read as more than ±20% a month. */
export const TREND_BOUNDS = [0.8, 1.2] as const;
const HISTORY_WEEKS = 8;
/** Recent orders a future order is drawn from: placed 21 to 77 days ago, so their outcomes are known. */
const SAMPLE_MATURE_DAYS = 21;
const OPEN = new Set(["in_transit", "booked", "not_shipped"]);
const DECIDED = new Set(["delivered", "returned", "partially_delivered"]);

export type MonthInput = {
  asOf: Date;
  /** The asOf's local day, YYYY-MM-DD, in the store's timezone. */
  today: string;
  currency: string | null;
  /** Rows as known at asOf (`knownAt`), every month. */
  rows: readonly RollupOrder[];
  odds: OutcomeOdds;
  spreads: Spreads;
  /** Ad spend (with fees) for the month's ad-platform days fetched so far; null when not fetched for every elapsed day. */
  adSoFar: { amount: number; days: number } | null;
  /** True when the store has no Courierify: outcomes are Financify's alone (pack §10, P11-8). */
  financifyOnly: boolean;
};

export type MonthEnd = {
  month: string;
  daysInMonth: number;
  /** Local days of the month before today (today is still being counted). */
  daysElapsed: number;
  currency: string | null;
  orders: { soFar: number; toCome: Range; total: Range };
  /** Null when the last 8 weeks have no delivery recorded to project from (see notes). */
  deliveredRevenue: Range | null;
  /** Null without ad spend for every elapsed day, or without deliveries to project from. */
  profit: Range | null;
  adSpend: { soFar: number; projected: number } | null;
  /** Share of the month's orders expected still undecided on its last day; null without timed outcomes to judge by. */
  unresolvedAtMonthEnd: number | null;
  trend: number;
  /** What the figures do not cover, in words for the screen. */
  notes: string[];
};

const num = (m: Money | null | undefined, currency: string) => (m && m.currency === currency ? Number(m.amount) : 0);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const normal = (next: () => number) => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

/** Revenue and profit (before ad spend) of one order, by Finance's own rules. */
export function valueOf(o: RollupOrder, currency: string): { revenue: number; profit: number } {
  const b = bucketOf("order", [o]);
  return { revenue: num(b.deliveredRevenue.find((m) => m.currency === currency), currency), profit: Number(profitAfterReturns(b, currency, null).amount) };
}

export function projectMonth(input: MonthInput, month: string, { simulations = SIMULATIONS, seed = DEFAULT_SEED } = {}): MonthEnd {
  const { currency, today } = input;
  const first = `${month}-01`;
  const [y, m] = month.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const daysElapsed = today < first ? 0 : today > last ? daysInMonth : Number(today.slice(8, 10)) - 1;
  const notes: string[] = [];
  if (input.financifyOnly) notes.push("outcomes are Financify's alone: this store has no Courierify");

  const cur = currency ?? "";
  const inMonth = input.rows.filter((o) => o.localDay && o.localDay >= first && o.localDay <= last && o.createdAt && o.createdAt < input.asOf);
  const decided = inMonth.filter((o) => !OPEN.has(o.outcome));
  const open = inMonth.filter((o) => OPEN.has(o.outcome));
  const fixed = decided.reduce(
    (s, o) => {
      const v = valueOf(o, cur);
      return { revenue: s.revenue + v.revenue, profit: s.profit + v.profit };
    },
    { revenue: 0, profit: 0 },
  );

  // Courier fees still unknown on open orders take the store's median for that outcome.
  const recent = input.rows.filter((o) => o.createdAt && DECIDED.has(o.outcome) && daysBetween(o.createdAt, input.asOf) <= HISTORY_WEEKS * 7 + SAMPLE_MATURE_DAYS);
  const medianFee = (outcome: string) => {
    const fees = recent.filter((o) => o.outcome === outcome && o.courierFee?.currency === cur).map((o) => Number(o.courierFee!.amount)).sort((a, b) => a - b);
    const v = median(fees);
    return v === null ? null : ({ amount: v.toFixed(2), currency: cur } as Money);
  };
  const fee = { delivered: medianFee("delivered"), returned: medianFee("returned") };

  type Pending = { courier: string; age: number; p: number; sd: number; ifDelivered: { revenue: number; profit: number }; ifReturned: { revenue: number; profit: number } };
  const pending: Pending[] = [];
  let noOdds = 0;
  for (const o of open) {
    const age = daysBetween(o.createdAt!, input.asOf);
    const odds = input.odds.at(o.courier, o.city, age);
    if (!odds) {
      noOdds += 1;
      continue;
    }
    const ps = (odds.pDelivered * odds.n + 1) / (odds.n + 2);
    pending.push({
      courier: courierKey(o.courier),
      age,
      p: odds.pDelivered,
      sd: Math.sqrt((ps * (1 - ps)) / odds.n),
      ifDelivered: valueOf({ ...o, outcome: "delivered", delivered: o.placed, courierFee: o.courierFee ?? fee.delivered }, cur),
      ifReturned: valueOf({ ...o, outcome: "returned", delivered: null, courierFee: o.courierFee ?? fee.returned }, cur),
    });
  }
  if (noOdds) notes.push(`${noOdds} open order(s) without enough history to judge, counted as nothing`);
  const deliveredSoFar = decided.filter((o) => o.outcome === "delivered");
  const noCost = deliveredSoFar.filter((o) => !o.cogsComplete).length;
  if (deliveredSoFar.length && noCost / deliveredSoFar.length > 0.05) notes.push(`product cost incomplete on ${noCost} of ${deliveredSoFar.length} delivered orders: profit reads high`);

  // Order counts by weekday over the last 8 weeks, and the trend.
  const counts = new Map<string, number>();
  for (const o of input.rows) if (o.localDay && o.localDay < today && o.localDay >= addDays(today, -HISTORY_WEEKS * 7)) counts.set(o.localDay, (counts.get(o.localDay) ?? 0) + 1);
  const byWeekday: number[][] = Array.from({ length: 7 }, () => []);
  for (let i = 1; i <= HISTORY_WEEKS * 7; i++) {
    const d = addDays(today, -i);
    byWeekday[weekday(d)]!.push(counts.get(d) ?? 0);
  }
  const last4 = byWeekday.flatMap((w) => w.slice(0, 4)).reduce((a, x) => a + x, 0);
  const all8 = byWeekday.flat().reduce((a, x) => a + x, 0);
  const trend = all8 ? Math.min(TREND_BOUNDS[1], Math.max(TREND_BOUNDS[0], last4 / (all8 / 2))) : 1;
  const futureDays: number[] = [];
  for (let d = today < first ? first : today; d <= last; d = addDays(d, 1)) futureDays.push(weekday(d));
  const levelSd = volumeLevelSd(input.rows, today, futureDays.length / 7);

  // Recent orders whose outcome is known, as the pool a future order is drawn from, split by delivered.
  const sampled = input.rows
    .filter((o) => o.createdAt && !OPEN.has(o.outcome))
    .filter((o) => {
      const age = daysBetween(o.createdAt!, input.asOf);
      return age >= SAMPLE_MATURE_DAYS && age < SAMPLE_MATURE_DAYS + HISTORY_WEEKS * 7;
    });
  const sampleDelivered = sampled.filter((o) => o.outcome === "delivered").map((o) => valueOf(o, cur));
  const sampleOther = sampled.filter((o) => o.outcome !== "delivered").map((o) => valueOf(o, cur));
  const pSample = sampled.length ? sampleDelivered.length / sampled.length : 0;
  const storeSpread = input.spreads.store()?.odds ?? 0;
  // No delivery recorded in the last 8 weeks (yx4fu1-ax before Courierify): money is not projected from nothing.
  const noDeliveries = !sampleDelivered.length;
  if (noDeliveries) notes.push("no delivery recorded in the last 8 weeks to project revenue from");

  const todaySoFar = inMonth.filter((o) => o.localDay === today).length;

  const couriers = [...new Set(pending.map((p) => p.courier))];
  const spread = new Map(couriers.map((c) => [c, input.spreads.of(c)?.odds ?? 0]));
  const next = rng(seed);
  const draws = { toCome: [] as number[], revenue: [] as number[], profit: [] as number[] };
  for (let s = 0; s < simulations; s++) {
    const z = normal(next);
    const shock = new Map(couriers.map((c) => [c, normal(next) * spread.get(c)!]));
    let revenue = fixed.revenue;
    let profit = fixed.profit;
    for (const p of pending) {
      const v = next() < p.p + z * p.sd + shock.get(p.courier)! ? p.ifDelivered : p.ifReturned;
      revenue += v.revenue;
      profit += v.profit;
    }
    let toCome = 0;
    const level = Math.exp(normal(next) * levelSd);
    const pRun = Math.min(1, Math.max(0, pSample + normal(next) * storeSpread));
    futureDays.forEach((w, i) => {
      const hist = byWeekday[w]!;
      let n = Math.round(hist[Math.floor(next() * hist.length)]! * trend * level);
      // Today is still under way: its orders so far are already counted.
      if (i === 0 && today >= first) n = Math.max(0, n - todaySoFar);
      toCome += n;
      if (noDeliveries) return;
      for (let k = 0; k < n; k++) {
        const pool = sampleOther.length && next() >= pRun ? sampleOther : sampleDelivered;
        const v = pool[Math.floor(next() * pool.length)]!;
        revenue += v.revenue;
        profit += v.profit;
      }
    });
    draws.toCome.push(toCome);
    draws.revenue.push(revenue);
    draws.profit.push(profit);
  }

  const adSpend = input.adSoFar && daysElapsed > 0 ? { soFar: input.adSoFar.amount, projected: (input.adSoFar.amount / input.adSoFar.days) * daysInMonth } : null;
  if (!adSpend) notes.push("ad spend not fetched for every day so far: profit not projected");
  const r = (xs: number[]) => rangeOf(xs)!;
  const toCome = r(draws.toCome);
  const soFar = inMonth.length;

  // Expected share of the month's orders still open on its last day: open orders and new ones, by how long decisions take.
  const decideDays = input.rows
    .filter((o) => DECIDED.has(o.outcome) && o.createdAt && (o.outcomeTiming?.basis === "happened_on" || o.outcomeTiming?.basis === "reported_by_3pl"))
    .map((o) => daysBetween(o.createdAt!, o.outcomeTiming!.at))
    .sort((a, b) => a - b);
  const monthEnd = Date.parse(`${addDays(last, 1)}T00:00:00Z`);
  const stillOpen = (ageNow: number, ageAtEnd: number) => {
    const longer = decideDays.filter((d) => d > ageNow);
    return longer.length ? longer.filter((d) => d > ageAtEnd).length / longer.length : 1;
  };
  let unresolved = pending.reduce((a, p) => a + stillOpen(p.age, p.age + (monthEnd - input.asOf.getTime()) / DAY_MS), 0);
  futureDays.forEach((_w, i) => {
    const perDay = toCome.likely / Math.max(1, futureDays.length);
    unresolved += perDay * stillOpen(0, futureDays.length - i - 0.5);
  });
  const total = soFar + toCome.likely;

  return {
    month,
    daysInMonth,
    daysElapsed,
    currency,
    orders: { soFar, toCome, total: { low: soFar + toCome.low, likely: total, high: soFar + toCome.high } },
    deliveredRevenue: noDeliveries ? null : r(draws.revenue),
    profit: adSpend && !noDeliveries ? (({ low, likely, high }) => ({ low: low - adSpend.projected, likely: likely - adSpend.projected, high: high - adSpend.projected }))(r(draws.profit)) : null,
    adSpend,
    unresolvedAtMonthEnd: !decideDays.length ? null : total ? Math.min(1, unresolved / total) : 0,
    trend,
    notes,
  };
}

/** Weeks of order totals the volume level's spread is measured on. */
const LEVEL_WEEKS = 26;

/**
 * The spread (log scale) of the average order volume over the `weeksLeft`
 * weeks still to come. Weekly totals over up to 26 weeks give a week's
 * spread σ and how much one week follows the last (lag-1 autocorrelation ρ,
 * bounded to 0–0.9); the average of k weeks of such a series has variance
 * σ²/k · (1 + 2 Σ_{j<k} (1 − j/k) ρ^j). Zero below 6 weeks of history.
 */
export function volumeLevelSd(rows: readonly RollupOrder[], today: string, weeksLeft: number): number {
  if (weeksLeft <= 0) return 0;
  const counts = new Map<string, number>();
  for (const o of rows) if (o.localDay && o.localDay < today) counts.set(o.localDay, (counts.get(o.localDay) ?? 0) + 1);
  const firstDay = [...counts.keys()].sort()[0];
  const weeks: number[] = [];
  for (let w = 0; w < LEVEL_WEEKS; w++) {
    const start = addDays(today, -7 * (w + 1));
    if (!firstDay || start < firstDay) break;
    let n = 0;
    for (let d = 0; d < 7; d++) n += counts.get(addDays(start, d)) ?? 0;
    weeks.unshift(n);
  }
  const logs = weeks.filter((x) => x > 0).map(Math.log);
  if (logs.length < 6) return 0;
  const mean = logs.reduce((a, x) => a + x, 0) / logs.length;
  const dev = logs.map((x) => x - mean);
  const v = dev.reduce((a, x) => a + x * x, 0) / (logs.length - 1);
  // Steady volume: no spread (and no autocorrelation to divide out).
  if (v < 1e-12) return 0;
  const rho = Math.min(0.9, Math.max(0, dev.slice(1).reduce((a, x, i) => a + x * dev[i]!, 0) / dev.reduce((a, x) => a + x * x, 0)));
  const k = Math.max(1, weeksLeft);
  let f = 1;
  for (let j = 1; j < Math.ceil(k); j++) f += 2 * (1 - j / k) * rho ** j;
  return Math.sqrt((v / k) * f);
}

/** The month a local day falls in, and the one before. */
export const monthOf = (day: string) => day.slice(0, 7);
export const previousMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

/** A month as it actually came out: what the projection is compared with (backtest). */
export function monthActual(rows: readonly RollupOrder[], month: string, currency: string, adSpend: number | null) {
  const list = rows.filter((o) => o.localDay?.startsWith(`${month}-`));
  const b = bucketOf(month, list);
  return {
    orders: list.length,
    deliveredRevenue: num(b.deliveredRevenue.find((m) => m.currency === currency), currency),
    profit: adSpend === null ? null : Number(profitAfterReturns(b, currency, null).amount) - adSpend,
    stillOpen: list.filter((o) => OPEN.has(o.outcome)).length,
  };
}
