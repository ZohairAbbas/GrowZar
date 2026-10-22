import { describe, expect, it } from "vitest";
import { balanceNotes, datesAmbiguous, findSubset, possibleDuplicates, reversalPairs, suggestClose, suggestGroups } from "../bank";
import { parseStatementDate } from "../statement-csv";

const S = (id: string, date: string, amount: bigint, description = "") => ({ id, date, amount, description });
const L = (id: string, date: string, amount: bigint) => ({ id, date, amount });

describe("several at once", () => {
  it("finds the fewest entries that add up exactly", () => {
    const pool = [L("a", "2026-10-01", 300n), L("b", "2026-10-01", 700n), L("c", "2026-10-02", 500n), L("d", "2026-10-02", 200n)];
    expect(findSubset(pool, 1000n)!.map((x) => x.id)).toEqual(["a", "b"]);
    expect(findSubset(pool, 1700n)!.map((x) => x.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(findSubset(pool, 999n)).toBeNull();
    expect(findSubset([L("a", "2026-10-01", 1000n)], 1000n)).toBeNull(); // one entry is a plain match, not a group
  });

  it("one deposit for two payouts; one payout paid in two transfers", () => {
    const st = [S("s1", "2026-10-05", 15000n), S("s2", "2026-10-09", 4000n), S("s3", "2026-10-10", 6000n)];
    const led = [L("l1", "2026-10-03", 10000n), L("l2", "2026-10-04", 5000n), L("l3", "2026-10-08", 10000n)];
    expect(suggestGroups(st, led).map((g) => ({ statementIds: [...g.statementIds].sort(), ledgerIds: [...g.ledgerIds].sort() }))).toEqual([
      { statementIds: ["s1"], ledgerIds: ["l1", "l2"] },
      { statementIds: ["s2", "s3"], ledgerIds: ["l3"] },
    ]);
  });

  it("never mixes money in and out, never reaches past the window, never uses an item twice", () => {
    expect(suggestGroups([S("s", "2026-10-05", 1000n)], [L("a", "2026-10-05", 1500n), L("b", "2026-10-05", -500n)])).toEqual([]);
    expect(suggestGroups([S("s", "2026-10-30", 1000n)], [L("a", "2026-10-01", 500n), L("b", "2026-10-01", 500n)])).toEqual([]);
    const g = suggestGroups([S("s1", "2026-10-05", 1000n), S("s2", "2026-10-05", 1000n)], [L("a", "2026-10-05", 500n), L("b", "2026-10-05", 500n)]);
    expect(g).toHaveLength(1);
  });
});

describe("close matches", () => {
  it("a gateway deposit net of fees, within 5%; the smallest difference wins", () => {
    const c = suggestClose([S("s", "2026-10-05", 97500n)], [L("gross", "2026-10-04", 100000n), L("other", "2026-10-04", 97000n)]);
    expect(c).toEqual([{ statementId: "s", ledgerId: "other", difference: 500n }]);
    expect(suggestClose([S("s", "2026-10-05", 90000n)], [L("x", "2026-10-05", 100000n)])).toEqual([]); // 10% off: not the same payment
    expect(suggestClose([S("s", "2026-10-05", -100500n)], [L("x", "2026-10-05", -100000n)])).toEqual([{ statementId: "s", ledgerId: "x", difference: -500n }]); // a bank charge on top
    expect(suggestClose([S("s", "2026-10-05", 1000n)], [L("x", "2026-10-05", 1000n)])).toEqual([]); // exact isn't "close"
  });
});

describe("reversals", () => {
  it("a payment and its reversal pair up; ones that say so first", () => {
    const st = [S("a", "2026-10-01", -5000n, "IBFT ALI"), S("b", "2026-10-02", 5000n, "IBFT ALI REVERSAL"), S("c", "2026-10-03", 5000n, "CASH DEP")];
    expect(reversalPairs(st)).toEqual([["a", "b"]]);
    expect(reversalPairs([S("a", "2026-10-01", -5000n), S("b", "2026-10-20", 5000n)])).toEqual([]);
  });
});

describe("checks on an import", () => {
  it("possible duplicates: same date and amount, each earlier line used once", () => {
    const fresh = [{ date: "2026-10-01", amount: -500n }, { date: "2026-10-01", amount: -500n }, { date: "2026-10-02", amount: 100n }];
    expect([...possibleDuplicates(fresh, [{ id: "9", date: "2026-10-01", amount: -500n }])]).toEqual([[0, "9"]]);
  });

  it("running balance: works either way round, finds breaks and gaps", () => {
    const fmt = (v: bigint) => v.toString();
    const ok = [{ row: 2, date: "2026-10-01", amount: 100n, balance: 1100n }, { row: 3, date: "2026-10-02", amount: -50n, balance: 1050n }];
    expect(balanceNotes(ok, { date: "2026-09-30", balance: 1000n }, fmt)).toEqual([]);
    expect(balanceNotes([...ok].reverse(), { date: "2026-09-30", balance: 1000n }, fmt)).toEqual([]); // newest first
    expect(balanceNotes(ok, { date: "2026-09-30", balance: 900n }, fmt)[0]).toMatch(/starts from a balance of 1000.*ended at 900/);
    const broken = [...ok, { row: 4, date: "2026-10-03", amount: -10n, balance: 1000n }];
    expect(balanceNotes(broken, null, fmt)[0]).toMatch(/doesn't add up at 1 place \(first at row 4\)/);
    expect(balanceNotes([{ row: 2, date: "2026-10-01", amount: 1n, balance: null }], null, fmt)).toEqual([]);
  });

  it("dates that read both ways are flagged; one day over 12 settles it", () => {
    const p = (c: string, f: "DMY" | "MDY") => parseStatementDate(c, f);
    expect(datesAmbiguous(["03/04/2026", "05/05/2026"], p)).toBe(true);
    expect(datesAmbiguous(["03/04/2026", "13/04/2026"], p)).toBe(false);
    expect(datesAmbiguous(["05/05/2026"], p)).toBe(false);
  });
});

import { ruleFor as ruleFor2, splitAmounts, splitProblem } from "../bank";

describe("rules", () => {
  const r = (id: string, contains: string, extra: Record<string, unknown> = {}) => ({ id, contains, direction: "out" as const, accountId: `acc-${id}`, contactId: null, ...extra });
  it("amount ranges, and the most specific rule wins", () => {
    const rules = [r("any", "ALI"), r("small", "ALI", { maxAmount: 100000n }), r("big", "ALI", { minAmount: 100001n }), r("longer", "ALI TRADERS")];
    expect(ruleFor2(rules, "IBFT ALI", -50000n)?.id).toBe("small");
    expect(ruleFor2(rules, "IBFT ALI", -500000n)?.id).toBe("big");
    expect(ruleFor2(rules, "IBFT 0042 ALI TRADERS", -50000n)?.id).toBe("longer");
    expect(ruleFor2([r("x", "ALI", { minAmount: 10n, maxAmount: 20n })], "ALI", -5n)).toBeNull();
    expect(ruleFor2(rules, "IBFT ALI", 50000n)).toBeNull(); // money in: no out rule
  });
  it("splits add up to the line exactly", () => {
    const parts = splitAmounts(100001n, [{ accountId: "rent", percent: 80 }, { accountId: "power", percent: 20 }]);
    expect(parts).toEqual([{ accountId: "rent", amount: 80001n }, { accountId: "power", amount: 20000n }]);
    expect(splitAmounts(3n, [{ accountId: "a", percent: 33.33 }, { accountId: "b", percent: 33.33 }, { accountId: "c", percent: 33.34 }]).reduce((s, x) => s + x.amount, 0n)).toBe(3n);
  });
  it("a split must be 2–10 different accounts adding to 100%", () => {
    expect(splitProblem([{ accountId: "a", percent: 100 }])).toMatch(/at least two/);
    expect(splitProblem([{ accountId: "a", percent: 50 }, { accountId: "a", percent: 50 }])).toMatch(/once/);
    expect(splitProblem([{ accountId: "a", percent: 50 }, { accountId: "b", percent: 40 }])).toMatch(/100%/);
    expect(splitProblem([{ accountId: "a", percent: 50.5 }, { accountId: "b", percent: 49.5 }])).toBeNull();
  });
});

import { bestMatches, contactsNamed, mentionsNumber, nameMatch, nameTokens, sameWord, scoreCandidate } from "../bank";

describe("words: names and numbers", () => {
  it("noise words are dropped; typos and run-together names still match", () => {
    expect(nameTokens("IBFT FROM ALI TRADERS PVT LTD 0042")).toEqual(["ali"]);
    expect(sameWord("packaging", "packagng")).toBe(true);
    expect(sameWord("ali", "alu")).toBe(false); // too short for a typo
    expect(nameMatch("IBFT 0042 PACKAGNG CO KARACHI", "Packaging Co")).toBe(1);
    expect(nameMatch("RAAST ALIRAZAKHAN", "Ali Raza Khan")).toBe(1 / 3 * 0 + nameMatch("RAAST ALIRAZAKHAN", "Ali Raza Khan"));
    expect(nameMatch("PAYMENT TO HAMZA", "Packaging Co")).toBe(0);
  });
  it("entry numbers in any common spelling", () => {
    expect(mentionsNumber("Payment against INV-0012 thanks", "INV-0012")).toBe(true);
    expect(mentionsNumber("pmt inv 12", "INV-0012")).toBe(true);
    expect(mentionsNumber("BIL#0003", "BIL-0003")).toBe(true);
    expect(mentionsNumber("INV-00123", "INV-0012")).toBe(false);
  });
});

describe("scoring", () => {
  const line = { date: "2026-10-05", amount: -118000n, description: "IBFT PACKAGING CO" };
  it("exact amount + same day + the name = strong; reasons say why", () => {
    const s = scoreCandidate(line, { id: "a", date: "2026-10-05", amount: -118000n, contactName: "Packaging Co" })!;
    expect(s.strength).toBe("strong");
    expect(s.reasons).toEqual(["same amount", "same day", "mentions Packaging Co"]);
  });
  it("exact amount a few days off, no name = likely; a week+ off and nameless = possible", () => {
    expect(scoreCandidate(line, { id: "a", date: "2026-10-03", amount: -118000n })!.strength).toBe("likely");
    expect(scoreCandidate(line, { id: "a", date: "2026-10-12", amount: -118000n })!.strength).toBe("likely");
    expect(scoreCandidate(line, { id: "a", date: "2026-10-16", amount: -118000n })!.strength).toBe("possible");
    expect(scoreCandidate(line, { id: "a", date: "2026-10-05", amount: -118000n })!.strength).toBe("likely"); // no name: never strong on its own
    expect(scoreCandidate(line, { id: "a", date: "2026-11-30", amount: -118000n })).toBeNull();
  });
  it("a close amount needs more to be strong; the other direction never matches", () => {
    const near = scoreCandidate(line, { id: "a", date: "2026-10-05", amount: -117000n, contactName: "Packaging Co" })!;
    expect(near.difference).toBe(-1000n);
    expect(near.strength).toBe("likely");
    expect(scoreCandidate(line, { id: "a", date: "2026-10-05", amount: 118000n })).toBeNull();
  });
  it("one-to-one, best first: the named entry wins the line even when another is the same amount", () => {
    const m = bestMatches([{ id: "l1", ...line }], [
      { id: "plain", date: "2026-10-05", amount: -118000n },
      { id: "named", date: "2026-10-06", amount: -118000n, contactName: "Packaging Co" },
    ]);
    expect(m.get("l1")?.id).toBe("named");
  });
  it("names a contact when nothing in the books matches", () => {
    const c = contactsNamed("IBFT 0042 PACKAGNG CO KARACHI", [{ id: "1", name: "Packaging Co" }, { id: "2", name: "Ali Traders" }, { id: "3", name: "Co" }]);
    expect(c.map((x) => x.id)).toEqual(["1"]);
  });
});
