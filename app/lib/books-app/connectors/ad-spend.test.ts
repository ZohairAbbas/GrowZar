import { describe, expect, it } from "vitest";

import { addDays } from "../../books/posting";
import { buildAdDay, correctionDate, daysToCheck, decimalToMinor, difference, toPosting, toSums } from "./ad-spend";

const m = { advertising: "ads", fees: "charges", paidFrom: "card" };

describe("ad spend rules", () => {
  it("decimal strings to minor units, half away from zero", () => {
    expect(decimalToMinor("1234.5", 2)).toBe(123450n);
    expect(decimalToMinor("10.005000", 2)).toBe(1001n);
    expect(decimalToMinor("10.004999", 2)).toBe(1000n);
    expect(decimalToMinor("-3.335", 2)).toBe(-334n);
    expect(decimalToMinor("7", 0)).toBe(7n);
  });

  it("a day balances: spend and charges against what paid for them", () => {
    const day = buildAdDay(10_000n, 1_600n, m);
    expect([...day.values()].reduce((s, v) => s + v, 0n)).toBe(0n);
    expect(toPosting(day)).toEqual({ debits: [{ accountId: "ads", amount: "10000" }, { accountId: "charges", amount: "1600" }], credits: [{ accountId: "card", amount: "11600" }] });
    // Charges booked with the spend add up on one line.
    expect(toPosting(buildAdDay(10_000n, 1_600n, { ...m, fees: "ads" }))).toEqual({ debits: [{ accountId: "ads", amount: "11600" }], credits: [{ accountId: "card", amount: "11600" }] });
    expect(buildAdDay(0n, 0n, m).size).toBe(0);
  });

  it("a correction is the current figures less everything saved, and itself balances", () => {
    const saved = toSums(toPosting(buildAdDay(10_000n, 1_600n, m)));
    const now = buildAdDay(9_000n, 1_440n, m);
    const delta = difference(now, [saved]);
    expect(toPosting(delta)).toEqual({ debits: [{ accountId: "card", amount: "1160" }], credits: [{ accountId: "ads", amount: "1000" }, { accountId: "charges", amount: "160" }] });
    expect([...delta.values()].reduce((s, v) => s + v, 0n)).toBe(0n);
    // After the correction is saved, nothing is left.
    expect(difference(now, [saved, delta]).size).toBe(0);
  });

  it("dated on the spend day while it's open, else the day it's seen (D-84)", () => {
    expect(correctionDate("2026-10-05", null, "2026-10-22")).toBe("2026-10-05");
    expect(correctionDate("2026-10-05", "2026-09-30", "2026-10-22")).toBe("2026-10-05");
    expect(correctionDate("2026-09-28", "2026-09-30", "2026-10-22")).toBe("2026-10-22");
    expect(correctionDate("2026-09-30", "2026-09-30", "2026-10-22")).toBe("2026-10-22");
  });

  it("each run covers new days and re-checks the last 35, at most 62 days at a time", () => {
    expect(daysToCheck("2026-07-01", null, "2026-10-21", addDays)).toEqual({ from: "2026-07-01", to: "2026-08-31" });
    expect(daysToCheck("2026-07-01", "2026-08-31", "2026-10-21", addDays)).toEqual({ from: "2026-09-01", to: "2026-10-21" });
    expect(daysToCheck("2026-07-01", "2026-10-21", "2026-10-21", addDays)).toEqual({ from: "2026-09-17", to: "2026-10-21" });
    expect(daysToCheck("2026-10-20", "2026-10-21", "2026-10-21", addDays)).toEqual({ from: "2026-10-20", to: "2026-10-21" });
    expect(daysToCheck("2026-10-22", null, "2026-10-21", addDays)).toBeNull();
  });
});
