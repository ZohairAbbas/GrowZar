import { describe, expect, it } from "vitest";

import { MIN_RETURNS_FOR_ONE_SIDED, oneSidedSlices, trackedPayers, withholdOneSided } from "./outcome-sources";
import { payoutAgeing } from "./matrices";
import { bucketOf, type RollupOrder } from "./rollups";
import { coverageReport } from "./coverage";
import { matchesFilter, parseOrderFilter, orderFilterQuery } from "./findings";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-09-20", createdAt: new Date("2026-09-20T06:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: null, cogsComplete: null, courierFee: null, outcome: "delivered",
    outcomeTiming: { basis: "happened_on", at: new Date("2026-09-23T06:00:00Z") },
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [], confirmation: null, customerId: null, ...o,
  };
}
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);

describe("one-sided outcome sources", () => {
  it("finds a carrier with returns and no deliveries, and leaves a two-sided one alone", () => {
    expect(
      oneSidedSlices([
        { courier: "unknown", delivered: 0, returned: 121 },
        { courier: "financify:trax", delivered: 111, returned: 20 },
        { courier: "financify:nk", delivered: 0, returned: MIN_RETURNS_FOR_ONE_SIDED - 1 },
      ]),
    ).toEqual(["unknown"]);
  });

  it("withholds the slice's shipped outcomes so they leave every rate, and keeps Courierify's", () => {
    const rows = [
      ...times(9, () => order()),
      order({ outcome: "returned", delivered: null }),
      ...times(10, () => order({ parcelCount: 0, courier: null, outcome: "returned", delivered: null })),
      order({ parcelCount: 0, courier: null, outcome: "in_transit", delivered: null }),
      order({ parcelCount: 0, courier: null, outcome: "order_cancelled", delivered: null }),
    ];
    const before = bucketOf("s", rows).deliveryRate;
    expect(before.rate).toBeCloseTo(9 / 20);
    const { rows: out, withheld } = withholdOneSided(rows, ["unknown"]);
    expect(withheld).toEqual({ orders: 11, returned: 10, inTransit: 1 });
    const after = bucketOf("s", out).deliveryRate;
    expect(after).toMatchObject({ delivered: 9, returned: 1, stillOpen: 0 });
    expect(after.rate).toBeCloseTo(0.9);
    // A cancellation is not an outcome the source failed to report.
    expect(out.at(-1)!.outcome).toBe("order_cancelled");
    expect(withholdOneSided(rows, []).rows).toEqual(rows);
  });

  it("says so once on the coverage panel, and still counts those orders as shipped outside Courierify", () => {
    const r = coverageReport({
      period: { from: "2026-09-01", to: "2026-09-30" },
      rows: times(10, () => order()),
      connected: ["COURIERIFY", "FINANCIFY"],
      payouts: [{ payer: "leopards", day: "2026-09-28", status: "received" }],
      adSpend: null,
      buyers: { total: 0, named: 0 },
      unconvertedOrders: 0,
      withheld: { orders: 5, returned: 4, inTransit: 1, couriers: ["unknown"] },
    });
    expect(r.items.find((i) => i.key === "one_sided_outcomes")?.gap).toBe(
      "Financify reports returns but never deliveries for orders with no carrier (none in the last 90 days), so 5 orders this period (4 returned, 1 dispatched) have no outcome counted",
    );
    expect(r.items.find((i) => i.key === "courierify_booking")).toMatchObject({ have: 10, of: 15 });
  });
});

describe("untracked couriers", () => {
  const asOf = new Date("2026-10-06T12:00:00Z");
  const unpaid = [
    { courier: "leopards", deliveredAt: new Date("2026-10-01T10:00:00Z"), amount: pkr("100.00") },
    { courier: "smartlane", deliveredAt: new Date("2026-08-20T10:00:00Z"), amount: pkr("700.00") },
    { courier: "smartlane", deliveredAt: new Date("2026-09-20T10:00:00Z"), amount: pkr("300.00") },
  ];

  it("counts as owed only couriers with a settlement on record, and lists the rest apart", () => {
    const a = payoutAgeing(unpaid, "PKR", asOf, trackedPayers(["Leopards"]));
    expect(a.total).toEqual(pkr("100.00"));
    expect(a.couriers.map((c) => c.courier)).toEqual(["leopards"]);
    expect(a.untracked).toEqual([{ courier: "smartlane", total: pkr("1000.00"), orders: 2 }]);
    // Without a tracked set, everything is owed, as before.
    expect(payoutAgeing(unpaid, "PKR", asOf).total).toEqual(pkr("1100.00"));
  });

  it("opens an untracked courier's whole list with no age", () => {
    const f = parseOrderFilter(new URLSearchParams("unpaid=smartlane"));
    expect(f).toEqual({ kind: "unpaid", courier: "smartlane", age: "any" });
    expect(orderFilterQuery(f!)).toBe("unpaid=smartlane");
    const o = order({ courier: "smartlane", uncollected: pkr("50.00"), outcomeTiming: { basis: "happened_on", at: new Date("2026-07-01T00:00:00Z") } });
    expect(matchesFilter(o, f!, "PKR", { asOf })).toBe(true);
  });
});

describe("payer, as I4 has it", () => {
  it("tracks a 3PL's parcels by the 3PL, whichever courier carried them", () => {
    const a = payoutAgeing(
      [
        { courier: "trax", payer: "orio", deliveredAt: new Date("2026-10-01T10:00:00Z"), amount: pkr("100.00") },
        { courier: "trax", payer: "trax", deliveredAt: new Date("2026-10-01T10:00:00Z"), amount: pkr("40.00") },
      ],
      "PKR",
      new Date("2026-10-06T12:00:00Z"),
      trackedPayers(["orio"]),
    );
    expect(a.total).toEqual(pkr("100.00"));
    expect(a.untracked).toEqual([{ courier: "trax", total: pkr("40.00"), orders: 1 }]);
    expect(a.couriers).toMatchObject([{ courier: "trax", paidBy: "orio" }]);
  });
});

describe("untracked list links", () => {
  it("opens a 3PL's whole unpaid list by payer", () => {
    const f = parseOrderFilter(new URLSearchParams("unpaid=orio"))!;
    const viaOrio = order({ courier: "trax", fulfilledVia: "orio", uncollected: pkr("10.00") });
    const direct = order({ courier: "trax", fulfilledVia: null, uncollected: pkr("10.00") });
    expect(matchesFilter(viaOrio, f, "PKR", { asOf: new Date() })).toBe(true);
    expect(matchesFilter(direct, f, "PKR", { asOf: new Date() })).toBe(false);
  });
});
