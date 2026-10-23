import { describe, expect, it } from "vitest";

import { daysBetween, historyRows, inverseRate } from "./fx-history";

describe("past days' rates (D-98)", () => {
  it("inverts the source's units-per-base into units of the base per currency", () => {
    expect(inverseRate(0.0036066989)).toBe("277.261847392");
    expect(inverseRate(0.013245602)).toBe("75.4967573388");
    expect(inverseRate(3.6725)).toBe("0.272294077604");
    expect(inverseRate(0)).toBeNull();
    expect(inverseRate("1")).toBeNull();
    expect(inverseRate(1e15)).toBeNull();
  });

  it("one day's answer as rows for its base, nothing for another day or base", () => {
    const body = { date: "2026-07-15", pkr: { usd: 0.0036066989, aed: 0.013245602, pkr: 1, "1inch": 0.5 } };
    expect(historyRows("PKR", "2026-07-15", body)).toEqual([
      { base: "PKR", currency: "USD", day: "2026-07-15", rate: "277.261847392", source: "fawazahmed0 currency-api (jsDelivr)" },
      { base: "PKR", currency: "AED", day: "2026-07-15", rate: "75.4967573388", source: "fawazahmed0 currency-api (jsDelivr)" },
    ]);
    expect(historyRows("PKR", "2026-07-16", body)).toEqual([]);
    expect(historyRows("AED", "2026-07-15", body)).toEqual([]);
  });

  it("days, inclusive", () => {
    expect(daysBetween("2026-06-30", "2026-07-02")).toEqual(["2026-06-30", "2026-07-01", "2026-07-02"]);
  });
});
