import { describe, expect, it } from "vitest";

import { describeSchedule, dueOccurrences, occurrence, occurrenceAfter, occurrenceOnOrAfter } from "../recurring";

// Ported from Financify's Books (0cc8732), ledger-views.test.ts "recurring schedule".
describe("recurring schedule", () => {
  const monthly = (start: string, day: number | null = null, extra = {}) => ({ frequency: "monthly" as const, interval: 1, dayOfMonth: day, startDate: start, endDate: null, ...extra });
  it("month-ends: the 31st falls back in short months and comes back after", () => {
    const s = monthly("2026-01-31", 31);
    expect([0, 1, 2, 3].map((k) => occurrence(s, k))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(occurrence(monthly("2027-12-29", 29), 2)).toBe("2028-02-29");
  });
  it("first date on or after the start, and next after a date", () => {
    expect(occurrenceOnOrAfter(monthly("2026-10-13", 1), "2026-10-13")).toBe("2026-11-01");
    expect(occurrenceOnOrAfter(monthly("2026-10-13"), "2026-10-13")).toBe("2026-10-13");
    expect(occurrenceAfter(monthly("2026-10-13"), "2026-10-13")).toBe("2026-11-13");
    const w = { frequency: "weekly" as const, interval: 2, dayOfMonth: null, startDate: "2026-10-05", endDate: null };
    expect(occurrenceAfter(w, "2026-10-05")).toBe("2026-10-19");
    expect(occurrenceAfter({ ...monthly("2026-01-15"), frequency: "yearly" as const }, "2026-01-15")).toBe("2027-01-15");
  });
  it("catching up: due dates up to today, capped, stopping at the end date", () => {
    const s = monthly("2026-01-01", 1);
    expect(dueOccurrences(s, "2026-01-01", "2026-03-15")).toEqual({ dates: ["2026-01-01", "2026-02-01", "2026-03-01"], next: "2026-04-01" });
    expect(dueOccurrences(s, "2026-01-01", "2026-12-31", 2)).toEqual({ dates: ["2026-01-01", "2026-02-01"], next: "2026-03-01" });
    expect(dueOccurrences({ ...s, endDate: "2026-02-15" }, "2026-01-01", "2026-12-31")).toEqual({ dates: ["2026-01-01", "2026-02-01"], next: null });
    expect(dueOccurrences(s, null, "2026-12-31")).toEqual({ dates: [], next: null });
    expect(dueOccurrences(s, "2026-05-01", "2026-04-30")).toEqual({ dates: [], next: "2026-05-01" });
  });
  it("in words", () => {
    expect(describeSchedule(monthly("2026-01-01", 1))).toBe("Every month on the 1st");
    expect(describeSchedule(monthly("2026-01-01", 31))).toBe("Every month on the last day");
    expect(describeSchedule(monthly("2026-01-01", 22))).toBe("Every month on the 22nd");
    expect(describeSchedule(monthly("2026-01-01", 12))).toBe("Every month on the 12th");
    expect(describeSchedule({ frequency: "weekly", interval: 2, dayOfMonth: null, startDate: "2026-10-05", endDate: null })).toBe("Every 2 weeks on Monday");
    expect(describeSchedule({ frequency: "yearly", interval: 1, dayOfMonth: null, startDate: "2026-03-15", endDate: null })).toBe("Every year on 15 Mar");
  });
});
