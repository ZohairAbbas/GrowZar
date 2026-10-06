import { describe, expect, it } from "vitest";

import { coverageLine, coverageReport, type CoverageInput } from "./coverage";
import type { RollupOrder } from "./rollups";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;

function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`,
    localDay: "2026-09-20",
    createdAt: new Date("2026-09-20T06:00:00Z"),
    currency: "PKR",
    placed: pkr("1000.00"),
    delivered: pkr("1000.00"),
    refunded: pkr("0.00"),
    collected: null,
    uncollected: null,
    cogs: pkr("300.00"),
    cogsComplete: true,
    courierFee: pkr("200.00"),
    outcome: "delivered",
    outcomeTiming: { basis: "happened_on", at: new Date("2026-09-23T06:00:00Z") },
    financifyOutcome: "delivered",
    parcelCount: 1,
    courier: "leopards",
    fulfilledVia: null,
    cityRaw: "Lahore",
    city: "Lahore",
    lines: [],
    confirmation: "confirmed",
    customerId: `c${seq}`,
    ...o,
  };
}
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);

function input(rows: RollupOrder[], o: Partial<CoverageInput> = {}): CoverageInput {
  return {
    period: { from: "2026-09-01", to: "2026-09-30" },
    rows,
    connected: ["COURIERIFY", "FINANCIFY"],
    payouts: [{ payer: "leopards", day: "2026-09-28", status: "received" }],
    adSpend: { daysFetched: 30, daysInPeriod: 30 },
    buyers: { total: rows.length, named: rows.length },
    unconvertedOrders: 0,
    ...o,
  };
}

const item = (r: ReturnType<typeof coverageReport>, key: string) => r.items.find((i) => i.key === key);

describe("coverage report", () => {
  it("counts each source over the same rows the screens add up", () => {
    const rows = [
      ...times(8, () => order()),
      order({ courierFee: null }),
      order({ parcelCount: 0, courier: null, city: null, courierFee: null, outcomeTiming: null }),
    ];
    const r = coverageReport(input(rows));
    expect(item(r, "courierify_booking")).toMatchObject({ have: 9, of: 10, status: "partial" });
    expect(item(r, "courier_fees")).toMatchObject({ have: 8, of: 10, status: "partial", gap: "no courier fee on 2 shipped orders" });
    expect(item(r, "cities")).toMatchObject({ have: 9, of: 10 });
    expect(item(r, "cogs")).toMatchObject({ have: 10, of: 10, status: "complete", gap: null });
  });

  it("counts a share of 99% or more as complete", () => {
    const rows = [...times(99, () => order()), order({ courierFee: null })];
    expect(item(coverageReport(input(rows)), "courier_fees")?.status).toBe("complete");
  });

  it("leaves out an item with nothing to count against", () => {
    const rows = times(3, () => order({ outcome: "in_transit", outcomeTiming: null }));
    const r = coverageReport(input(rows));
    expect(item(r, "cogs")).toBeUndefined();
    expect(item(r, "courier_times")).toBeUndefined();
  });

  it("names couriers that delivered but never settled, and a settlement that is not received", () => {
    const rows = [...times(3, () => order()), ...times(2, () => order({ courier: "smartlane" }))];
    const s = item(
      coverageReport(input(rows, { payouts: [{ payer: "leopards", day: "2026-09-30", status: "pending" }] })),
      "settlements",
    );
    expect(s).toMatchObject({ have: 1, of: 2, status: "partial" });
    expect(s?.gap).toBe("no smartlane settlement has ever been recorded in Courierify, so its delivered COD is shown apart rather than as owed; import smartlane's statements in Courierify (Settlements → Import) to track it; leopards last settled 30 Sep 2026 (pending)");
  });

  it("says why deliveries have no courier time", () => {
    const rows = [
      ...times(2, () => order()),
      ...times(3, () => order({ outcomeTiming: { basis: "status_as_of", at: new Date() }, fulfilledVia: "orio", courier: "tcs" })),
    ];
    expect(item(coverageReport(input(rows)), "courier_times")).toMatchObject({
      have: 2,
      of: 5,
      gap: "no courier time on 3 (tcs through Orio)",
    });
  });

  it("asks only connected apps, and says which apps are read in this release", () => {
    const r = coverageReport(input([order()], { connected: ["FINANCIFY", "RETAINIFY"] }));
    expect(item(r, "courier_fees")).toBeUndefined();
    expect(item(r, "cogs")).toBeDefined();
    expect(r.apps.find((a) => a.app === "COURIERIFY")?.state).toBe("not_connected");
    expect(r.apps.find((a) => a.app === "FINANCIFY")?.state).toBe("connected");
    expect(r.apps.find((a) => a.app === "RETAINIFY")?.state).toBe("connected_not_read");
  });

  it("states the campaign attribution gap rather than leaving it to the screen", () => {
    expect(item(coverageReport(input([order()])), "campaign_attribution")).toMatchObject({ status: "missing", have: null });
  });
});

describe("coverage line", () => {
  it("lists only the gaps that touch a section, counted gaps first", () => {
    const rows = [...times(4, () => order()), order({ cogsComplete: false })];
    const r = coverageReport(input(rows));
    const finance = coverageLine(r, "finance").gaps.map((g) => g.key);
    expect(finance[0]).toBe("cogs");
    expect(finance).toContain("bank_receipts");
    expect(finance).not.toContain("cities");
    expect(coverageLine(r, "finance").gaps[0]!.text).toBe("product costs for 4 of 5 delivered orders");
    expect(coverageLine(r, "shipping").gaps).toEqual([]);
  });
});

describe("settlements over time", () => {
  it("counts a courier still holding unpaid COD from before the period", () => {
    const r = coverageReport(input([order()], { owingCouriers: ["smartlane"] }));
    expect(r.items.find((i) => i.key === "settlements")).toMatchObject({ have: 1, of: 2, status: "partial" });
  });
});
