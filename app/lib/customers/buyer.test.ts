import { describe, expect, it } from "vitest";

import { buyerFromOrderPayload } from "./resolve.server";

// Made-up numbers only.
describe("buyerFromOrderPayload", () => {
  it("reads Courierify's parcel shape", () => {
    expect(
      buyerFromOrderPayload({ customer: { name: "Test Buyer", phone: "+923000000001" } }),
    ).toMatchObject({ phone: "+923000000001", name: "Test Buyer" });
  });

  it("reads Financify's nested buyer.phone, preferring E.164", () => {
    expect(
      buyerFromOrderPayload({
        buyer: { phone: { e164: "+923000000002", raw: "0300 0000002" }, phoneSource: "order" },
      }).phone,
    ).toBe("+923000000002");
  });

  it("falls back to Financify's raw phone when it could not normalise", () => {
    expect(
      buyerFromOrderPayload({ buyer: { phone: { e164: null, raw: "0300-0000003" } } }).phone,
    ).toBe("0300-0000003");
  });

  it("has no phone when Financify sends buyer.phone null", () => {
    expect(buyerFromOrderPayload({ buyer: { phone: null } }).phone).toBeNull();
  });

  it("falls back to Courierify's phoneRaw when it sent no E.164 phone", () => {
    expect(
      buyerFromOrderPayload({ customer: { name: "Test Buyer", phone: null, phoneRaw: "+91 90000 00001" } }).phone,
    ).toBe("+91 90000 00001");
  });
});
