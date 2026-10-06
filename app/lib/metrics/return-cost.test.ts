import { describe, expect, it } from "vitest";

import { chargeOnReturn, returnCostOf, times } from "./return-cost";

// Made-up charges.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
const ret = (fee: string | null, basis: string | null, reversal: string | null = null) => ({
  status: "returned", deliveryFee: fee ? pkr(fee) : null, reversalFee: reversal ? pkr(reversal) : null, returnChargeBasis: basis,
});

describe("what a return costs in courier charges", () => {
  it("takes a combined charge whole, and adds a separate return fee to the forward one", () => {
    expect(chargeOnReturn(ret("200.00", "combined"), "PKR")).toBe(200_000_000n);
    expect(chargeOnReturn(ret("150.00", "separate", "90.00"), "PKR")).toBe(240_000_000n);
  });

  it("knows nothing without a basis, never reads a forward fee as the whole cost", () => {
    expect(chargeOnReturn(ret("150.00", null), "PKR")).toBeNull();
    expect(chargeOnReturn(ret("150.00", "separate"), "PKR")).toBeNull();
    expect(chargeOnReturn({ ...ret("150.00", "combined"), status: "delivered" }, "PKR")).toBeNull();
    expect(chargeOnReturn({ ...ret("150.00", "combined"), deliveryFee: { amount: "150.00", currency: "AED" } }, "PKR")).toBeNull();
  });

  it("uses the median of 30 or more priced returns, and counts every return", () => {
    const parcels = [
      ...Array.from({ length: 15 }, () => ret("200.00", "combined")),
      ...Array.from({ length: 15 }, () => ret("150.00", "separate", "90.00")),
      ...Array.from({ length: 5 }, () => ret(null, null)),
    ];
    // 15 at 200 and 15 at 240 (150 + 90): the median falls between them.
    expect(returnCostOf(parcels, "PKR")).toEqual({ perReturn: pkr("220.00"), priced: 30, returns: 35 });
  });

  it("gives no cost below 30 priced returns", () => {
    expect(returnCostOf(Array.from({ length: 29 }, () => ret("200.00", "combined")), "PKR")).toBeNull();
  });

  it("multiplies money exactly", () => {
    expect(times(pkr("207.62"), 69)).toEqual(pkr("14325.78"));
  });
});
