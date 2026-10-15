import { describe, expect, it } from "vitest";

import { bucketOf, type RollupOrder } from "../metrics/rollups";
import { notReceivedFinding, stuckFinding, type FindingsInput } from "../metrics/findings";
import type { ParcelFacts } from "../metrics/returns";
import type { Insight } from "../insights/detectors";
import { itemsOf } from "./items";
import { baselineFrom, closesWatch, internalEmails, isInternal, opensPlacebo, opensWatch } from "./watch";

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
const asOf = new Date("2026-10-06T12:00:00Z");
const input = (rows: RollupOrder[], o: Partial<FindingsInput> = {}): FindingsInput =>
  ({ currency: "PKR", rows, orders: bucketOf("s", rows), profit: null, adSpend: null, asOf, ...o }) as FindingsInput;
const asInsight = (finding: unknown): Insight =>
  ({ detector: "x", subject: "store", fingerprint: "x:store", rank: { group: "specific", ordersAffected: 1 }, revealsMoney: true, finding }) as unknown as Insight;

const day = (d: string) => new Date(`${d}T10:00:00Z`);

describe("opening a watch", () => {
  it("opens on the first click, and not on later ones", () => {
    expect(opensWatch("courier_for_city", null, null)).toBe(true);
    expect(opensWatch("courier_for_city", { actedAt: day("2026-10-20"), closedAt: null }, null)).toBe(false);
  });
  it("opens a new watch when the finding came back after the last one was opened", () => {
    const latest = { actedAt: day("2026-10-20"), closedAt: null };
    expect(opensWatch("variant_returns", latest, day("2026-11-30"))).toBe(true);
    expect(opensWatch("variant_returns", latest, day("2026-10-01"))).toBe(false);
  });
  it("opens a new watch after the last one was closed", () => {
    expect(opensWatch("cash_held", { actedAt: day("2026-10-20"), closedAt: day("2026-10-21") }, null)).toBe(true);
  });
  it("never watches informational and data-health findings", () => {
    expect(opensWatch("margin_ceiling", null, null)).toBe(false);
    expect(opensWatch("outcome_disagreement", null, null)).toBe(false);
  });
});

describe("closing a watch", () => {
  it("closes only on a dismissal as wrong", () => {
    expect(closesWatch({ intent: "dismiss", reason: "wrong" })).toBe(true);
    for (const reason of ["already_knew", "not_relevant", "other"]) expect(closesWatch({ intent: "dismiss", reason })).toBe(false);
    expect(closesWatch({ intent: "snooze" })).toBe(false);
    expect(closesWatch({ intent: "reopen" })).toBe(false);
  });
});

describe("baseline", () => {
  it("copies the kept finding and its items", () => {
    const insight = asInsight({ kind: "cash_held" });
    const { baseline, source } = baselineFrom({ insight, items: [{ orderId: "o1", money: pkr("10.00") }] }, { orders: 1 }, day("2026-10-20"));
    expect(source).toBe("snapshot");
    expect(baseline).toEqual({ finding: insight, items: [{ orderId: "o1", money: pkr("10.00") }], evidence: { orders: 1 }, evaluatedAt: "2026-10-20T10:00:00.000Z" });
  });
  it("says unavailable, keeping the evidence, when no evaluation kept the finding", () => {
    const { baseline, source } = baselineFrom(null, { orders: 3 }, day("2026-10-20"));
    expect(source).toBe("unavailable");
    expect(baseline).toMatchObject({ finding: null, evidence: { orders: 3 } });
  });
});

describe("internal accounts", () => {
  const list = internalEmails(" A@Example.com, b@example.com ,");
  it("matches without case or spaces", () => {
    expect(isInternal("a@example.com", list)).toBe(true);
    expect(isInternal("B@EXAMPLE.COM", list)).toBe(true);
    expect(isInternal("merchant@example.com", list)).toBe(false);
    expect(isInternal(null, list)).toBe(false);
    expect(isInternal("a@example.com", internalEmails(undefined))).toBe(false);
  });
});

describe("items a state-based finding is about", () => {
  const old = { basis: "status_as_of" as const, at: new Date("2026-09-20T00:00:00Z") };
  it("lists the stuck parcels the card counts", () => {
    const stuck = Array.from({ length: 5 }, () => order({ outcome: "in_transit", delivered: null, outcomeTiming: old }));
    const rows = [...stuck, order()];
    const f = stuckFinding(input(rows));
    expect(f).toMatchObject({ kind: "stuck_parcels", inTransit: 5 });
    expect(itemsOf(asInsight(f), input(rows))!.map((i) => i.orderId)).toEqual(stuck.map((o) => o.orderId));
  });
  it("lists the returns not confirmed back, as many as the card counts", () => {
    const rows = Array.from({ length: 6 }, () => order({ outcome: "returned", delivered: null }));
    const parcels: ParcelFacts[] = rows.map((o, i) => ({
      orderId: o.orderId, courier: "leopards", outcome: "returned", returnReceived: i === 0, returnedAt: new Date("2026-09-10T00:00:00Z"), fee: null,
    }));
    const f = notReceivedFinding(input(rows, { parcels }));
    expect(f).toMatchObject({ kind: "returns_not_received", orders: 5 });
    expect(itemsOf(asInsight(f), input(rows, { parcels }))!.map((i) => i.orderId)).toEqual(rows.slice(1).map((o) => o.orderId));
  });
  it("keeps each owed order's COD for cash held, for the payer's due orders only", () => {
    const payers = [{ payer: "leopards", payouts: 4, lastPaidDay: "2026-09-01", medianGapDays: 7, disputed: 0 }];
    const due = order({ outcomeTiming: { basis: "status_as_of", at: new Date("2026-09-05T00:00:00Z") }, uncollected: pkr("2500.00") });
    const fresh = order({ outcomeTiming: { basis: "status_as_of", at: new Date("2026-10-06T00:00:00Z") }, uncollected: pkr("900.00") });
    const other = order({ courier: "tcs", outcomeTiming: { basis: "status_as_of", at: new Date("2026-09-05T00:00:00Z") }, uncollected: pkr("700.00") });
    const i = asInsight({ kind: "cash_held", payer: "leopards", filter: { kind: "awaiting_payout", payer: "leopards" } });
    const items = itemsOf(i, input([], { cash: { asOf, payers, awaiting: [due, fresh, other] } }));
    expect(items).toEqual([{ orderId: due.orderId, money: pkr("2500.00") }]);
  });
  it("has nothing to list for detectors measured from order history", () => {
    expect(itemsOf(asInsight({ kind: "courier_for_city" }), input([]))).toBeNull();
  });
});

describe("placebo watches", () => {
  const none = { placebo: false, real: false };
  it("open when a finding starts firing, or is firing with no watch of either kind", () => {
    expect(opensPlacebo("courier_for_city", true, { placebo: true, real: true })).toBe(true);
    expect(opensPlacebo("courier_for_city", false, none)).toBe(true);
  });
  it("not while an episode already has one, or after a click", () => {
    expect(opensPlacebo("courier_for_city", false, { placebo: true, real: false })).toBe(false);
    expect(opensPlacebo("courier_for_city", false, { placebo: false, real: true })).toBe(false);
  });
  it("never for informational findings", () => {
    expect(opensPlacebo("margin_ceiling", true, none)).toBe(false);
  });
});
