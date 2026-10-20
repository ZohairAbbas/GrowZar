import { describe, expect, it } from "vitest";

import type { RollupOrder } from "../metrics/rollups";
import type { Parcel } from "./base.server";
import { cashActuals, cashFigures, forecastCash, rollUp, type CashInput } from "./cash";
import { DeliveryTimes, OutcomeOdds, Spreads, type Observation } from "./outcome-odds";
import { payoutCycles, type PaidParcel } from "./payout-cycle";

// Made-up orders, parcels and history.
const DAY = 86_400_000;
const T = new Date("2026-10-05T00:00:00Z");
const at = (days: number) => new Date(T.getTime() + days * DAY);
const pkr = (amount: string) => ({ amount, currency: "PKR" });
const history = (n: number, o: Partial<Observation> = {}): Observation[] =>
  Array.from({ length: n }, (_, i) => ({ courier: "leopards", city: "lahore", delivered: true, decidedAfterDays: 3, week: i % 6, ...o }));

const order = (orderId: string, o: Partial<RollupOrder> = {}) =>
  ({ orderId, courier: "Leopards", city: "Lahore", outcome: "in_transit", createdAt: at(-1), parcelCount: 1, placed: pkr("1000.00"), fulfilledVia: null, ...o }) as RollupOrder;
const parcel = (orderId: string, o: Partial<Parcel> = {}): Parcel => ({
  orderId, payer: "leopards", status: "in_transit", cod: pkr("1000.00"), bookedAt: at(-1), deliveredAt: null, settledAt: null, ...o,
});
// Leopards pays 5 days after delivery, measured on 40 parcels delivered two months ago.
const paidHistory: PaidParcel[] = Array.from({ length: 40 }, () => ({ payer: "leopards", deliveredAt: at(-60), settledAt: at(-55) }));

const input = (rows: RollupOrder[], parcels: Parcel[], obs: Observation[] = history(60), paid = paidHistory): CashInput => ({
  asOf: T,
  currency: "PKR",
  rows,
  parcels,
  odds: new OutcomeOdds(obs),
  deliveryTimes: new DeliveryTimes(obs, obs),
  spreads: new Spreads(obs),
  payoutCycles: payoutCycles(paid, T),
});

describe("cash forecast", () => {
  it("puts a sure delivery's COD in the week it arrives, and its payout a measured cycle later", () => {
    const f = forecastCash(input([order("1")], [parcel("1")]));
    expect(f.weeks[0]).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    // Delivered 3 days after the order, so 2 days from now; paid 5 days after that, in week 1.
    expect(f.due.byPayer).toEqual([{ payer: "leopards", orders: 1, weeks: [r(1000), r(0), r(0), r(0)], total: r(1000) }]);
    expect(f.paid.byPayer[0]).toMatchObject({ payer: "leopards", basis: "measured", weeks: [r(0), r(1000), r(0), r(0)] });
    expect(f.basis).toEqual({ open: ["1"], held: [] });
  });

  it("forecasts nothing for an order that comes back, with a range when the odds are uncertain", () => {
    const f = forecastCash(input([order("1"), order("2")], [parcel("1"), parcel("2")], [...history(30), ...history(30, { delivered: false })]));
    expect(f.due.total.low).toBeLessThan(f.due.total.likely);
    expect(f.due.total.likely).toBe(1000);
    expect(f.due.total.high).toBe(2000);
  });

  it("gives the same figures for the same inputs", () => {
    const i = input([order("1"), order("2")], [parcel("1"), parcel("2")], [...history(30), ...history(30, { delivered: false })]);
    expect(forecastCash(i)).toEqual(forecastCash(i));
  });

  it("shows a payer without a measured cycle apart, with what it holds and what is coming", () => {
    const held = parcel("9", { payer: "smartlane", status: "delivered", deliveredAt: at(-10) });
    const f = forecastCash(input([order("1")], [parcel("1", { payer: "smartlane" }), held], history(60), []));
    expect(f.paid.byPayer).toEqual([]);
    expect(f.untimed).toEqual([
      { payer: "smartlane", basis: "unknown", reason: "no settlement has been recorded for its parcels", deliveredUnpaid: 1000, deliveredParcels: 1, expected: r(1000) },
    ]);
  });

  it("dates a payer's payouts by the merchant's own lag, labelled as theirs", () => {
    const f = forecastCash(input([order("1")], [parcel("1", { payer: "smartlane" })], history(60), []), { merchantLags: new Map([["smartlane", 9]]) });
    expect(f.paid.byPayer[0]).toMatchObject({ payer: "smartlane", basis: "merchant", reason: "your estimate", weeks: [r(0), r(1000), r(0), r(0)] });
  });

  it("calls COD older than anything the payer's cycle has taken overdue, not coming", () => {
    const f = forecastCash(input([], [parcel("9", { status: "delivered", deliveredAt: at(-30) })]));
    expect(f.overdue).toEqual([{ payer: "leopards", amount: 1000, parcels: 1 }]);
    expect(f.paid.total).toEqual(r(0));
  });

  it("lists open orders without a Courierify parcel apart, and leaves out other currencies", () => {
    const f = forecastCash(input([order("1", { parcelCount: 0 }), order("2", { parcelCount: 0, placed: { amount: "50.00", currency: "AED" } })], []));
    expect(f.notTracked).toEqual({ orders: 1, expected: r(1000) });
    expect(f.excluded.otherCurrency).toBe(1);
    expect(f.due.byPayer).toEqual([]);
  });

  it("does not count a parcel delivered by the date twice", () => {
    const f = forecastCash(input([order("1")], [parcel("1", { status: "delivered", deliveredAt: at(-1) })]));
    expect(f.basis).toEqual({ open: [], held: ["1"] });
  });
});

describe("cash backtest actuals", () => {
  it("counts what the forecast's own orders delivered and were paid, by week, on the courier's clock", () => {
    const f = forecastCash(input([order("1"), order("2")], [parcel("1"), parcel("2")]));
    const now = {
      rows: [order("1", { outcome: "delivered", outcomeTiming: { basis: "happened_on", at: at(8) } }), order("2", { outcome: "delivered" }), order("3", { outcome: "delivered" })],
      parcels: [
        parcel("1", { status: "delivered", deliveredAt: at(9), settledAt: at(13) }),
        parcel("2", { status: "delivered", deliveredAt: at(2), settledAt: at(40) }),
        parcel("3", { status: "delivered", deliveredAt: at(2), settledAt: at(3) }),
      ],
    };
    const actual = cashActuals(f, now, "PKR");
    expect(Object.fromEntries(actual)).toEqual({ "due|leopards|0": 1000, "due|leopards|1": 1000, "paid|leopards|1": 1000 });
    expect(Object.fromEntries(rollUp(actual, "payer_total"))).toEqual({ "due|leopards|all": 2000, "paid|leopards|all": 1000 });
    expect(cashFigures(f, "store_week").map((x) => x.key)).toContain("paid|all|3");
  });
});

function r(n: number) {
  return { low: n, likely: n, high: n };
}
