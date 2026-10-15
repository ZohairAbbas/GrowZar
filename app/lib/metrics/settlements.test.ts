import { describe, expect, it } from "vitest";

import { attributable, payerHistories, readPayout, readStatement } from "./settlements";

describe("settlements that are not this store's money", () => {
  const row = (o: Record<string, unknown>) => ({ courier: "tcs", settlementDate: "2026-09-08T23:59:59.000Z", status: "received", direction: "payout", ...o });
  it("leaves out a statement that counts shipments but lists none of the store's parcels", () => {
    const foreign = row({ shipmentsCount: 1699, shipmentIds: [] });
    expect(attributable(foreign)).toBe(false);
    expect(readPayout(foreign)).toBeNull();
    expect(readStatement(foreign)).toBeNull();
  });
  it("keeps one that lists its parcels, an empty one, and one from a feed without parcel lists", () => {
    expect(readPayout(row({ shipmentsCount: 2, shipmentIds: ["s1", "s2"] }))).not.toBeNull();
    expect(readPayout(row({ shipmentsCount: 0, shipmentIds: [] }))).not.toBeNull();
    expect(readPayout(row({ shipmentsCount: 40 }))).not.toBeNull();
  });
});

describe("payout history: each payer's own rhythm", () => {
  const p = (courier: string, date: string, status = "received") => readPayout({ courier, settlementDate: `${date}T23:59:59.000Z`, status, direction: "payout" })!;

  it("takes the median gap between received payout days", () => {
    const [h] = payerHistories([p("tcs", "2026-05-04"), p("tcs", "2026-05-11"), p("tcs", "2026-05-18"), p("tcs", "2026-06-03")]);
    expect(h).toEqual({ payer: "tcs", payouts: 4, lastPaidDay: "2026-06-03", medianGapDays: 7, disputed: 0 });
  });

  it("counts disputed statements but never treats them as payouts", () => {
    const [h] = payerHistories([p("tcs", "2026-05-04"), p("tcs", "2026-05-11"), p("tcs", "2026-05-31", "disputed")]);
    expect(h).toMatchObject({ payouts: 2, lastPaidDay: "2026-05-11", disputed: 1, medianGapDays: null });
  });

  it("needs three payout days to know a rhythm", () => {
    expect(payerHistories([p("orio", "2026-08-03"), p("orio", "2026-08-07")])[0]!.medianGapDays).toBeNull();
  });

  it("ignores rows it cannot date, or that are not payouts", () => {
    expect(readPayout({ courier: "tcs", status: "received" })).toBeNull();
    expect(readPayout({ courier: "tcs", settlementDate: "2026-05-04T00:00:00Z", direction: "invoice" })).toBeNull();
  });
});
