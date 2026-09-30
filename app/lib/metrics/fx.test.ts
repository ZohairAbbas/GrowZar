import { describe, expect, it } from "vitest";

import { convertDated, NO_FX_SOURCE, tableSource } from "./fx";
import { compareSettings } from "./profit-settings";

const pkr = (amount: string) => ({ amount, currency: "PKR" });
const aed = (amount: string) => ({ amount, currency: "AED" });

describe("rule #4: multi-currency totals convert at the historical daily rate, rate shown", () => {
  it("with no rate source, adds only the base currency and lists the rest unconverted", () => {
    const c = convertDated(
      [
        { day: "2026-07-12", money: pkr("1000.00") },
        { day: "2026-07-12", money: aed("100.00") },
        { day: "2026-07-13", money: aed("50.00") },
      ],
      "PKR",
      NO_FX_SOURCE,
    );
    expect(c.total).toEqual(pkr("1000.00"));
    expect(c.complete).toBe(false);
    expect(c.unconverted).toEqual([{ money: aed("150.00"), days: ["2026-07-12", "2026-07-13"] }]);
    expect(c.source).toMatch(/awaiting Financify/);
  });

  it("converts each amount at its own day's rate, exactly, and shows every rate used", () => {
    const source = tableSource("test", [
      { from: "AED", to: "PKR", day: "2026-07-12", rate: "76.10", source: "test" },
      { from: "AED", to: "PKR", day: "2026-07-13", rate: "76.40", source: "test" },
    ]);
    const c = convertDated(
      [
        { day: "2026-07-12", money: aed("100.00") },
        { day: "2026-07-13", money: aed("100.00") },
        { day: "2026-07-13", money: pkr("0.10") },
      ],
      "PKR",
      source,
    );
    expect(c.total).toEqual(pkr("15250.10"));
    expect(c.complete).toBe(true);
    expect(c.ratesUsed.map((r) => `${r.day} ${r.rate}`)).toEqual(["2026-07-12 76.10", "2026-07-13 76.40"]);
  });

  it("never borrows a neighbouring day's rate", () => {
    const source = tableSource("test", [{ from: "AED", to: "PKR", day: "2026-07-12", rate: "76.10", source: "test" }]);
    const c = convertDated([{ day: "2026-07-14", money: aed("10.00") }], "PKR", source);
    expect(c.complete).toBe(false);
    expect(c.unconverted[0]!.days).toEqual(["2026-07-14"]);
  });

  it("treats a rate of zero or garbage as no rate, never as 1", () => {
    const source = tableSource("test", [{ from: "AED", to: "PKR", day: "2026-07-12", rate: "0", source: "test" }]);
    expect(convertDated([{ day: "2026-07-12", money: aed("10.00") }], "PKR", source).complete).toBe(false);
  });
});

describe("rule #15: stores with different profit settings are flagged, with what differs", () => {
  const settings = (view: string) => ({
    costBasis: { key: "perOrderCostBasis", value: "shipped" },
    realizedVsExpected: { key: "profitViewMode", value: view },
  });

  it("is consistent when every store has the same hash", () => {
    const c = compareSettings([
      { storeId: "a", shopDomain: "a.myshopify.com", settingsHash: "h1", settings: settings("expected") },
      { storeId: "b", shopDomain: "b.myshopify.com", settingsHash: "h1", settings: settings("expected") },
    ]);
    expect(c.consistent).toBe(true);
    expect(c.differences).toEqual([]);
  });

  it("names the setting that differs and each store's value", () => {
    const c = compareSettings([
      { storeId: "a", shopDomain: "a.myshopify.com", settingsHash: "h1", settings: settings("expected") },
      { storeId: "b", shopDomain: "b.myshopify.com", settingsHash: "h2", settings: settings("realized") },
    ]);
    expect(c.consistent).toBe(false);
    expect(c.differences).toEqual([
      { setting: "realizedVsExpected", values: { "a.myshopify.com": "expected", "b.myshopify.com": "realized" } },
    ]);
  });

  it("reports a store without Financify as unknown, not as matching", () => {
    const c = compareSettings([
      { storeId: "a", shopDomain: "a.myshopify.com", settingsHash: "h1", settings: settings("expected") },
      { storeId: "p", shopDomain: "pilot.myshopify.com", settingsHash: null, settings: null },
    ]);
    expect(c.consistent).toBe(true);
    expect(c.unknown).toEqual(["pilot.myshopify.com"]);
  });
});
