import { describe, expect, it } from "vitest";

import type { CashHeldFinding } from "../metrics/findings";
import { summaryOf } from "./summary";

// Made-up numbers; nothing here comes from a real store.
const cash = (o: Partial<CashHeldFinding>): CashHeldFinding => ({
  kind: "cash_held", payer: "orio", orders: 562, cod: [{ amount: "1500000.00", currency: "PKR" }], oldestDay: "2026-08-01",
  lastPaidDay: "2026-08-25", medianGapDays: 1, dueAfterDays: 4, daysLate: 50, disputed: 0, asOf: "2026-10-15",
  byUpload: false, notJudged: [], filter: { kind: "awaiting_payout", payer: "orio" }, ...o,
});

describe("cash held, in a card's words", () => {
  it("for a payer known only by uploaded statements, asks for the upload rather than calling it unpaid", () => {
    const s = summaryOf(cash({ byUpload: true }), "days=30");
    expect(s.headline).toBe("No Orio statement in Courierify for 562 delivered orders");
    expect(s.note).toBe("Last Orio statement uploaded 2026-08-25");
    expect(s.next).toMatch(/^Upload Orio's latest statements in Courierify/);
  });
  it("otherwise says the payer has not paid, and how late", () => {
    const s = summaryOf(cash({ payer: "tcs", byUpload: false, medianGapDays: 7, daysLate: 12 }), "days=30");
    expect(s.headline).toBe("TCS hasn't paid for 562 delivered orders");
    expect(s.note).toBe("12 days past its usual 7-day payout");
  });
});
