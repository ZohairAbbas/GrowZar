import { describe, expect, it } from "vitest";

import { adSpendDaysDue } from "./ad-spend";

const now = new Date("2026-10-22T20:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
// days[i] = i days back, today first.
const days = Array.from({ length: 90 }, (_, i) => `d${String(i).padStart(2, "0")}`);
const base = { days, now, trailing: 3, correctionWindow: 30, backfill: 90, perCycle: 15 };
const allFetched = (h: number) => new Map(days.map((d) => [d, hoursAgo(h)]));

describe("ad-spend days due (D-85)", () => {
  it("refreshes the trailing days hourly, even in quiet hours, and nothing else then", () => {
    expect(adSpendDaysDue({ ...base, fetchedAt: allFetched(2), quiet: true })).toEqual(["d00", "d01", "d02"]);
    expect(adSpendDaysDue({ ...base, fetchedAt: allFetched(0.5), quiet: true })).toEqual([]);
  });

  it("re-reads days 4–30 once their copy is a day old, so a platform's correction arrives", () => {
    const fetchedAt = allFetched(0.5);
    fetchedAt.set("d20", hoursAgo(25));
    fetchedAt.set("d40", hoursAgo(500)); // older than the window: never re-read
    expect(adSpendDaysDue({ ...base, fetchedAt, quiet: false })).toEqual(["d20"]);
  });

  it("puts re-reads before first fetches and keeps one cap for both", () => {
    const fetchedAt = allFetched(30);
    for (let i = 30; i < 90; i += 1) fetchedAt.delete(days[i]!);
    const due = adSpendDaysDue({ ...base, fetchedAt, quiet: false });
    expect(due.slice(0, 3)).toEqual(["d00", "d01", "d02"]);
    expect(due.slice(3)).toEqual(days.slice(3, 18)); // 15 re-reads, no first fetch yet
  });

  it("fetches never-fetched old days once the window is fresh", () => {
    const fetchedAt = allFetched(0.5);
    fetchedAt.delete("d45");
    fetchedAt.delete("d89");
    expect(adSpendDaysDue({ ...base, fetchedAt, quiet: false })).toEqual(["d45", "d89"]);
  });
});
