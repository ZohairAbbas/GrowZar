import { describe, expect, it } from "vitest";

import type { RollupOrder } from "../metrics/rollups";
import { monthActual, previousMonth, projectMonth, volumeLevelSd, type MonthInput } from "./month-end";
import { OutcomeOdds, Spreads, type Observation } from "./outcome-odds";

// Made-up orders: 1,000 PKR each, 400 product cost, 200 courier fee.
const DAY = 86_400_000;
const pkr = (amount: string) => ({ amount, currency: "PKR" });
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const order = (day: string, i: number, o: Partial<RollupOrder> = {}): RollupOrder =>
  ({
    orderId: `${day}-${i}`, localDay: day, createdAt: new Date(`${day}T06:00:00Z`), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: pkr("400.00"), cogsComplete: true, courierFee: pkr("200.00"), outcome: "delivered", outcomeTiming: null, financifyOutcome: null,
    parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "lahore", cityRaw: null, lines: [], confirmation: null, customerId: null,
    ...o,
  }) as RollupOrder;
/** `perDay` orders a day for `days` days before `today`, all delivered. */
const history = (today: string, days: number, perDay: number, o: Partial<RollupOrder> = {}) =>
  Array.from({ length: days }, (_, k) => dayOf(new Date(Date.parse(`${today}T00:00:00Z`) - (k + 1) * DAY))).flatMap((d) => Array.from({ length: perDay }, (_, i) => order(d, i, o)));
const obs = (n: number, delivered = true): Observation[] => Array.from({ length: n }, (_, i) => ({ courier: "leopards", city: "lahore", delivered, decidedAfterDays: 4, week: i % 8 }));

const input = (today: string, rows: RollupOrder[], o: Partial<MonthInput> = {}): MonthInput => ({
  asOf: new Date(`${today}T00:00:00Z`),
  today,
  currency: "PKR",
  rows,
  odds: new OutcomeOdds(obs(60)),
  spreads: new Spreads(obs(60)),
  adSoFar: null,
  financifyOnly: false,
  ...o,
});

describe("month-end projection", () => {
  it("projects a steady store's month exactly: so far plus the same again each day", () => {
    // 10 orders a day for 90 days; on Oct 11, ten days are in and 21 to come (today included).
    const p = projectMonth(input("2026-10-11", history("2026-10-11", 90, 10), { adSoFar: { amount: 10_000, days: 10 } }), "2026-10");
    expect(p).toMatchObject({ daysInMonth: 31, daysElapsed: 10, trend: 1 });
    expect(p.orders).toEqual({ soFar: 100, toCome: r(210), total: r(310) });
    expect(p.deliveredRevenue).toEqual(r(310_000));
    // 400 a delivered order after cost and fee, less 31,000 of ads at the run rate.
    expect(p.adSpend).toEqual({ soFar: 10_000, projected: 31_000 });
    expect(p.profit).toEqual(r(310 * 400 - 31_000));
  });

  it("reads a finished month as it is", () => {
    const rows = history("2026-10-01", 120, 2);
    const p = projectMonth(input("2026-10-11", rows), "2026-09");
    expect(p.orders).toEqual({ soFar: 60, toCome: r(0), total: r(60) });
    expect(p.deliveredRevenue).toEqual(r(60_000));
    expect(monthActual(rows, "2026-09", "PKR", 6_000)).toEqual({ orders: 60, deliveredRevenue: 60_000, profit: 60 * 400 - 6_000, stillOpen: 0 });
  });

  it("resolves an open order at its odds, with a range when they are uncertain", () => {
    const rows = [...history("2026-09-30", 60, 1), order("2026-09-29", 9, { outcome: "in_transit", delivered: null })];
    const sure = projectMonth(input("2026-10-02", rows), "2026-09");
    expect(sure.deliveredRevenue).toEqual(r(30_000));
    const unsure = projectMonth(input("2026-10-02", rows, { odds: new OutcomeOdds([...obs(30), ...obs(30, false)]) }), "2026-09");
    expect(unsure.deliveredRevenue).toMatchObject({ low: 29_000, high: 30_000 });
  });

  it("does not project money from weeks with no delivery recorded, and says why", () => {
    const p = projectMonth(input("2026-10-11", history("2026-10-11", 90, 3, { outcome: "returned", delivered: null })), "2026-10");
    expect(p.deliveredRevenue).toBeNull();
    expect(p.profit).toBeNull();
    expect(p.notes).toContain("no delivery recorded in the last 8 weeks to project revenue from");
  });

  it("gives no profit without every day's ad spend, and flags a store with Financify's outcomes only", () => {
    const p = projectMonth(input("2026-10-11", history("2026-10-11", 90, 1), { financifyOnly: true }), "2026-10");
    expect(p.profit).toBeNull();
    expect(p.notes).toEqual(["outcomes are Financify's alone: this store has no Courierify", "ad spend not fetched for every day so far: profit not projected"]);
  });

  it("bounds the trend: a store that doubled in four weeks is read as up 20%", () => {
    const rows = [...history("2026-10-11", 56, 5), ...history("2026-10-11", 28, 10).map((o) => ({ ...o, orderId: `${o.orderId}b` }))];
    expect(projectMonth(input("2026-10-11", rows), "2026-10").trend).toBe(1.2);
  });
});

describe("volume level spread", () => {
  it("is zero for steady volume or under six weeks, and wider for more weeks ahead when weeks swing", () => {
    expect(volumeLevelSd(history("2026-10-11", 90, 4), "2026-10-11", 3)).toBe(0);
    expect(volumeLevelSd(history("2026-10-11", 30, 4), "2026-10-11", 3)).toBe(0);
    // Alternating busy and quiet weeks.
    const swing = Array.from({ length: 16 }, (_, w) => history(dayOf(new Date(Date.parse("2026-10-11T00:00:00Z") - w * 7 * DAY)), 7, w % 2 ? 2 : 8)).flat();
    const one = volumeLevelSd(swing, "2026-10-11", 1);
    expect(one).toBeGreaterThan(0.5);
    expect(volumeLevelSd(swing, "2026-10-11", 4)).toBeLessThan(one);
  });
});

it("knows the month before January", () => {
  expect(previousMonth("2026-01")).toBe("2025-12");
  expect(previousMonth("2026-10")).toBe("2026-09");
});

function r(n: number) {
  return { low: n, likely: n, high: n };
}
