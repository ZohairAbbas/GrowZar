/**
 * The period a screen covers, as it travels in links: `days=30` for one of
 * the presets, or `from=YYYY-MM-DD&to=YYYY-MM-DD` for a custom range. Pure,
 * so the filter bar and every drill-down link build it the same way.
 */

export const PERIODS = [7, 30, 60, 90] as const;
export type PeriodDays = (typeof PERIODS)[number];
/** The longest custom range, in days. */
export const MAX_CUSTOM_DAYS = 366;

export type Period = {
  /** Days in the period, both ends included. */
  days: number;
  from: string;
  to: string;
  /** A custom range rather than one of PERIODS ending today. */
  custom: boolean;
  /** The query parameters that select it: `days=30` or `from=…&to=…`. */
  query: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day as `YYYY-MM-DD` (not 2026-02-30). */
export const isDay = (s: string | null): s is string =>
  s !== null && DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Replace whatever period `q` carries with `period` (a Period's query). */
export function withPeriod(q: URLSearchParams, period: string): URLSearchParams {
  for (const k of ["days", "from", "to"]) q.delete(k);
  for (const [k, v] of new URLSearchParams(period)) q.set(k, v);
  return q;
}

/**
 * A custom range from `from` and `to`, if both are real days in order and
 * the range is at most MAX_CUSTOM_DAYS long. `to` past `today` is pulled
 * back to today. Null otherwise, so the caller falls back to a preset.
 */
export function customRange(from: string | null, to: string | null, today: string): { from: string; to: string } | null {
  if (!isDay(from) || !isDay(to)) return null;
  const end = to > today ? today : to;
  if (from > end || daysBetween(from, end) > MAX_CUSTOM_DAYS) return null;
  return { from, to: end };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "5 Jul 2026", or "5 Jul" without the year. */
export const dayLabel = (s: string, year = true) => `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]}${year ? ` ${s.slice(0, 4)}` : ""}`;

/** "3 Sep – 18 Sep 2026", the year once when both ends share it. */
export function rangeLabel(from: string, to: string): string {
  return `${dayLabel(from, from.slice(0, 4) !== to.slice(0, 4))} – ${dayLabel(to)}`;
}
