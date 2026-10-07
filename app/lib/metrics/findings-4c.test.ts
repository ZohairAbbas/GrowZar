import { describe, expect, it } from "vitest";

import { deductionFindings, notReceivedFinding, stuckFinding, type FindingsInput } from "./findings";
import { bucketOf, type RollupOrder } from "./rollups";
import type { Statement } from "./settlements";
import type { ParcelFacts } from "./returns";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-09-20", createdAt: new Date("2026-09-20T00:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: pkr("400.00"), cogsComplete: true, courierFee: null, outcome: "delivered", outcomeTiming: null,
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [], confirmation: null, customerId: null, ...o,
  };
}
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);
const asOf = new Date("2026-10-06T12:00:00Z");
const input = (rows: RollupOrder[], o: Partial<FindingsInput> = {}): FindingsInput =>
  ({ currency: "PKR", rows, orders: bucketOf("s", rows), profit: null, adSpend: null, asOf, ...o }) as FindingsInput;

describe("stuck parcels", () => {
  const old = { basis: "status_as_of" as const, at: new Date("2026-09-20T00:00:00Z") };
  it("fires on 5+ Courierify parcels with no status change, and counts them like Finance does", () => {
    const rows = [...times(4, () => order({ outcome: "booked", delivered: null, outcomeTiming: old })), order({ outcome: "in_transit", delivered: null, outcomeTiming: old }), order()];
    const f = stuckFinding(input(rows));
    expect(f).toMatchObject({ kind: "stuck_parcels", booked: 4, inTransit: 1, placed: pkr("5000.00"), oldestDays: 16 });
  });
  it("says nothing under the threshold", () => {
    expect(stuckFinding(input([order({ outcome: "booked", delivered: null, outcomeTiming: old })]))).toMatchObject({ status: "nothing_found" });
  });
});

describe("returns not received", () => {
  it("fires on 5+ returns over 14 days old not marked received", () => {
    const rows = times(6, () => order({ outcome: "returned", delivered: null }));
    const parcels: ParcelFacts[] = rows.map((o, i) => ({
      orderId: o.orderId, courier: "leopards", outcome: "returned", returnReceived: i === 0, returnedAt: new Date("2026-09-10T00:00:00Z"), fee: null,
    }));
    expect(notReceivedFinding(input(rows, { parcels }))).toMatchObject({ kind: "returns_not_received", orders: 5, older: 5, productCost: pkr("2000.00") });
    expect(notReceivedFinding(input(rows, { parcels: parcels.slice(0, 3) }))).toMatchObject({ status: "nothing_found" });
  });
});

describe("unexplained courier deductions", () => {
  const st = (o: Partial<Statement>): Statement => ({
    payer: "leopards", day: "2026-09-30", status: "pending", source: "courier_api", shipments: 310, returned: 0,
    totalCod: pkr("739667.20"), codFees: pkr("0.00"), deliveryFees: pkr("34210.00"), reversalFees: null,
    withholdingTax: pkr("0.00"), miscDeduction: null, carryForward: null, netPaid: pkr("591871.48"), ...o,
  });
  it("fires when a statement keeps 2%+ of COD and 1,000+ without itemizing it", () => {
    const f = deductionFindings(input([], { statements: [st({})], period: { from: "2026-09-07", to: "2026-10-06" } }));
    expect(f).toEqual([expect.objectContaining({ payer: "leopards", unitemized: pkr("113585.72"), unitemizedShare: 15.3 })]);
  });
  it("says nothing when the statement itemizes what it keeps", () => {
    const f = deductionFindings(input([], { statements: [st({ netPaid: pkr("705457.20") })], period: { from: "2026-09-07", to: "2026-10-06" } }));
    expect(f).toMatchObject({ status: "nothing_found" });
  });
});
