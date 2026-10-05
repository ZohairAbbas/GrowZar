import { describe, expect, it } from "vitest";

import { learnCityAliases, normalizeCity } from "./city-aliases";

const pairs = (raw: string, canonical: string, n: number) => Array.from({ length: n }, () => ({ raw, canonical }));

describe("Financify's city spelling in Courierify's names (rule #12)", () => {
  it("learns a spelling seen 3+ times that agrees 90%+ of the time", () => {
    const a = learnCityAliases([...pairs("Karachi City", "Karachi", 9), ...pairs("karachi city", "Karachi", 1)]);
    expect(a.get(normalizeCity("KARACHI CITY "))).toMatchObject({ canonical: "Karachi", votes: 10, of: 10, how: "learned" });
  });

  it("does not guess a spelling that is rare or split between cities", () => {
    const a = learnCityAliases([...pairs("Cantt", "Lahore", 6), ...pairs("Cantt", "Rawalpindi", 4), ...pairs("DHA", "Karachi", 2)]);
    expect(a.has("cantt")).toBe(false);
    expect(a.has("dha")).toBe(false);
  });

  it("maps a spelling that is exactly a known city name, unless the data says otherwise", () => {
    const a = learnCityAliases([...pairs("Lahore", "Lahore", 1), ...pairs("Hyderabad", "Hyderabad", 1)]);
    expect(a.get("lahore")).toMatchObject({ canonical: "Lahore", how: "name" });
    const b = learnCityAliases([...pairs("Lahore", "Lahore", 1), ...pairs("lahore", "Kasur", 2), ...pairs("lahore", "Lahore", 1)]);
    expect(b.has("lahore")).toBe(false);
  });
});
