import { describe, expect, it } from "vitest";

import { MIN_COHORT_BUYERS, resolveBuyer, retention, type DeliveredOrder } from "./cohorts";

// Made-up buyers throughout.
const buyers = (n: number, prefix: string, days: string[]): DeliveredOrder[] =>
  Array.from({ length: n }, (_, i) => days.map((localDay) => ({ customerId: `${prefix}${i}`, localDay }))).flat();

describe("cohort grid", () => {
  it("groups by first delivered month and counts who ordered again in each later month", () => {
    const orders = [
      ...buyers(20, "a", ["2026-07-10", "2026-08-05"]), // all back in month 1
      ...buyers(5, "b", ["2026-07-12", "2026-09-01"]), // back in month 2
      ...buyers(15, "c", ["2026-07-20"]),
      ...buyers(4, "d", ["2026-08-03"]), // a thin cohort
    ];
    const r = retention(orders, "2026-10-06", "2026-07-09");
    expect(r.cohorts.map((c) => [c.month, c.buyers])).toEqual([["2026-07", 40], ["2026-08", 4]]);
    const july = r.cohorts[0]!;
    expect(july.partialFirstMonth).toBe(true);
    expect(july.cells.map((c) => [c.offset, c.buyers, c.share, c.partial])).toEqual([
      [1, 20, 50, false],
      [2, 5, 12.5, false],
      [3, 0, 0, true],
    ]);
    // Under the minimum, the count stays and the share goes.
    expect(r.cohorts[1]!.cells[0]).toMatchObject({ buyers: 0, share: null });
    expect(MIN_COHORT_BUYERS).toBe(20);
    expect(r.maxOffset).toBe(3);
  });

  it("does not count a second order in the first month as coming back", () => {
    const r = retention(buyers(20, "a", ["2026-09-02", "2026-09-20"]), "2026-10-06", null);
    expect(r.cohorts[0]!.cells[0]).toMatchObject({ offset: 1, buyers: 0, partial: true });
  });
});

describe("repeat curve", () => {
  it("counts a buyer toward a window only once they have had that long", () => {
    const orders = [
      ...buyers(20, "a", ["2026-08-01", "2026-08-06"]), // second after 5 days
      ...buyers(20, "b", ["2026-08-01"]),
      ...buyers(30, "c", ["2026-10-01"]), // 5 days old: eligible for no window
    ];
    const r = retention(orders, "2026-10-06", null);
    expect(r.repeat.find((p) => p.days === 7)).toMatchObject({ eligible: 40, repeated: 20, share: 50 });
    expect(r.repeat.find((p) => p.days === 90)).toMatchObject({ eligible: 0, share: null });
    expect(r.medianDaysToSecond).toBe(5);
  });

  it("does not take two orders on one day as a repeat", () => {
    const r = retention(buyers(25, "a", ["2026-08-01", "2026-08-01"]), "2026-10-06", null);
    expect(r.repeat[0]).toMatchObject({ repeated: 0 });
    expect(r.secondOrders).toBe(0);
  });
});

describe("merged buyers", () => {
  it("follows merges to the surviving record", () => {
    const merged = new Map([["x", "y"], ["y", "z"]]);
    expect(resolveBuyer("x", merged)).toBe("z");
    expect(resolveBuyer("q", merged)).toBe("q");
  });
});
