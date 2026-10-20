import { describe, expect, it } from "vitest";

import type { RollupOrder } from "../metrics/rollups";
import { compare, score, weekdaysBetween } from "./backtest";
import { DeliveryTimes, MIN_CELL, observations, OutcomeOdds, type Observation } from "./outcome-odds";
import { MATURE_DAYS, payoutCycles, type PaidParcel } from "./payout-cycle";
import { bootstrap, quantile, rangeOf, rng } from "./stats";

// Made-up orders and parcels.
const DAY = 86_400_000;
const T = new Date("2026-10-01T00:00:00Z");
const daysBefore = (n: number) => new Date(T.getTime() - n * DAY);
const obs = (n: number, o: Partial<Observation>): Observation[] =>
  Array.from({ length: n }, () => ({ courier: "trax", city: "lahore", delivered: true, decidedAfterDays: 5, ...o }));

describe("ranges", () => {
  it("interpolates quantiles and knows nothing from nothing", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("draws the same numbers from the same seed, so one question never gets two answers", () => {
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("brackets the statistic, and is narrower with more data", () => {
    const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const small = bootstrap([1, 0, 1, 1, 0, 1, 0, 1, 1, 0], mean)!;
    const large = bootstrap(Array.from({ length: 400 }, (_, i) => (i % 5 < 3 ? 1 : 0)), mean)!;
    expect(small.low).toBeLessThanOrEqual(small.likely);
    expect(small.high).toBeGreaterThanOrEqual(small.likely);
    expect(large.likely).toBeCloseTo(0.6);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it("widens rather than leaving the likely figure outside its own range", () => {
    expect(rangeOf([10, 11, 12], 20)).toEqual({ low: expect.any(Number), likely: 20, high: 20 });
    expect(rangeOf([])).toBeNull();
  });
});

describe("outcome odds", () => {
  it("uses the courier × city cell when it has 30 decided orders", () => {
    const odds = new OutcomeOdds([...obs(24, {}), ...obs(6, { delivered: false })]);
    expect(odds.at("Trax", "Lahore")).toEqual({ pDelivered: 0.8, n: 30, level: "courier_city", aged: true });
  });

  it("falls back to the courier, then the store, for a thin cell", () => {
    const odds = new OutcomeOdds([
      ...obs(5, { city: "quetta", delivered: false }),
      ...obs(30, { city: "karachi" }),
      ...obs(30, { courier: "leopards", delivered: false }),
    ]);
    expect(odds.at("trax", "quetta")).toMatchObject({ level: "courier", n: 35 });
    expect(odds.at("postex", "quetta")).toMatchObject({ level: "store", n: 65 });
    expect(new OutcomeOdds(obs(MIN_CELL - 1, {})).at("trax", "lahore")).toBeNull();
  });

  it("gives the whole store's odds on request, not the cell of orders with no courier", () => {
    const odds = new OutcomeOdds([...obs(30, { courier: "unknown", city: "unmapped", delivered: false }), ...obs(30, {})]);
    expect(odds.at(null, null)).toMatchObject({ pDelivered: 0, level: "courier_city" });
    expect(odds.store()).toEqual({ pDelivered: 0.5, n: 60, level: "store", aged: true });
  });

  it("gives an order still open after a week the odds of orders that took longer than a week", () => {
    // Fast ones were delivered; slow ones mostly came back.
    const odds = new OutcomeOdds([
      ...obs(60, { decidedAfterDays: 4 }),
      ...obs(10, { decidedAfterDays: 12 }),
      ...obs(30, { decidedAfterDays: 14, delivered: false }),
    ]);
    expect(odds.at("trax", "lahore", 0)!.pDelivered).toBeCloseTo(0.7);
    expect(odds.at("trax", "lahore", 7)).toEqual({ pDelivered: 0.25, n: 40, level: "courier_city", aged: true });
  });

  it("says when it had to fall back to the odds of a new order", () => {
    const odds = new OutcomeOdds(obs(40, { decidedAfterDays: null }));
    expect(odds.at("trax", "lahore", 7)).toMatchObject({ aged: false, n: 40 });
  });

  it("reads only decided orders placed in the window before the date, and times only courier-timed outcomes", () => {
    const order = (o: Partial<RollupOrder>) => ({ courier: "Trax", city: "Lahore", outcome: "delivered", createdAt: daysBefore(10), outcomeTiming: null, ...o }) as RollupOrder;
    const got = observations(
      [
        order({ outcomeTiming: { basis: "happened_on", at: daysBefore(4) } }),
        order({ outcome: "returned", outcomeTiming: { basis: "status_as_of", at: daysBefore(1) } }),
        order({ outcome: "in_transit" }),
        order({ createdAt: daysBefore(200) }),
        order({ createdAt: new Date(T.getTime() + DAY) }),
      ],
      T,
    );
    expect(got).toEqual([
      { courier: "trax", city: "lahore", delivered: true, decidedAfterDays: 6 },
      { courier: "trax", city: "lahore", delivered: false, decidedAfterDays: null },
    ]);
  });
});

describe("delivery times", () => {
  it("gives days from now for an order already some days old, from deliveries that took longer", () => {
    const times = new DeliveryTimes([...obs(30, { decidedAfterDays: 3 }), ...obs(30, { decidedAfterDays: 9 }), ...obs(10, { delivered: false, decidedAfterDays: 20 })]);
    expect(times.median("trax", "lahore")).toBe(6);
    expect(times.remaining("trax", "lahore", 5)).toMatchObject({ n: 30, level: "courier_city", days: Array(30).fill(4) });
  });
});

describe("payout cycles", () => {
  const parcel = (deliveredDaysAgo: number, paidAfter: number | null, payer = "leopards"): PaidParcel => ({
    payer,
    deliveredAt: daysBefore(deliveredDaysAgo),
    settledAt: paidAfter === null ? null : daysBefore(deliveredDaysAgo - paidAfter),
  });

  it("measures delivered to paid from mature parcels only", () => {
    const parcels = [...Array.from({ length: 30 }, (_, i) => parcel(60 + i, 5 + (i % 5))), parcel(MATURE_DAYS - 1, null), parcel(400, 3)];
    const c = payoutCycles(parcels, T).get("leopards")!;
    expect(c).toMatchObject({ mature: 30, settled: 30, measured: true, median: 7, reason: null });
  });

  it("does not count a payment recorded after the date", () => {
    const c = payoutCycles(Array.from({ length: 40 }, () => parcel(60, 70)), T).get("leopards")!;
    expect(c).toMatchObject({ settled: 0, measured: false, reason: "no settlement has been recorded for its parcels" });
  });

  it("refuses a cycle when too many mature parcels are unpaid (statements not uploaded)", () => {
    const parcels = [...Array.from({ length: 40 }, () => parcel(100, 6, "orio")), ...Array.from({ length: 60 }, () => parcel(MATURE_DAYS + 5, null, "orio"))];
    const c = payoutCycles(parcels, T).get("orio")!;
    expect(c.measured).toBe(false);
    expect(c.reason).toBe(`60% of its parcels delivered over ${MATURE_DAYS} days ago show no payment`);
  });

  it("needs 30 paid parcels", () => {
    expect(payoutCycles(Array.from({ length: 10 }, () => parcel(60, 4)), T).get("leopards")!.reason).toBe("only 10 paid parcels to measure from (30 needed)");
  });
});

describe("backtest", () => {
  const r = (low: number, likely: number, high: number) => ({ low, likely, high });

  it("counts a forecast with nothing behind it, and an actual nobody forecast, as misses", () => {
    const rows = compare("2026-09-07", [{ key: "trax", range: r(80, 100, 120) }, { key: "tcs", range: r(10, 20, 30) }], new Map([["trax", 110], ["leopards", 50]]));
    expect(rows.map((x) => [x.key, x.actual, x.inside])).toEqual([
      ["leopards", 50, false],
      ["tcs", 0, false],
      ["trax", 110, true],
    ]);
  });

  it("scores coverage against the 80% bar, and bias against the actual", () => {
    const inside = Array.from({ length: 8 }, (_, i) => ({ asOf: "d", key: `k${i}`, range: r(0, 11, 20), actual: 10, inside: true }));
    const outside = Array.from({ length: 2 }, (_, i) => ({ asOf: "d", key: `x${i}`, range: r(0, 11, 20), actual: 10, inside: false }));
    const report = score([...inside, ...outside]);
    expect(report).toMatchObject({ tested: 10, coverage: 0.8, passes: true });
    expect(report.bias).toBeCloseTo(0.1);
    expect(score([...inside, ...outside], { maxBias: 0.05 }).passes).toBe(false);
    expect(score([]).passes).toBe(false);
  });

  it("lists the Mondays between two dates", () => {
    expect(weekdaysBetween(new Date("2026-09-02"), new Date("2026-09-21")).map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
  });
});
