/**
 * When the weekly digest goes out (G-GZR6-5, decided 2026-10-14): Mondays
 * from 09:00 in the recipient's store's own timezone. The worker checks
 * every few minutes, so a digest missed at 09:00 (worker restarting, a deploy)
 * still goes later that Monday, and never on another day.
 */
export const SEND_WEEKDAY = 1; // Monday, ISO numbering
export const SEND_HOUR = 9;

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The local date (YYYY-MM-DD), ISO weekday and hour at `at` in `timezone`. */
export function localParts(at: Date, timezone: string): { date: string; weekday: number; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAYS[parts.weekday!] ?? 0, hour: Number(parts.hour) };
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The Monday on or before `at`, local to `timezone`: the week's key in the send log. */
export function weekOf(at: Date, timezone: string): string {
  const { date, weekday } = localParts(at, timezone);
  return addDays(date, -((weekday - SEND_WEEKDAY + 7) % 7));
}

/** Is it Monday, 09:00 or later, in `timezone`? */
export function isSendTime(at: Date, timezone: string): boolean {
  const { weekday, hour } = localParts(at, timezone);
  return weekday === SEND_WEEKDAY && hour >= SEND_HOUR;
}

/** "Monday 19 October" for a YYYY-MM-DD. */
export const weekLabel = (monday: string) =>
  new Date(`${monday}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** The local Monday the next digest goes out: today if it is Monday before 09:00, else the coming Monday. */
export function nextSendDay(at: Date, timezone: string): string {
  const { weekday, hour } = localParts(at, timezone);
  const monday = weekOf(at, timezone);
  return weekday === SEND_WEEKDAY && hour < SEND_HOUR ? monday : addDays(monday, 7);
}
