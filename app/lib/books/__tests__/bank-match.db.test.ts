/**
 * Bank statement matching against Postgres: lines and entries matched
 * together, close matches with the difference recorded, reversal pairs,
 * paying bills and collecting invoices from a line (with tax withheld),
 * cancelled entries releasing their match, reconciliation ticking groups,
 * and the duplicate and balance checks on an overlapping import.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "./test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Bank statements: matching several at once, differences, settling", () => {
  let B: typeof import("../books.server");
  let K: typeof import("../bank.server");
  let prisma: import("@prisma/client").PrismaClient;
  const shop = `books-bankm-${Date.now()}`;
  let dropSchema: (() => Promise<void>) | undefined;
  let book: Awaited<ReturnType<typeof B.setupBook>>;
  const acc: Record<string, string> = {};
  const MAP = { headerRow: 0, dateCol: 0, dateFormat: "YMD", descCols: [1], amountCol: 2, outCol: null, inCol: null, balanceCol: 3, flip: false };

  beforeAll(async () => {
    dropSchema = await openTestSchema();
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books.server");
    K = await import("../bank.server");
    book = await B.setupBook(shop, { currency: "PKR", fiscalYearStartMonth: 7, timeZone: "Asia/Karachi", startDate: "2026-10-01", moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }] }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
  });
  afterAll(async () => {
    if (B && book) await B.purgeBooks(shop).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  const post = async (input: Parameters<typeof B.saveAndPost>[1]) => {
    const r = await B.saveAndPost(book, input, "owner");
    if (r.error) throw new Error(`${input.type}: ${r.error.message}`);
    return r.doc;
  };
  const payout = (date: string, received: string) => post({ type: "courier_payout", date, data: { receivable: acc["Owed by couriers"]!, receivedIn: acc["Meezan"]!, received, deductions: [] } });
  const csv = (rows: Array<[string, string, string, string]>) => ["Date,Description,Amount,Balance", ...rows.map((r) => r.join(","))].join("\n");
  const importRows = (name: string, rows: Array<[string, string, string, string]>) => K.importStatement(book, { accountId: acc["Meezan"]!, fileName: name, text: csv(rows), mapping: MAP }, "owner");
  const review = () => K.statementReview(book, acc["Meezan"]!, { show: "open" });
  const lineBy = async (desc: string) => (await prisma.bkStatementLine.findFirstOrThrow({ where: { bookId: book.id, description: desc } })).id.toString();

  it("one deposit for two payouts, and one payout in two transfers: suggested, matched, released by unmatch or a cancel", async () => {
    const p1 = await payout("2026-10-03", "1000000");
    await payout("2026-10-04", "500000");
    const p3 = await payout("2026-10-08", "1000000");
    const r = await importRows("oct-a.csv", [
      ["2026-10-05", "TCS DEP", "15000.00", "15000.00"],
      ["2026-10-09", "TCS PART 1", "4000.00", "19000.00"],
      ["2026-10-10", "TCS PART 2", "6000.00", "25000.00"],
    ]);
    expect(r.added).toBe(3);
    expect(r.balanceNotes).toEqual([]);
    const t0 = Date.now();
    const v = await review();
    // The review (suggestions, scoring, bills, contacts) stays quick.
    expect(Date.now() - t0).toBeLessThan(1500);
    console.log("REVIEW_MS", Date.now() - t0);
    const dep = v.lines.find((l) => l.description === "TCS DEP")!;
    expect(dep.group?.entries.map((e) => e.number).sort()).toEqual(["CPY-0001", "CPY-0002"]);
    const part = v.lines.find((l) => l.description === "TCS PART 1")!;
    expect(part.group?.entries.map((e) => e.number)).toEqual(["CPY-0003"]);
    // Accept both suggestions in one go.
    const res = await K.applySuggestions(
      book,
      [
        { lineId: dep.id, kind: "group", lineIds: dep.group!.lineIds, entryLineIds: dep.group!.entries.map((e) => e.entryLineId) },
        { lineId: part.id, kind: "group", lineIds: part.group!.lineIds, entryLineIds: part.group!.entries.map((e) => e.entryLineId) },
      ],
      "owner",
    );
    expect(res.every((x) => x.ok)).toBe(true);
    expect((await review()).counts).toMatchObject({ open: 0, matched: 3 });
    // Matching the same entries again is refused.
    await expect(K.matchGroup(book, [dep.id], dep.group!.entries.map((e) => e.entryLineId))).rejects.toThrow(/already matched/);
    // Unmatching one line of a group releases the whole group.
    await K.unmatchStatementLine(book, await lineBy("TCS PART 2"));
    expect((await review()).counts).toMatchObject({ open: 2, matched: 1 });
    await K.matchGroup(book, [part.id, await lineBy("TCS PART 2")], [part.group!.entries[0]!.entryLineId]);
    // Cancelling a payout in a group sends the group back to review.
    await B.cancelDocument(book, p1.id, "wrong", "owner");
    const after = await review();
    expect(after.lines.map((l) => l.description).sort()).toEqual(["TCS DEP"]);
    void p3;
  });

  it("a gateway deposit net of its fee: matched with the difference recorded, and the bank agrees", async () => {
    const gw = await post({ type: "money_in", date: "2026-10-11", data: { receivedIn: acc["Meezan"]!, lines: [{ accountId: acc["Other income"]!, amount: "10000000" }] } });
    await importRows("oct-b.csv", [["2026-10-12", "PAYFAST SETTLEMENT", "97500.00", ""]]);
    const l = (await review()).lines.find((x) => x.description === "PAYFAST SETTLEMENT")!;
    expect(l.close).toMatchObject({ id: gw.id, difference: -250000n });
    await expect(K.matchWithDifference(book, { lineId: l.id, entryLineId: l.close!.entryLineId, accountId: acc["Sales"]! }, "owner")).rejects.toThrow();
    const r = await K.matchWithDifference(book, { lineId: l.id, entryLineId: l.close!.entryLineId, accountId: acc["Bank charges"]! }, "owner");
    expect(r.documentId).toBeTruthy();
    const diff = await prisma.bkDocument.findUniqueOrThrow({ where: { id: r.documentId! } });
    expect(diff.type).toBe("expense");
    expect(diff.total).toBe(250000n);
    expect((await prisma.bkStatementLine.findFirstOrThrow({ where: { bookId: book.id, description: "PAYFAST SETTLEMENT" } })).status).toBe("matched");
  });

  it("a payment and its reversal match each other; nothing is recorded", async () => {
    await importRows("oct-c.csv", [
      ["2026-10-13", "IBFT ALI", "-5000.00", ""],
      ["2026-10-14", "IBFT ALI REVERSAL", "5000.00", ""],
    ]);
    const v = await review();
    const a = v.lines.find((x) => x.description === "IBFT ALI")!;
    expect(a.reversal?.description).toBe("IBFT ALI REVERSAL");
    const docsBefore = await prisma.bkDocument.count({ where: { bookId: book.id } });
    await K.pairReversal(book, a.id, a.reversal!.lineId);
    expect(await prisma.bkDocument.count({ where: { bookId: book.id } })).toBe(docsBefore);
    expect((await review()).lines.some((x) => x.description.startsWith("IBFT ALI"))).toBe(false);
    await expect(K.pairReversal(book, await lineBy("TCS DEP"), await lineBy("TCS DEP"))).rejects.toThrow();
  });

  it("pays a bill with tax withheld, and part of an invoice, straight from the line", async () => {
    const supplier = (await B.createContact(book, { name: "Packaging Co", kinds: ["supplier"] }, null)).id;
    const bill = await post({ type: "bill", date: "2026-10-02", contactId: supplier, data: { payable: acc["Owed to suppliers"]!, dueDate: "2026-10-30", lines: [{ accountId: acc["Packaging"]!, amount: "2000000" }] } });
    const customer = (await B.createContact(book, { name: "Wholesale Buyer", kinds: ["customer"] }, null)).id;
    const inv = await post({ type: "invoice", date: "2026-10-02", contactId: customer, data: { receivable: acc["Owed by customers"]!, dueDate: "2026-10-30", lines: [{ accountId: acc["Sales"]!, amount: "1180000" }] } });
    await importRows("oct-d.csv", [
      ["2026-10-15", "PACKAGING CO", "-19100.00", ""],
      ["2026-10-16", "WHOLESALE BUYER", "6000.00", ""],
    ]);
    const out = await lineBy("PACKAGING CO");
    const choices = await K.settleChoices(book, out);
    expect(choices.docs.map((d) => d.id)).toContain(bill.id);
    await expect(K.settleFromLine(book, { lineId: out, items: [{ id: bill.id, amount: "2000000" }] }, "owner")).rejects.toThrow(/has to be the line/);
    const r = await K.settleFromLine(book, { lineId: out, items: [{ id: bill.id, amount: "2000000" }], withheld: { accountId: acc["Withholding tax to pay"]!, amount: "90000" } }, "owner");
    expect(r.linked).toBe(true);
    expect((await B.listBills(book, { ids: [bill.id] }))[0]!.open).toBe(0n);
    const inn = await lineBy("WHOLESALE BUYER");
    const r2 = await K.settleFromLine(book, { lineId: inn, items: [{ id: inv.id, amount: "600000" }] }, "owner");
    expect(r2.linked).toBe(true);
    expect((await B.listBills(book, { ids: [inv.id], type: "invoice" }))[0]!.open).toBe(580000n);
    // Two suppliers at once: refused.
    await importRows("oct-e.csv", [["2026-10-17", "TWO SUPPLIERS", "-10.00", ""]]);
    const other = (await B.createContact(book, { name: "Other Co", kinds: ["supplier"] }, null)).id;
    const b2 = await post({ type: "bill", date: "2026-10-02", contactId: other, data: { payable: acc["Owed to suppliers"]!, dueDate: "2026-10-30", lines: [{ accountId: acc["Packaging"]!, amount: "500" }] } });
    const b3 = await post({ type: "bill", date: "2026-10-02", contactId: supplier, data: { payable: acc["Owed to suppliers"]!, dueDate: "2026-10-30", lines: [{ accountId: acc["Packaging"]!, amount: "500" }] } });
    await expect(K.settleFromLine(book, { lineId: await lineBy("TWO SUPPLIERS"), items: [{ id: b2.id, amount: "500" }, { id: b3.id, amount: "500" }] }, "owner")).rejects.toThrow(/one supplier/);
  });

  it("reconciling ticks a group only when all of its lines are on or before the statement date", async () => {
    // TCS PART 1 (10-09) + TCS PART 2 (10-10) are one group: reconciling to 10-09 leaves it unticked.
    const rec = await K.startReconciliation(book, acc["Meezan"]!, "2026-10-09", 0n, "owner");
    const v = await K.reconciliationView(book, rec);
    const p3 = v.lines.find((l) => l.number === "CPY-0003");
    expect(p3?.ticked).toBe(false);
    await K.discardReconciliation(book, rec);
    const rec2 = await K.startReconciliation(book, acc["Meezan"]!, "2026-10-10", 0n, "owner");
    expect((await K.reconciliationView(book, rec2)).lines.find((l) => l.number === "CPY-0003")?.ticked).toBe(true);
    await K.discardReconciliation(book, rec2);
  });

  it("rules: saved with checks; a transfer rule and a split rule record the line their way", async () => {
    await B.createMoneyAccount(book, { subtype: "cash", name: "Petty cash", opening: 0n, date: "2026-10-01" }, null);
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
    await expect(K.saveBankRule(book, { contains: "12", direction: "out", kind: "account", accountId: acc["Rent"]! }, null)).rejects.toThrow(/word/);
    await expect(K.saveBankRule(book, { contains: "CASH WITHDRAWAL", direction: "out", kind: "transfer", accountId: acc["Rent"]! }, null)).rejects.toThrow(/other account/);
    await expect(K.saveBankRule(book, { contains: "LANDLORD", direction: "out", kind: "account", accountId: "", split: [{ accountId: acc["Rent"]!, percent: 80 }, { accountId: acc["Utilities and internet"]!, percent: 10 }] }, null)).rejects.toThrow(/100%/);
    await expect(K.saveBankRule(book, { contains: "LANDLORD", direction: "out", kind: "account", accountId: acc["Rent"]!, minAmount: "500", maxAmount: "100" }, null)).rejects.toThrow(/smallest/);
    await K.saveBankRule(book, { contains: "CASH WITHDRAWAL", direction: "out", kind: "transfer", accountId: acc["Petty cash"]! }, null);
    await K.saveBankRule(book, { contains: "LANDLORD", direction: "out", kind: "account", accountId: "", split: [{ accountId: acc["Rent"]!, percent: 80 }, { accountId: acc["Utilities and internet"]!, percent: 20 }] }, null);
    await expect(K.saveBankRule(book, { contains: "landlord", direction: "out", kind: "account", accountId: acc["Rent"]! }, null)).rejects.toThrow(/already a rule/);
    await importRows("oct-f.csv", [
      ["2026-10-18", "ATM CASH WITHDRAWAL 0042", "-2000.00", ""],
      ["2026-10-19", "IBFT LANDLORD OCT", "-1000.01", ""],
    ]);
    const v = await review();
    const atm = v.lines.find((x) => x.description.startsWith("ATM"))!;
    const ll = v.lines.find((x) => x.description.includes("LANDLORD"))!;
    expect(atm.rule?.accountName).toBe("Moved to Petty cash");
    expect(ll.rule?.accountName).toBe("Rent 80% + Utilities and internet 20%");
    const res = await K.applySuggestions(book, [atm, ll].map((l) => ({ lineId: l.id, kind: "record" as const, accountId: l.rule!.accountId, contactId: l.rule!.contactId, ruleId: l.rule!.id })), null);
    expect(res.every((x) => x.ok)).toBe(true);
    const sums = await B.ledgerSums(book.id, { from: "2026-10-18", to: "2026-10-19" });
    expect(sums.get(acc["Petty cash"]!)).toBe(200000n);
    expect(sums.get(acc["Rent"]!)).toBe(80001n);
    expect(sums.get(acc["Utilities and internet"]!)).toBe(20000n);
    // A rule whose account is archived stops suggesting.
    await importRows("oct-g.csv", [["2026-10-21", "ATM CASH WITHDRAWAL 0043", "-100.00", ""]]);
    await prisma.bkAccount.update({ where: { id: acc["Petty cash"]! }, data: { archivedAt: new Date() } });
    expect((await review()).lines.find((x) => x.description.endsWith("0043"))?.rule).toBeNull();
  });

  it("an overlapping file: exact repeats skipped, near-repeats flagged, a balance gap reported", async () => {
    const r = await importRows("oct-a-again.csv", [
      ["2026-10-05", "TCS DEP", "15000.00", "15000.00"], // the same line: skipped
      ["2026-10-09", "TCS PART 1 (copy)", "4000.00", "19000.00"], // same date and amount, new wording: flagged
      ["2026-10-20", "NEW LINE", "100.00", "99999.00"], // balance doesn't follow
    ]);
    expect(r.duplicates).toBe(1);
    expect(r.possibleDuplicates).toBe(1);
    expect(r.balanceNotes.join(" ")).toMatch(/doesn't add up/);
    const flagged = await prisma.bkStatementLine.findFirstOrThrow({ where: { bookId: book.id, description: "TCS PART 1 (copy)" } });
    expect(flagged.dupOfId).not.toBeNull();
    const v = (await review()).lines.find((x) => x.description === "TCS PART 1 (copy)")!;
    expect(v.duplicateOf?.description).toBe("TCS PART 1");
    // A file that starts where the last import didn't end.
    const gap = await importRows("nov.csv", [["2026-11-02", "LATER", "10.00", "50000.00"]]);
    expect(gap.balanceNotes.join(" ")).toMatch(/starts from a balance of 49,990\b.*ended at 99,999\b/);
  });
});
