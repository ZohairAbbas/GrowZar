import { describe, expect, it } from "vitest";
import { formatDate, monthEnd, resolveRange, todayIn } from "../dates";
import { csvCell } from "../report-data.server";

describe("resolveRange", () => {
  const r = (range: string, today: string, fy = 7, from?: string, to?: string) => resolveRange({ range, from, to }, today, fy);
  it("this and last month, across a year boundary", () => {
    expect(r("this_month", "2026-01-15")).toMatchObject({ from: "2026-01-01", to: "2026-01-15" });
    expect(r("last_month", "2026-01-15")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(r("last_month", "2026-03-31")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(r("last_month", "2028-03-01")).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
  });
  it("last 3 months starts two months back", () => {
    expect(r("this_quarter", "2026-01-15")).toMatchObject({ from: "2025-11-01", to: "2026-01-15" });
  });
  it("financial years (July start, and January start)", () => {
    expect(r("this_fy", "2026-03-10")).toMatchObject({ from: "2025-07-01", to: "2026-03-10" });
    expect(r("last_fy", "2026-03-10")).toMatchObject({ from: "2024-07-01", to: "2025-06-30" });
    expect(r("last_fy", "2026-07-01")).toMatchObject({ from: "2025-07-01", to: "2026-06-30" });
    expect(r("this_fy", "2026-03-10", 1)).toMatchObject({ from: "2026-01-01" });
  });
  it("custom dates: swapped are put in order, junk falls back", () => {
    expect(r("custom", "2026-10-08", 7, "2026-10-05", "2026-09-01")).toMatchObject({ from: "2026-09-01", to: "2026-10-05" });
    expect(r("custom", "2026-10-08", 7, "nope", "")).toMatchObject({ from: "2026-10-01", to: "2026-10-08" });
  });
  it("unknown presets mean this month", () => {
    expect(r("garbage", "2026-10-08")).toMatchObject({ preset: "this_month", from: "2026-10-01" });
  });
});

describe("todayIn / formatting", () => {
  it("uses the merchant's zone (Karachi is UTC+5)", () => {
    const lateUtc = new Date("2026-10-08T20:30:00Z");
    expect(todayIn("Asia/Karachi", lateUtc)).toBe("2026-10-09");
    expect(todayIn("UTC", lateUtc)).toBe("2026-10-08");
    expect(todayIn("Not/AZone", lateUtc)).toBe("2026-10-08");
    expect(todayIn(undefined, lateUtc)).toBe("2026-10-08");
  });
  it("month ends and labels", () => {
    expect(monthEnd("2026-02-10")).toBe("2026-02-28");
    expect(monthEnd("2026-12-10")).toBe("2026-12-31");
    expect(formatDate("2026-10-08")).toBe("8 Oct 2026");
    expect(formatDate(null)).toBe("");
  });
});

describe("csvCell", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });
  it("defuses formulas in names but leaves numbers alone", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("-1250.50")).toBe("-1250.50");
    expect(csvCell("-bad")).toBe("'-bad");
    expect(csvCell("Rent")).toBe("Rent");
  });
});
