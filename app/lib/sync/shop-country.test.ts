import { describe, expect, it } from "vitest";

import { acceptReportedCountry } from "./shop-country";

describe("which app's shop country a store keeps", () => {
  it("takes Courierify's whenever it reports one", () => {
    expect(acceptReportedCountry("COURIERIFY", true)).toBe(true);
  });

  it("ignores another app's while Courierify is connected, so the store does not flip PK/GB each cycle", () => {
    expect(acceptReportedCountry("FINANCIFY", true)).toBe(false);
  });

  it("takes another app's for a store without Courierify", () => {
    expect(acceptReportedCountry("FINANCIFY", false)).toBe(true);
  });
});
