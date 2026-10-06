import { describe, expect, it } from "vitest";

import { courierPerformance, outcomesByDay, parseReason, returnsView, type CourierNote, type ParcelFacts } from "./returns";
import type { RollupOrder } from "./rollups";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-09-20", createdAt: new Date("2026-09-20T00:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: pkr("400.00"), cogsComplete: true, courierFee: null, outcome: "delivered",
    outcomeTiming: { basis: "happened_on", at: new Date("2026-09-23T00:00:00Z") },
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [], confirmation: null, customerId: null, ...o,
  };
}
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);
const returned = (o: Partial<RollupOrder> = {}) => order({ outcome: "returned", delivered: null, ...o });
const parcel = (o: RollupOrder, p: Partial<ParcelFacts> = {}): ParcelFacts => ({
  orderId: o.orderId, courier: o.courier, outcome: o.outcome, returnReceived: false, returnedAt: new Date("2026-09-25T00:00:00Z"), fee: null, ...p,
});
const note = (o: RollupOrder, kind: CourierNote["kind"], raw: string, at = "2026-09-24T00:00:00Z"): CourierNote => ({ orderId: o.orderId, kind, raw, at: new Date(at) });
const asOf = new Date("2026-10-06T12:00:00Z");

describe("reasons in the courier's words", () => {
  it("takes the part after the last dash, and nothing from text with no reason", () => {
    expect(parseReason("Ready for Return in LAHORE - REFUSED WITH NO REASON")).toBe("Refused with no reason");
    expect(parseReason("Pending - NEED HOUSE/FLAT #")).toBe("Need house/flat #");
    expect(parseReason("Ready for Return in  - FAKE ORDER")).toBe("Fake order");
    expect(parseReason("Return To Sender - SELF")).toBeNull();
    expect(parseReason("Being Return")).toBeNull();
    expect(parseReason(null)).toBeNull();
  });
});

describe("what returns cost", () => {
  it("counts fees where recorded, and returns not confirmed back", () => {
    const a = returned();
    const b = returned({ courier: "smartlane" });
    const c = returned();
    const d = returned({ parcelCount: 0, courier: null });
    const rows = [order(), a, b, c, d];
    const v = returnsView(
      rows,
      [parcel(a, { fee: pkr("115.00"), returnedAt: new Date("2026-09-15T00:00:00Z") }), parcel(b, { returnReceived: true }), parcel(c, { returnedAt: new Date("2026-10-01T00:00:00Z") })],
      [note(a, "returned", "Ready for Return in LAHORE - FAKE ORDER"), note(a, "returned", "Ready for Return in LAHORE - REFUSED WITH NO REASON", "2026-09-26T00:00:00Z"), note(c, "returned", "Being Return")],
      "PKR",
      asOf,
    );
    expect(v).toMatchObject({ returned: 4, value: pkr("4000.00"), productCost: pkr("1600.00"), fees: pkr("115.00"), withFee: 1, courierifyReturns: 3 });
    // a and c are not back; a was returned more than 14 days ago.
    expect(v.notReceived).toEqual({ orders: 2, value: pkr("2000.00"), productCost: pkr("800.00"), olderThan14Days: 1 });
    // The latest reason decides for a return.
    expect(v.returnReasons).toEqual([{ reason: "Refused with no reason", orders: 1, couriers: ["leopards"] }]);
    expect(v.byCourier.find((r) => r.courier === "leopards")).toMatchObject({ returned: 2, received: 0, notReceived: 2, withReason: 1, withFee: 1 });
    expect(v.byCourier.find((r) => r.courier === "smartlane")).toMatchObject({ received: 1, notReceived: 0, withReason: 0 });
  });
});

describe("outcomes by order day", () => {
  it("splits each day's orders by what happened, weekly past 31 days", () => {
    const rows = [order({ localDay: "2026-09-02" }), returned({ localDay: "2026-09-02" }), order({ localDay: "2026-09-03", outcome: "in_transit" })];
    const d = outcomesByDay(rows, "2026-09-01", "2026-09-03");
    expect(d.map((x) => [x.label, x.delivered, x.returned, x.open])).toEqual([
      ["2026-09-01", 0, 0, 0], ["2026-09-02", 1, 1, 0], ["2026-09-03", 0, 0, 1],
    ]);
    expect(outcomesByDay(rows, "2026-07-09", "2026-10-06")).toHaveLength(13);
  });
});

describe("courier performance", () => {
  it("reports first-attempt success only for a courier that reports attempts", () => {
    const leo = [...times(20, () => order()), ...times(5, () => returned())];
    const tried = [leo[0]!, leo[1]!, leo[20]!];
    const smart = [...times(20, () => order({ courier: "smartlane" }))];
    const perf = courierPerformance([...leo, ...smart], tried.map((o) => note(o, "attempted", "Pending - CONSIGNEE NOT AVAILABLE")), asOf);
    const l = perf.find((p) => p.courier === "leopards")!;
    expect(l).toMatchObject({ decided: 25, deliveryRate: 80, firstAttempt: 90, returnedAfterAttempt: 20, medianDays: 3, timed: 20 });
    expect(perf.find((p) => p.courier === "smartlane")).toMatchObject({ firstAttempt: null, returnedAfterAttempt: null });
  });
});
