import { describe, expect, it } from "vitest";

import { countryFromTimezone, normalizeEmail, normalizePhone } from "./phone";

/**
 * The case this exists for: more than twenty phone formats across the suite,
 * and Courierify groups by the raw string — so its customer count counts
 * spellings, not people.
 */
describe("normalizePhone", () => {
  it("resolves the many spellings of one Pakistani number to one value", () => {
    const spellings = [
      "+923001234567",
      "+92 300 1234567",
      "+92-300-1234567",
      "0300-1234567",
      "0300 1234567",
      "03001234567",
      "00923001234567",
      "  +92 (300) 123 4567  ",
    ];

    const normalized = spellings.map((s) => normalizePhone(s, "PK").e164);

    expect(new Set(normalized)).toEqual(new Set(["+923001234567"]));
  });

  it("always keeps the raw value beside the normalised one", () => {
    const result = normalizePhone("0300-1234567", "PK");
    expect(result.e164).toBe("+923001234567");
    expect(result.raw).toBe("0300-1234567");
  });

  it("normalises a +-prefixed number without needing a region", () => {
    expect(normalizePhone("+923001234567").e164).toBe("+923001234567");
    expect(normalizePhone("+92 300 1234567").e164).toBe("+923001234567");
  });

  it("still needs a region for a 00-prefixed number", () => {
    // `00` is the international access code in much of the world but not all
    // of it — North America dials `011` — so it does not say on its own where
    // the number was dialled from.
    expect(normalizePhone("00923001234567").problem).toBe("no_region");
    expect(normalizePhone("00923001234567", "PK").e164).toBe("+923001234567");
  });

  it("refuses a local-format number when the region is unknown", () => {
    // `0300-1234567` is a different person in every country. Guessing a region
    // is exactly the silent wrong answer rule #4 exists to prevent.
    expect(normalizePhone("0300-1234567", null)).toEqual({
      e164: null,
      raw: "0300-1234567",
      problem: "no_region",
    });
  });

  it("keeps what it cannot parse, and says why", () => {
    const rubbish = normalizePhone("not a phone", "PK");
    expect(rubbish.e164).toBeNull();
    expect(rubbish.raw).toBe("not a phone");
    expect(rubbish.problem).toBeDefined();

    // A number that is well-formed but not a real one must not be accepted:
    // matching on it would merge two buyers who share a typo.
    expect(normalizePhone("+92 300 1", "PK").e164).toBeNull();
  });

  it("treats an empty value as absent rather than broken", () => {
    expect(normalizePhone("", "PK").problem).toBe("empty");
    expect(normalizePhone(null, "PK").problem).toBe("empty");
    expect(normalizePhone("   ", "PK").problem).toBe("empty");
  });

  it("does not confuse two different numbers", () => {
    expect(normalizePhone("0300-1234567", "PK").e164).not.toBe(
      normalizePhone("0301-1234567", "PK").e164,
    );
  });
});

describe("normalizeEmail", () => {
  it("folds case and whitespace", () => {
    expect(normalizeEmail("  Owner@Acme.PK ")).toBe("owner@acme.pk");
  });

  it("leaves dots and plus tags alone", () => {
    // Gmail's rules are Gmail's. Merging two addresses a merchant sees as
    // different people is worse than leaving them apart.
    expect(normalizeEmail("a.b+shop@gmail.com")).toBe("a.b+shop@gmail.com");
  });

  it("rejects what is not an address", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("nobody")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("countryFromTimezone", () => {
  it("knows the markets this suite serves", () => {
    expect(countryFromTimezone("Asia/Karachi")).toBe("PK");
    expect(countryFromTimezone("Asia/Dubai")).toBe("AE");
  });

  it("returns null rather than guessing", () => {
    expect(countryFromTimezone("Antarctica/Troll")).toBeNull();
    expect(countryFromTimezone(null)).toBeNull();
  });
});
