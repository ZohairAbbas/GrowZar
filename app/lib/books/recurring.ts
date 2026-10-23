/**
 * When recurring entries fall due. Pure and browser-safe.
 *
 * Occurrence k (k = 0, 1, 2…) is counted from the start date:
 *   weekly   start + 7 × interval × k days
 *   monthly  the start's month + interval × k, on dayOfMonth (29–31 fall back to the month's last day)
 *   yearly   the start's year + interval × k, same month, on dayOfMonth
 * Counting from k (rather than from the previous date) keeps the 31st on the
 * 31st after a short month.
 */

import { addDays } from "./posting";

export const FREQUENCIES = [
  { value: "monthly", label: "Every month" },
  { value: "weekly", label: "Every week" },
  { value: "yearly", label: "Every year" },
] as const;
export type Frequency = (typeof FREQUENCIES)[number]["value"];

export const RECURRING_TYPES = ["expense", "money_in", "transfer", "owner_in", "owner_out", "bill", "invoice", "manual"] as const;

export interface Schedule {
  frequency: Frequency;
  interval: number;
  /** Monthly/yearly day; defaults to the start date's day. */
  dayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Occurrence number k. */
export function occurrence(s: Schedule, k: number): string {
  const y = Number(s.startDate.slice(0, 4));
  const m = Number(s.startDate.slice(5, 7));
  const day = s.dayOfMonth ?? Number(s.startDate.slice(8, 10));
  if (s.frequency === "weekly") return addDays(s.startDate, 7 * s.interval * k);
  const months = s.frequency === "monthly" ? s.interval * k : 12 * s.interval * k;
  const total = m - 1 + months;
  const ty = y + Math.floor(total / 12);
  const tm = (total % 12) + 1;
  return iso(ty, tm, Math.min(day, lastDay(ty, tm)));
}

/** The first occurrence on or after `date` (and on or after the start); null past the end date. */
export function occurrenceOnOrAfter(s: Schedule, date: string): string | null {
  for (let k = 0; k < 5000; k++) {
    const d = occurrence(s, k);
    if (s.endDate && d > s.endDate) return null;
    if (d >= date && d >= s.startDate) return d;
  }
  return null;
}

export function occurrenceAfter(s: Schedule, date: string): string | null {
  return occurrenceOnOrAfter(s, addDays(date, 1));
}

/**
 * Dates to make now: from `next` up to and including `today`, at most `max`
 * (so a rule left paused for years doesn't flood the books), and the next
 * date after them (null when the schedule has ended).
 */
export function dueOccurrences(s: Schedule, next: string | null, today: string, max = 24): { dates: string[]; next: string | null } {
  const dates: string[] = [];
  let cur = next;
  while (cur && cur <= today && dates.length < max) {
    dates.push(cur);
    cur = occurrenceAfter(s, cur);
  }
  return { dates, next: cur };
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "Every month on the 1st", "Every 2 weeks on Monday", "Every year on 15 Mar". */
export function describeSchedule(s: Schedule): string {
  const day = s.dayOfMonth ?? Number(s.startDate.slice(8, 10));
  const every = (unit: string) => (s.interval === 1 ? `Every ${unit}` : `Every ${s.interval} ${unit}s`);
  if (s.frequency === "weekly") return `${every("week")} on ${DAYS[new Date(`${s.startDate}T00:00:00Z`).getUTCDay()]}`;
  if (s.frequency === "monthly") return `${every("month")} on the ${day === 31 ? "last day" : ordinal(day)}`;
  return `${every("year")} on ${day} ${MONTHS[Number(s.startDate.slice(5, 7)) - 1]}`;
}
