/**
 * Books date helpers. Dates are "YYYY-MM-DD" strings in the book's time zone;
 * the books have no time of day.
 */

import { addDays, fiscalYearStart } from "./posting";

/** Today in a time zone, as YYYY-MM-DD. Falls back to UTC for an unknown zone. */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

export const RANGE_PRESETS = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_quarter", label: "Last 3 months" },
  { value: "this_fy", label: "This financial year" },
  { value: "last_fy", label: "Last financial year" },
  { value: "custom", label: "Custom dates" },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]["value"];

export interface DateRange {
  preset: RangePreset;
  from: string;
  to: string;
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "8 Oct 2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = MONTHS.at(Number(iso.slice(5, 7)) - 1) ?? "";
  return `${Number(iso.slice(8, 10))} ${m} ${iso.slice(0, 4)}`;
}

/** "8 Oct" when in the current year, else "8 Oct 2025". */
export function formatShortDate(iso: string | null | undefined, today: string): string {
  if (!iso) return "";
  const m = MONTHS.at(Number(iso.slice(5, 7)) - 1) ?? "";
  return iso.slice(0, 4) === today.slice(0, 4) ? `${Number(iso.slice(8, 10))} ${m}` : formatDate(iso);
}

export function formatRange(from: string, to: string): string {
  return `${formatDate(from)} – ${formatDate(to)}`;
}

export function resolveRange(
  params: { range?: string | null; from?: string | null; to?: string | null },
  today: string,
  fyStartMonth: number,
): DateRange {
  const preset = (RANGE_PRESETS.find((p) => p.value === params.range)?.value ?? "this_month") as RangePreset;
  const label = RANGE_PRESETS.find((p) => p.value === preset)!.label;
  const valid = (s: string | null | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  switch (preset) {
    case "last_month": {
      const prev = addDays(monthStart(today), -1);
      return { preset, from: monthStart(prev), to: monthEnd(prev), label };
    }
    case "this_quarter": {
      const start = monthStart(addDays(monthStart(addDays(monthStart(today), -1)), -1));
      return { preset, from: start, to: today, label };
    }
    case "this_fy":
      return { preset, from: fiscalYearStart(today, fyStartMonth), to: today, label };
    case "last_fy": {
      const thisStart = fiscalYearStart(today, fyStartMonth);
      const lastEnd = addDays(thisStart, -1);
      return { preset, from: fiscalYearStart(lastEnd, fyStartMonth), to: lastEnd, label };
    }
    case "custom": {
      const from = valid(params.from) ? params.from! : monthStart(today);
      const to = valid(params.to) ? params.to! : today;
      return from <= to ? { preset, from, to, label: formatRange(from, to) } : { preset, from: to, to: from, label: formatRange(to, from) };
    }
    default:
      return { preset: "this_month", from: monthStart(today), to: today, label };
  }
}

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Minutes the zone is ahead of UTC at a given instant (Karachi: +300). */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** The UTC instant at which a calendar day starts in a time zone. */
export function zonedDayStart(isoDay: string, timeZone: string | null | undefined): Date {
  const tz = timeZone || "UTC";
  const guess = Date.UTC(Number(isoDay.slice(0, 4)), Number(isoDay.slice(5, 7)) - 1, Number(isoDay.slice(8, 10)));
  let t = guess - zoneOffsetMinutes(tz, new Date(guess)) * 60000;
  // Re-check once for days where the offset changes (daylight saving).
  t = guess - zoneOffsetMinutes(tz, new Date(t)) * 60000;
  return new Date(t);
}

// ── Report columns ───────────────────────────────────────────────────────────

export interface Column {
  label: string;
  from: string;
  to: string;
}

export const COMPARE_OPTIONS = [
  { value: "", label: "No comparison" },
  { value: "months", label: "Month by month" },
  { value: "previous_period", label: "Against the period before" },
  { value: "previous_year", label: "Against the same period last year" },
  { value: "tags", label: "By tag" },
] as const;
export type CompareMode = (typeof COMPARE_OPTIONS)[number]["value"];

export const MAX_MONTH_COLUMNS = 24;

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Move a date by whole months, keeping month-ends as month-ends and clamping (31 Mar − 1 month = 28/29 Feb). */
export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const first = `${ty}-${String(tm + 1).padStart(2, "0")}-01`;
  const end = monthEnd(first);
  if (iso === monthEnd(iso)) return end;
  const day = Math.min(Number(iso.slice(8, 10)), Number(end.slice(8, 10)));
  return `${first.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

function isWholeMonths(from: string, to: string): boolean {
  return from === monthStart(from) && to === monthEnd(to);
}

function monthsSpanned(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

/** Calendar months inside a range (the first and last may be part-months), or null when there are too many. */
export function monthColumns(from: string, to: string, max = MAX_MONTH_COLUMNS): Column[] | null {
  if (monthsSpanned(from, to) > max) return null;
  const cols: Column[] = [];
  for (let start = monthStart(from); start <= to; start = addMonths(start, 1)) {
    const f = start < from ? from : start;
    const e = monthEnd(start) > to ? to : monthEnd(start);
    const whole = f === start && e === monthEnd(start);
    const label = `${SHORT_MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}${whole ? "" : ` (${Number(f.slice(8, 10))}–${Number(e.slice(8, 10))})`}`;
    cols.push({ label, from: f, to: e });
  }
  return cols;
}

/**
 * The period just before. A period starting on the 1st moves back by the
 * months it spans (October → September; 1–13 October → 1–13 September);
 * any other period moves back by its own number of days.
 */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  if (from === monthStart(from)) {
    const n = monthsSpanned(from, to);
    const end = addMonths(to, -n);
    const dayBefore = addDays(from, -1);
    return { from: addMonths(from, -n), to: isWholeMonths(from, to) || end > dayBefore ? dayBefore : end };
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  return { from: addDays(from, -(days + 1)), to: addDays(from, -1) };
}

export function previousYear(from: string, to: string): { from: string; to: string } {
  return { from: addMonths(from, -12), to: addMonths(to, -12) };
}

/** The columns a P&L shows for a range and a comparison choice (null when months would be too many). */
export function compareColumns(from: string, to: string, mode: string): Column[] | null {
  const label = (f: string, t: string) => formatRange(f, t);
  if (mode === "months") return monthColumns(from, to);
  if (mode === "previous_period") {
    const p = previousPeriod(from, to);
    return [{ label: label(from, to), from, to }, { label: label(p.from, p.to), from: p.from, to: p.to }];
  }
  if (mode === "previous_year") {
    const p = previousYear(from, to);
    return [{ label: label(from, to), from, to }, { label: label(p.from, p.to), from: p.from, to: p.to }];
  }
  return [{ label: label(from, to), from, to }];
}
