import { describe, expect, it } from "vitest";

import { customRange, isDay, rangeLabel, withPeriod } from "./period";
import { periodFrom } from "./screens.server";

describe("custom range", () => {
  it("takes two real days in order, pulls the end back to today, and refuses the rest", () => {
    expect(customRange("2026-09-01", "2026-09-15", "2026-10-07")).toEqual({ from: "2026-09-01", to: "2026-09-15" });
    expect(customRange("2026-09-01", "2026-12-31", "2026-10-07")).toEqual({ from: "2026-09-01", to: "2026-10-07" });
    expect(customRange("2026-09-15", "2026-09-01", "2026-10-07")).toBeNull();
    expect(customRange("2026-02-30", "2026-03-01", "2026-10-07")).toBeNull();
    expect(customRange("2025-01-01", "2026-10-07", "2026-10-07")).toBeNull(); // over 366 days
    expect(customRange("2026-09-01", null, "2026-10-07")).toBeNull();
    expect(isDay("2026-9-01")).toBe(false);
  });

  it("swaps the period in a query, keeping everything else", () => {
    expect(withPeriod(new URLSearchParams("days=30&city=Lahore"), "from=2026-09-01&to=2026-09-15").toString()).toBe(
      "city=Lahore&from=2026-09-01&to=2026-09-15",
    );
    expect(withPeriod(new URLSearchParams("from=2026-09-01&to=2026-09-15&courier=tcs"), "days=7").toString()).toBe("courier=tcs&days=7");
  });

  it("labels a range with the year once", () => {
    expect(rangeLabel("2026-09-03", "2026-09-18")).toBe("3 Sep – 18 Sep 2026");
    expect(rangeLabel("2025-12-20", "2026-01-05")).toBe("20 Dec 2025 – 5 Jan 2026");
  });
});

describe("periodFrom", () => {
  const at = new Date("2026-10-07T12:00:00Z");
  it("reads a custom range before days, and falls back to 30 days", () => {
    expect(periodFrom(new URL("http://x/?from=2026-09-01&to=2026-09-15&days=7"), "Asia/Karachi", at)).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-15",
      days: 15,
      custom: true,
      query: "from=2026-09-01&to=2026-09-15",
      today: "2026-10-07",
    });
    expect(periodFrom(new URL("http://x/?days=7"), "Asia/Karachi", at)).toMatchObject({ from: "2026-10-01", to: "2026-10-07", days: 7, custom: false, query: "days=7" });
    expect(periodFrom(new URL("http://x/?days=12&from=bad"), null, at)).toMatchObject({ days: 30, custom: false, query: "days=30" });
  });
});
