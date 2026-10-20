/**
 * The backtest harness every Phase 11 forecast is judged by (G-GZR11-1,
 * pack §5.1). Pure apart from the callbacks it is given.
 *
 * A forecast is run as of past dates, each figure is compared with what then
 * happened, and the report gives:
 *  - coverage: the share of figures whose actual fell inside low–high;
 *  - bias: (Σ likely − Σ actual) / Σ actual, positive when the forecast is
 *    too high.
 *
 * A key the forecast named but nothing happened for counts as an actual of
 * 0; a key that happened but the forecast never named counts as a figure of
 * 0–0–0. Both are misses, never left out.
 */

import type { Range } from "./stats";
import { DAY_MS } from "./stats";

export type Figure = { key: string; range: Range };

export type BacktestRow = { asOf: string; key: string; range: Range; actual: number; inside: boolean };

export type BacktestReport = {
  rows: BacktestRow[];
  tested: number;
  coverage: number | null;
  bias: number | null;
  /** The coverage bar (pack: 80%). */
  bar: number;
  /** The largest bias allowed, when the forecast has one (the simulator: 15% on totals). */
  maxBias: number | null;
  passes: boolean;
};

export const COVERAGE_BAR = 0.8;
const NONE: Range = { low: 0, likely: 0, high: 0 };

/** Compare one date's figures with what happened. */
export function compare(asOf: string, figures: readonly Figure[], actual: ReadonlyMap<string, number>): BacktestRow[] {
  const keys = new Set([...figures.map((f) => f.key), ...actual.keys()]);
  const byKey = new Map(figures.map((f) => [f.key, f.range]));
  return [...keys].sort().map((key) => {
    const range = byKey.get(key) ?? NONE;
    const value = actual.get(key) ?? 0;
    return { asOf, key, range, actual: value, inside: value >= range.low && value <= range.high };
  });
}

export function score(rows: readonly BacktestRow[], { bar = COVERAGE_BAR, maxBias = null }: { bar?: number; maxBias?: number | null } = {}): BacktestReport {
  const tested = rows.length;
  const coverage = tested ? rows.filter((r) => r.inside).length / tested : null;
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  const likely = rows.reduce((s, r) => s + r.range.likely, 0);
  const bias = actual !== 0 ? (likely - actual) / actual : null;
  const passes = coverage !== null && coverage >= bar && (maxBias === null || (bias !== null && Math.abs(bias) <= maxBias));
  return { rows: [...rows], tested, coverage, bias, bar, maxBias, passes };
}

/** Run a forecast at each date and score it. Dates run one after another (the DB pool is small). */
export async function backtest(
  dates: readonly Date[],
  forecast: (asOf: Date) => Promise<Figure[]>,
  actual: (asOf: Date) => Promise<Map<string, number>>,
  opts: { bar?: number; maxBias?: number | null } = {},
): Promise<BacktestReport> {
  const rows: BacktestRow[] = [];
  for (const T of dates) rows.push(...compare(T.toISOString().slice(0, 10), await forecast(T), await actual(T)));
  return score(rows, opts);
}

/** Every `weekday` (0 = Sunday, 1 = Monday) at 00:00 UTC from `from` to `to`, inclusive. */
export function weekdaysBetween(from: Date, to: Date, weekday = 1): Date[] {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  start.setUTCDate(start.getUTCDate() + ((weekday - start.getUTCDay() + 7) % 7));
  const out: Date[] = [];
  for (let t = start.getTime(); t <= to.getTime(); t += 7 * DAY_MS) out.push(new Date(t));
  return out;
}
