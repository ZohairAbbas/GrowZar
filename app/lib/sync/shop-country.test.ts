import { describe, expect, it } from "vitest";

import { acceptReportedCountry } from "./shop-country";

describe("which app's shop country a store keeps", () => {
  it("takes Courierify's whenever it reports one", () => {
    expect(acceptReportedCountry("COURIERIFY", ["COURIERIFY", "FINANCIFY", "PREVENTIFY"])).toBe(true);
  });

  it("ignores another app's while Courierify is connected, so the store does not flip PK/GB each cycle", () => {
    expect(acceptReportedCountry("FINANCIFY", ["COURIERIFY", "FINANCIFY"])).toBe(false);
    expect(acceptReportedCountry("PREVENTIFY", ["COURIERIFY", "PREVENTIFY"])).toBe(false);
  });

  it("prefers a location-based app over Financify's store address when there is no Courierify (zainvault: AE, not GB)", () => {
    expect(acceptReportedCountry("PREVENTIFY", ["FINANCIFY", "PREVENTIFY"])).toBe(true);
    expect(acceptReportedCountry("FINANCIFY", ["FINANCIFY", "PREVENTIFY"])).toBe(false);
  });

  it("takes Financify's for a store with nothing better", () => {
    expect(acceptReportedCountry("FINANCIFY", ["FINANCIFY"])).toBe(true);
  });
});
