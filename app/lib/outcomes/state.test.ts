import { describe, expect, it } from "vitest";

import type { RollupOrder } from "../metrics/rollups";
import type { Statement } from "../metrics/settlements";
import { rateEffect, timing, verdictOf } from "./measure";
import { windowsOf } from "./groups";
import {
  cashFollowed,
  deductionsOutcome,
  followChecks,
  followVerdict,
  rateTally,
  receivedFollowed,
  stockoutOutcome,
  stuckFollowed,
} from "./state";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-07-01", createdAt: new Date("2026-07-01T08:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: null, collected: null, uncollected: null,
    cogs: pkr("400.00"), cogsComplete: true, courierFee: pkr("200.00"), outcome: "delivered", outcomeTiming: null,
    financifyOutcome: null, parcelCount: 1, courier: "leopards", fulfilledVia: null, city: "Lahore", cityRaw: "Lahore",
    lines: [], confirmation: null, customerId: null, ...o,
  };
}
const ACTED = new Date("2026-08-01T10:00:00Z");
const day = (n: number) => new Date(ACTED.getTime() + n * 86_400_000);

describe("following the saved orders", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ orderId: `c${i}`, money: pkr("1000.00") }));
  const settled = (at: Date | null) => [{ status: "delivered", settlement: at ? { settled: true, settledAt: at.toISOString() } : { settled: false } }];

  it("cash: paid by settlement date, with the amount paid, checked on days 7, 14 and 28", () => {
    const parcels = new Map(items.map((it, i) => [it.orderId, settled(i < 3 ? day(5) : i < 9 ? day(20) : null)]));
    const checks = followChecks(cashFollowed(items, parcels), ACTED, day(30), "PKR");
    expect(checks.map((c) => [c.day, c.resolved, c.amount])).toEqual([
      [7, 3, "3000.00"],
      [14, 3, "3000.00"],
      [28, 9, "9000.00"],
    ]);
    expect(followVerdict(checks, items.length)).toBe("improved");
  });
  it("cash (D-93): with Books' bank statements, a paid order also says whether its payout reached the bank; paid either way", () => {
    const parcels = new Map(items.map((it, i) => [it.orderId, [{ status: "delivered", settlement: i < 6 ? { settled: true, settledAt: day(5).toISOString(), settlementId: i < 4 ? "s-in-bank" : "s-not-yet" } : { settled: false } }]]));
    const followed = cashFollowed(items, parcels, new Set(["s-in-bank"]));
    expect(followed.map((f) => [!!f.resolvedAt, f.inBank])).toEqual([...Array(4).fill([true, true]), ...Array(2).fill([true, false]), ...Array(4).fill([false, false])]);
    const [c7] = followChecks(followed, ACTED, day(30), "PKR");
    expect(c7).toMatchObject({ day: 7, resolved: 6, amount: "6000.00", inBankAmount: "4000.00" });
    // Without Books nothing about the bank is said, and the measurement is as before.
    expect(followChecks(cashFollowed(items, parcels), ACTED, day(30), "PKR")[0]).not.toHaveProperty("inBankAmount");
  });
  it("cash: an order is paid only when every delivered parcel on it is settled", () => {
    const parcels = new Map([["c0", [...settled(day(2)), ...settled(null)]]]);
    expect(cashFollowed([items[0]!], parcels)[0]!.resolvedAt).toBeNull();
  });
  it("bands: partly, no change, too early, and nothing to follow", () => {
    const some = new Map(items.map((it, i) => [it.orderId, settled(i < 5 ? day(3) : null)]));
    expect(followVerdict(followChecks(cashFollowed(items, some), ACTED, day(29), "PKR"), 10)).toBe("partly");
    const few = new Map(items.map((it, i) => [it.orderId, settled(i < 1 ? day(3) : null)]));
    expect(followVerdict(followChecks(cashFollowed(items, few), ACTED, day(29), "PKR"), 10)).toBe("no_change");
    expect(followVerdict(followChecks(cashFollowed(items, few), ACTED, day(20), "PKR"), 10)).toBe("too_early");
    expect(followVerdict(followChecks([], ACTED, day(29), "PKR"), 0)).toBe("not_enough_data");
  });
  it("returns: received by date, a received return without a date counted as of now, money the product cost", () => {
    const a = order({ outcome: "returned", lines: [{ variantId: "v", productId: "p", quantity: 1, value: pkr("1000.00"), cost: pkr("350.00") }] });
    const b = order({ outcome: "returned" });
    const parcels = new Map([
      [a.orderId, [{ status: "returned", returnReceived: true, returnReceivedAt: day(4).toISOString() }]],
      [b.orderId, [{ status: "returned", returnReceived: true, returnReceivedAt: null }]],
    ]);
    const f = receivedFollowed([{ orderId: a.orderId }, { orderId: b.orderId }], parcels, new Map([[a.orderId, a], [b.orderId, b]]), "PKR", day(30));
    expect(f.map((x) => x.resolvedAt)).toEqual([day(4), day(30)]);
    expect(f[0]!.money).toEqual(pkr("350.00"));
    const checks = followChecks(f, ACTED, day(30), "PKR");
    expect(checks.map((c) => c.resolved)).toEqual([1, 1, 1]); // the undated one only counts from now
  });
  it("stuck parcels: moved when delivered or returned, split by which", () => {
    const d = order({ outcome: "delivered", outcomeTiming: { basis: "happened_on", at: day(3) } });
    const r = order({ outcome: "returned", outcomeTiming: { basis: "happened_on", at: day(10) } });
    const s = order({ outcome: "in_transit", delivered: null });
    const f = stuckFollowed([d, r, s].map((o) => ({ orderId: o.orderId })), new Map([d, r, s].map((o) => [o.orderId, o])));
    const checks = followChecks(f, ACTED, day(28), null);
    expect(checks.at(-1)).toMatchObject({ day: 28, resolved: 2, total: 3, how: { delivered: 1, returned: 1 }, amount: null });
    expect(followVerdict(checks, 3)).toBe("partly");
  });
});

describe("before/after rates against the store's own earlier rate", () => {
  const W = windowsOf("2026-08-01");
  const later = new Date("2026-10-15T00:00:00Z");
  const at = (d: string) => ({ localDay: d, createdAt: new Date(`${d}T08:00:00Z`) });
  it("missing fees: fewer Courierify parcels without a fee after acting is an improvement", () => {
    const orders = [
      ...Array.from({ length: 100 }, (_, i) => order({ ...at("2026-07-01"), courierFee: i < 40 ? null : pkr("200.00") })),
      ...Array.from({ length: 100 }, (_, i) => order({ ...at("2026-08-10"), courierFee: i < 5 ? null : pkr("200.00") })),
      order({ ...at("2026-08-10"), parcelCount: 0, courierFee: null }), // outside Courierify: not this card's
    ];
    const t = rateTally("missing_courier_fees", orders, W, later);
    expect(t.before.subject).toMatchObject({ delivered: 60, returned: 40 });
    expect(t.after.subject).toMatchObject({ delivered: 95, returned: 5 });
    const e = rateEffect(t.before, t.after, "share_missing_fee");
    expect(verdictOf(e, timing(ACTED, W.after.to, "2026-10-15", later, e.progress))).toBe("improved");
  });
  it("missing fees: a recent order's fee may still come, so it is open", () => {
    const t = rateTally("missing_courier_fees", [order({ ...at("2026-08-10"), courierFee: null })], W, new Date("2026-08-20T00:00:00Z"));
    expect(t.after.subject).toMatchObject({ open: 1, returned: 0 });
  });
  it("Courierify stopped: shipped orders outside Courierify are the bad side", () => {
    const t = rateTally("courierify_stopped", [order({ ...at("2026-08-10"), parcelCount: 0 }), order({ ...at("2026-08-10") }), order({ ...at("2026-08-10"), outcome: "not_shipped" })], W, later);
    expect(t.after.subject).toMatchObject({ delivered: 1, returned: 1 });
  });
});

describe("courier deductions", () => {
  const st = (o: Partial<Statement>): Statement => ({
    payer: "leopards", day: "2026-08-20", status: "pending", source: "courier_api", shipments: 310, returned: 0,
    totalCod: pkr("739667.20"), codFees: pkr("0.00"), deliveryFees: pkr("34210.00"), reversalFees: null,
    withholdingTax: pkr("0.00"), miscDeduction: null, carryForward: null, netPaid: pkr("705457.20"), ...o,
  });
  const after = { from: "2026-08-02", to: "2026-09-30" };
  it("improved when the payer's later statements itemize what they keep", () => {
    expect(deductionsOutcome([st({})], "leopards", after, "PKR", false)).toMatchObject({ verdict: "improved", unitemizedShare: 0 });
  });
  it("no change while they still keep 2%+ unexplained", () => {
    expect(deductionsOutcome([st({ netPaid: pkr("591871.48") })], "leopards", after, "PKR", false)).toMatchObject({ verdict: "no_change", unitemizedShare: 15.3 });
  });
  it("too early with no later statement, not enough data at the cut-off", () => {
    expect(deductionsOutcome([st({ day: "2026-07-20" })], "leopards", after, "PKR", false).verdict).toBe("too_early");
    expect(deductionsOutcome([], "leopards", after, "PKR", true).verdict).toBe("not_enough_data");
  });
});

describe("stockout", () => {
  const after = { from: "2026-08-02", to: "2026-08-29" };
  const snaps = (out: number, seen = 28) =>
    Array.from({ length: seen }, (_, i) => ({ day: `2026-08-${String(i + 2).padStart(2, "0")}`, stock: i < out ? 0 : 12 }));
  it("improved when it was out of stock 3+ days less than forecast", () => {
    expect(stockoutOutcome(snaps(2), after, 10, true)).toMatchObject({ verdict: "improved", daysOut: 2, daysSeen: 28 });
  });
  it("worse when 3+ days more", () => {
    expect(stockoutOutcome(snaps(14), after, 10, true).verdict).toBe("worse");
  });
  it("no change within 3 days of the forecast", () => {
    expect(stockoutOutcome(snaps(9), after, 10, true).verdict).toBe("no_change");
  });
  it("too early before day 28, not enough data with too few snapshots or no forecast", () => {
    expect(stockoutOutcome(snaps(2), after, 10, false).verdict).toBe("too_early");
    expect(stockoutOutcome(snaps(2, 15), after, 10, true).verdict).toBe("not_enough_data");
    expect(stockoutOutcome(snaps(2), after, null, true).verdict).toBe("not_enough_data");
  });
});
