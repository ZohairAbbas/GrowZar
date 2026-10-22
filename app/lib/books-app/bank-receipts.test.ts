import { describe, expect, it } from "vitest";

import { bankSummary, lastInBankByCourier } from "./bank-receipts";

describe("received in bank (rule #17, B7)", () => {
  const payouts = [
    { day: "2026-10-05", net: 930_000n, inBankOn: "2026-10-06", courier: "PostEx" },
    { day: "2026-10-12", net: 200_000n, inBankOn: "2026-10-13", courier: "TCS" },
    { day: "2026-10-20", net: 100_000n, inBankOn: null, courier: "PostEx" },
  ];
  it("payouts dated in the period, by what the bank shows", () => {
    expect(bankSummary(payouts, "PKR", 2)).toEqual({ payouts: 3, inBank: 2, received: { amount: "11300.00", currency: "PKR" }, notYet: { amount: "1000.00", currency: "PKR" }, lastInBankOn: "2026-10-13" });
    expect(bankSummary([], "PKR", 2)).toMatchObject({ payouts: 0, inBank: 0, lastInBankOn: null });
  });
  it("each courier's latest payout the bank shows", () => {
    expect(Object.fromEntries(lastInBankByCourier(payouts))).toEqual({ postex: "2026-10-06", tcs: "2026-10-13" });
  });
});
