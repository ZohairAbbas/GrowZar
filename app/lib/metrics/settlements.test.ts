import { describe, expect, it } from "vitest";

import { payerHistories, readPayout } from "./settlements";

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
