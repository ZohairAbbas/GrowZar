/**
 * Bank statements and reconciling against Postgres (B5a): Financify's
 * "bank statements and reconciling" block from its books.db suite (0cc8732),
 * on its own book. Runs only with BOOKS_TEST_DATABASE_URL, in a private schema.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "./test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Bank statements against Postgres", () => {
  let B: typeof import("../books.server");
  let prisma: import("@prisma/client").PrismaClient;
  const org = `books-bank-${Date.now()}`;
  let dropSchema: (() => Promise<void>) | undefined;
  let book: Awaited<ReturnType<typeof B.setupBook>>;
  const acc: Record<string, string> = {};

  beforeAll(async () => {
    dropSchema = await openTestSchema();
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books.server");
    book = await B.setupBook(
      org,
      {
        currency: "PKR",
        fiscalYearStartMonth: 7,
        timeZone: "Asia/Karachi",
        startDate: "2026-07-01",
        moneyAccounts: [
          { subtype: "bank", name: "Meezan", opening: 10_000_000n },
          { subtype: "cash", name: "Cash in hand", opening: 0n },
        ],
      },
      "staff-1",
    );
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
  });

  afterAll(async () => {
    if (B && book) await B.purgeBooks(org);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  const expense = (amount: string, account = "Packaging", date = "2026-07-05") =>
    B.saveAndPost(book, { type: "expense", date, data: { paidFrom: acc["Meezan"]!, lines: [{ accountId: acc[account]!, amount }] } }, "staff-1");

  describe("bank statements and reconciling", () => {
    let K: typeof import("../bank.server");
    let existing: { id: string; number: string | null };
    const csv = (rows: string[]) => ["Date,Description,Debit,Credit,Balance", ...rows].join("\n");
    const mapping = { headerRow: 0, dateCol: 0, dateFormat: "DMY", descCols: [1], amountCol: null, outCol: 2, inCol: 3, balanceCol: 4, flip: false };
    beforeAll(async () => {
      K = await import("../bank.server");
      // An expense already in the books that the statement will show two days later.
      const r = await expense("4321", "Rent", "2026-11-02");
      existing = { id: r.doc.id, number: r.doc.number };
    });

    it("imports a statement; importing it again adds nothing", async () => {
      const text = csv(["04/11/2026,RENT NOV,43.21,,1", "05/11/2026,IBFT ALI TRADERS 1234,250.00,,2", "06/11/2026,COD SETTLEMENT,,1000.00,3", "06/11/2026,COD SETTLEMENT,,1000.00,3"]);
      const first = await K.importStatement(book, { accountId: acc["Meezan"]!, fileName: "nov.csv", text, mapping }, "staff-1");
      expect(first).toMatchObject({ added: 4, duplicates: 0, problemCount: 0 });
      const again = await K.importStatement(book, { accountId: acc["Meezan"]!, fileName: "nov.csv", text, mapping }, null);
      expect(again).toMatchObject({ added: 0, duplicates: 4, importId: null });
      await expect(K.importStatement(book, { accountId: acc["Rent"]!, fileName: null, text, mapping }, null)).rejects.toThrow(/isn't a bank/);
      await expect(K.importStatement(book, { accountId: acc["Meezan"]!, fileName: null, text, mapping: { ...mapping, dateFormat: "nope" } }, null)).rejects.toThrow(/dates are written/);
    });

    it("suggests the existing entry, matches it once, and refuses wrong matches", async () => {
      const review = await K.statementReview(book, acc["Meezan"]!, {});
      expect(review.counts.open).toBe(4);
      const rent = review.lines.find((l) => l.description === "RENT NOV")!;
      expect(rent.suggestion?.number).toBe(existing.number);
      const cod = review.lines.filter((l) => l.description === "COD SETTLEMENT");
      await expect(K.matchStatementLine(book, cod[0]!.id, rent.suggestion!.entryLineId)).rejects.toThrow(/amounts are different/);
      await K.matchStatementLine(book, rent.id, rent.suggestion!.entryLineId);
      await expect(K.matchStatementLine(book, rent.id, rent.suggestion!.entryLineId)).rejects.toThrow(/already matched/);
      const after = await K.statementReview(book, acc["Meezan"]!, { show: "matched" });
      expect(after.lines.map((l) => l.matched?.number)).toEqual([existing.number]);
    });

    it("records a line as a new entry, remembers a rule, and applies it to the next statement", async () => {
      const review = await K.statementReview(book, acc["Meezan"]!, {});
      const ali = review.lines.find((l) => l.description.startsWith("IBFT ALI"))!;
      expect(ali.ruleWords).toBe("IBFT ALI TRADERS");
      const r = await K.recordFromStatementLine(book, ali.id, { accountId: acc["Packaging"]!, newContactName: "Ali Traders", remember: true, ruleWords: ali.ruleWords }, "staff-1");
      expect(r.linked).toBe(true);
      expect(r.number).toMatch(/^EXP-/);
      const doc = await B.getDocument(book, r.documentId);
      expect(doc!.doc.date.toISOString().slice(0, 10)).toBe("2026-11-05");
      expect((doc!.doc.data as any).paidFrom).toBe(acc["Meezan"]!);
      // Recording twice (double click) doesn't make a second entry.
      await expect(K.recordFromStatementLine(book, ali.id, { accountId: acc["Packaging"]! }, null)).rejects.toThrow(/already matched/);
      expect(await prisma.bkDocument.count({ where: { bookId: book.id, sourceRef: `stmt-line-${ali.id}` } })).toBe(1);
      const rules = await K.listBankRules(book);
      expect(rules.map((x) => [x.contains, x.direction, x.accountName, x.contactName])).toEqual([["IBFT ALI TRADERS", "out", "Packaging", "Ali Traders"]]);

      await K.importStatement(book, { accountId: acc["Meezan"]!, fileName: "dec.csv", text: csv(["03/12/2026,IBFT 999 ALI TRADERS,75.00,,9"]), mapping }, null);
      const next = await K.statementReview(book, acc["Meezan"]!, {});
      const line = next.lines.find((l) => l.description.includes("999"))!;
      expect(line.rule?.accountName).toBe("Packaging");
      // In a closed period: refused, and no draft left behind.
      await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: new Date("2026-12-31") } });
      const drafts = await prisma.bkDocument.count({ where: { bookId: book.id, status: "draft" } });
      const refused = await K.applySuggestions(book, [{ lineId: line.id, kind: "record", accountId: line.rule!.accountId, contactId: line.rule!.contactId }], null);
      expect(refused[0]).toMatchObject({ ok: false, message: expect.stringMatching(/closed through 2026-12-31/) });
      expect(await prisma.bkDocument.count({ where: { bookId: book.id, status: "draft" } })).toBe(drafts);
      await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: null } });
      const res = await K.applySuggestions(book, [{ lineId: line.id, kind: "record", accountId: line.rule!.accountId, contactId: line.rule!.contactId }], null);
      expect(res).toEqual([{ lineId: line.id, ok: true }]);
    });

    it("a matched entry that gets cancelled goes back to review; ignoring and undoing imports", async () => {
      const matched = await K.statementReview(book, acc["Meezan"]!, { show: "matched" });
      const ali = matched.lines.find((l) => l.description.startsWith("IBFT ALI TRADERS"))!;
      await B.cancelDocument(book, ali.matched!.id, "wrong", null);
      const open = await K.statementReview(book, acc["Meezan"]!, {});
      expect(open.lines.some((l) => l.id === ali.id)).toBe(true);
      const cods = open.lines.filter((l) => l.description === "COD SETTLEMENT");
      await K.setStatementLineIgnored(book, cods[1]!.id, true);
      expect((await K.statementReview(book, acc["Meezan"]!, { show: "ignored" })).count).toBe(1);
      const imports = await prisma.bkStatementImport.findMany({ where: { bookId: book.id }, orderBy: { createdAt: "asc" } });
      await expect(K.undoImport(book, imports[0]!.id, null)).rejects.toThrow(/already matched/);
      // The December line was recorded by its rule: refused until it's unmatched.
      await expect(K.undoImport(book, imports[1]!.id, null)).rejects.toThrow(/already matched/);
      const decLine = await prisma.bkStatementLine.findFirstOrThrow({ where: { importId: imports[1]!.id } });
      await K.unmatchStatementLine(book, decLine.id.toString());
      await K.undoImport(book, imports[1]!.id, null);
      expect(await prisma.bkStatementLine.count({ where: { importId: imports[1]!.id } })).toBe(0);
    });

    it("reconciles: start, tick to zero, finish; later dates only; undo with a reason", async () => {
      const at = "2026-11-30";
      const sums = await B.ledgerSums(book.id, { to: at });
      const bank = sums.get(acc["Meezan"]!) ?? 0n;
      await expect(K.startReconciliation(book, acc["Meezan"]!, "x", bank, null)).rejects.toThrow(/end date/);
      const recId = await K.startReconciliation(book, acc["Meezan"]!, at, bank, "staff-1");
      let v = await K.reconciliationView(book, recId);
      // The matched rent line, and the cancelled expense's pair, start ticked.
      expect(v.lines.filter((l) => l.ticked).length).toBeGreaterThanOrEqual(3);
      expect(v.difference).not.toBe(0n);
      await expect(K.finishReconciliation(book, recId, null)).rejects.toThrow(/don't agree yet/);
      await K.setCleared(book, recId, v.lines.map((l) => l.id), true);
      v = await K.reconciliationView(book, recId);
      expect(v.difference).toBe(0n);
      expect(v.cleared).toBe(bank);
      // Restarting keeps one reconciliation in progress per account.
      expect(await K.startReconciliation(book, acc["Meezan"]!, at, bank, null)).toBe(recId);
      await K.finishReconciliation(book, recId, "staff-1");
      await expect(K.setCleared(book, recId, [v.lines[0]!.id], false)).rejects.toThrow(/finished/);
      await expect(K.startReconciliation(book, acc["Meezan"]!, "2026-11-15", bank, null)).rejects.toThrow(/reconciled through 2026-11-30/);
      // Next month starts from what was cleared.
      const dec = await K.startReconciliation(book, acc["Meezan"]!, "2026-12-31", bank, null);
      const dv = await K.reconciliationView(book, dec);
      expect(dv.previous).toBe(bank);
      expect(dv.lines.every((l) => l.date > at || !l.ticked)).toBe(true);
      await expect(K.undoLastReconciliation(book, acc["Meezan"]!, "oops", null)).rejects.toThrow(/in progress/);
      await K.discardReconciliation(book, dec);
      await expect(K.undoLastReconciliation(book, acc["Meezan"]!, "  ", null)).rejects.toThrow(/why/);
      await K.undoLastReconciliation(book, acc["Meezan"]!, "statement was wrong", "staff-1");
      expect((await prisma.bkReconciliation.findUniqueOrThrow({ where: { id: recId } })).status).toBe("open");
      const overview = await K.bankOverview(book);
      const meezan = overview.find((o) => o.id === acc["Meezan"]!)!;
      expect(meezan.openReconciliationId).toBe(recId);
      expect(meezan.toReview).toBeGreaterThan(0);
      expect(meezan.lastStatementDate).toBe("2026-11-06");
    });
  });

});
