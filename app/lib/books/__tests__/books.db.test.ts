/**
 * Books service layer against a real Postgres, including the migration's
 * triggers. Runs only when BOOKS_TEST_DATABASE_URL is set, in a private schema
 * of growzar_shadow (see test-db.ts).
 *
 * Ported from Financify's Books (0cc8732). Left for later items: bank
 * statements and reconciling (B5), full exports (B6), and from "foreign
 * currency" the revaluation, USD statements and connector checks (later, D-89).
 * Recurring entries and attachments are out of v1 (D-88).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "./test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Books against Postgres", () => {
  let B: typeof import("../books.server");
  let prisma: import("@prisma/client").PrismaClient;
  const org = `books-it-${Date.now()}`;
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
          { subtype: "card", name: "Business card", opening: 2_000_000n },
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

  const expense = (amount: string, account = "Packaging", date = "2026-07-05", extra: Partial<import("../books.server").DraftInput> = {}) =>
    B.saveAndPost(book, { type: "expense", date, data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc[account], amount }] }, ...extra }, "staff-1");

  const balance = async (name: string) => (await B.ledgerSums(book.id)).get(acc[name]!) ?? 0n;
  const fromDb = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  it("setup creates the chart, money accounts and a posted opening balance", async () => {
    expect(Object.keys(acc).length).toBeGreaterThan(35);
    expect(await balance("Meezan")).toBe(10_000_000n);
    expect(await balance("Business card")).toBe(-2_000_000n);
    expect(await balance("Opening balance adjustment")).toBe(-8_000_000n);
    const docs = await B.listDocuments(book, { types: ["opening"] });
    expect(docs.rows[0]).toMatchObject({ status: "posted", number: "OPN-0001" });
  });

  it("setup is idempotent", async () => {
    const again = await B.setupBook(org, { currency: "USD", fiscalYearStartMonth: 1, startDate: "2026-07-01", moneyAccounts: [{ subtype: "bank", name: "X", opening: 0n }] }, null);
    expect(again.id).toBe(book.id);
    expect(again.currency).toBe("PKR");
  });

  it("posts an expense, numbers it, and creates the new supplier", async () => {
    const { doc, error } = await expense("1250000", "Packaging", "2026-07-05", { newContactName: "Ali Packaging" });
    expect(error).toBeUndefined();
    expect(doc).toMatchObject({ status: "posted", number: "EXP-0001", total: 1250000n });
    expect(await balance("Meezan")).toBe(10_000_000n - 1_250_000n);
    const contact = (await B.listContacts(book)).find((c) => c.name === "Ali Packaging");
    expect(contact?.lastAccountId).toBe(acc["Packaging"]);
  });

  it("keeps a draft and explains when posting is refused", async () => {
    const { doc, error } = await B.saveAndPost(book, { type: "expense", date: "2026-07-06", data: { paidFrom: acc["Rent"], lines: [{ accountId: acc["Packaging"], amount: "100" }] } }, null);
    expect(error?.message).toMatch(/isn't a bank/);
    expect(doc.status).toBe("draft");
    await B.discardDraft(book, doc.id, null);
    expect(await B.getDocument(book, doc.id)).toBeNull();
  });

  it("cancels with a mirror entry; history stays; cancelling twice is refused", async () => {
    const { doc } = await expense("500000", "Rent", "2026-07-07");
    const before = await balance("Meezan");
    const cancelled = await B.cancelDocument(book, doc.id, "Wrong amount", "staff-1");
    expect(cancelled.status).toBe("cancelled");
    expect(await balance("Meezan")).toBe(before + 500_000n);
    expect(await balance("Rent")).toBe(0n);
    const found = await B.getDocument(book, doc.id);
    expect(found!.doc.entries.map((e) => e.kind)).toEqual(["post", "cancel"]);
    await expect(B.cancelDocument(book, doc.id, "again", null)).rejects.toThrow(/already cancelled/);
  });

  it("the database refuses to edit or delete posted history", async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE bk_entry_lines SET amount = amount + 1 WHERE "bookId" = '${book.id}'`)).rejects.toThrow(/permanent/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM bk_entries WHERE "bookId" = '${book.id}'`)).rejects.toThrow(/permanent/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM bk_audit_events WHERE "bookId" = '${book.id}'`)).rejects.toThrow(/permanent/);
  });

  it("the database refuses an unbalanced entry — loudly when checked in the transaction, silently-but-rolled-back at commit", async () => {
    const doc = await prisma.bkDocument.findFirstOrThrow({ where: { bookId: book.id, status: "posted" } });
    const before = await prisma.bkEntry.count({ where: { bookId: book.id } });
    const writeUnbalanced = (checkNow: boolean) =>
      prisma.$transaction(async (tx) => {
        const e = await tx.bkEntry.create({ data: { bookId: book.id, documentId: doc.id, kind: "post", date: new Date("2026-07-08") } });
        await tx.bkEntryLine.createMany({
          data: [
            { entryId: e.id, bookId: book.id, accountId: acc["Meezan"]!, amount: 100n, date: new Date("2026-07-08") },
            { entryId: e.id, bookId: book.id, accountId: acc["Rent"]!, amount: -99n, date: new Date("2026-07-08") },
          ],
        });
        if (checkNow) await tx.$executeRawUnsafe(`SET CONSTRAINTS bk_entry_lines_balanced IMMEDIATE`);
      });
    // What the service does: the check runs inside the transaction and throws.
    await expect(writeUnbalanced(true)).rejects.toThrow(/does not balance/);
    // Without it, Prisma resolves even though COMMIT failed — the reason the service checks early.
    await writeUnbalanced(false).catch(() => undefined);
    expect(await prisma.bkEntry.count({ where: { bookId: book.id } })).toBe(before);
  });

  it("numbers stay unique and gapless when posting concurrently", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => expense(String(1000 + i), "Office and supplies", "2026-07-09")));
    const nums = results.map((r) => Number(r.doc.number!.slice(4))).sort((a, b) => a - b);
    // EXP-0001 and EXP-0002 were used above; the cancelled one keeps its number.
    expect(nums).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("transfers, owner money and other income post to the right accounts", async () => {
    await B.saveAndPost(book, { type: "transfer", date: "2026-07-10", data: { from: acc["Meezan"], to: acc["Cash in hand"], amount: "300000" } }, null);
    await B.saveAndPost(book, { type: "owner_in", date: "2026-07-10", data: { to: acc["Meezan"], amount: "5000000" } }, null);
    await B.saveAndPost(book, { type: "owner_out", date: "2026-07-11", data: { from: acc["Cash in hand"], amount: "100000" } }, null);
    await B.saveAndPost(book, { type: "money_in", date: "2026-07-12", data: { receivedIn: acc["Meezan"], lines: [{ accountId: acc["Other income"], amount: "20000" }] } }, null);
    expect(await balance("Cash in hand")).toBe(200_000n);
    expect(await balance("Owner's capital")).toBe(-5_000_000n);
    expect(await balance("Owner's drawings")).toBe(100_000n);
    expect(await balance("Other income")).toBe(-20_000n);
  });

  it("reports balance and agree with each other", async () => {
    const { profitAndLoss, balanceSheet, trialBalance } = await import("../reports");
    const accounts = await B.reportAccounts(book);
    const sums = await B.ledgerSums(book.id);
    const tb = trialBalance(accounts, sums);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const inputs = await B.balanceSheetInputs(book, "2026-07-31");
    const bs = balanceSheet(inputs.accounts, inputs.balances, inputs.pnlBeforeYear);
    expect(bs.difference).toBe(0n);
    const pl = profitAndLoss(accounts, await B.ledgerSums(book.id, { from: "2026-07-01", to: "2026-07-31" }));
    expect(bs.equity.rows.find((r) => r.name === "Profit this year")?.amount).toBe(pl.netProfit);
    expect(pl.netProfit).toBe(20_000n - 1_250_000n - (1000n + 1001n + 1002n + 1003n + 1004n + 1005n + 1006n + 1007n));
  });

  it("the account register carries a running balance across pages", async () => {
    const all = await B.accountRegister(book, acc["Meezan"]!, { from: "2026-07-01", to: "2026-07-31", pageSize: 200 });
    const p2 = await B.accountRegister(book, acc["Meezan"]!, { from: "2026-07-01", to: "2026-07-31", page: 2, pageSize: 5 });
    expect(all.rows.at(-1)!.running).toBe(all.closing);
    expect(p2.rows[0]!.running).toBe(all.rows[5]!.running);
    expect(all.closing).toBe(await balance("Meezan"));
  });

  it("closed months refuse new postings; a cancel moves to the first open day", async () => {
    const { doc } = await expense("777", "Rent", "2026-07-20");
    await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: new Date("2026-07-31") } });
    const locked = { ...book, lockedThrough: "2026-07-31" };
    const r = await B.saveAndPost(locked, { type: "expense", date: "2026-07-25", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount: "5" }] } }, null);
    expect(r.error?.message).toMatch(/closed through 2026-07-31/);
    await B.discardDraft(book, r.doc.id, null);
    await B.cancelDocument(locked, doc.id, "late fix", null);
    const found = await B.getDocument(book, doc.id);
    expect(found!.doc.entries.find((e) => e.kind === "cancel")!.date.toISOString().slice(0, 10)).toBe("2026-08-01");
    await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: null } });
  });

  it("closing the books: forward, refusals, reopening with a reason, the activity log and the database backstop", async () => {
    const today = "2026-10-13";
    const draft = await B.saveDraft(book, { type: "expense", date: "2026-07-28", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount: "9" }] } }, null);
    try {
      expect((await B.closeCheck(book, "2026-07-31")).drafts).toBeGreaterThanOrEqual(1);
      await expect(B.setClosedThrough(book, "2026-10-14", today, null)).rejects.toThrow(/already happened/);
      await expect(B.setClosedThrough(book, "2026-7-31", today, null)).rejects.toThrow(/Choose a date/);
      await expect(B.setClosedThrough(book, null, today, null, "x")).rejects.toThrow(/already open/);
      expect(await B.setClosedThrough(book, "2026-07-31", today, "staff-1")).toBe("2026-07-31");
      await expect(B.setClosedThrough(book, "2026-07-31", today, null)).rejects.toThrow(/already closed/);
      // The draft in the closed month can't be saved; the stale BookView doesn't matter.
      await expect(B.postDocument(book, draft.id, null)).rejects.toThrow(/closed through 2026-07-31/);
      // Moving the date forward needs no reason; moving it back does.
      await B.setClosedThrough(book, "2026-08-05", today, null);
      await expect(B.setClosedThrough(book, "2026-07-31", today, null, "  ")).rejects.toThrow(/why you're reopening/);
      await B.setClosedThrough(book, "2026-07-31", today, "staff-1", "late bill");
      // The database refuses ledger lines in a closed period even if the app didn't check.
      const posted = (await B.listDocuments(book, { status: "posted", pageSize: 1 })).rows[0];
      await expect(
        prisma.$transaction(async (tx) => {
          const e = await tx.bkEntry.create({ data: { bookId: book.id, documentId: posted!.id, kind: "post", date: new Date("2026-07-15") } });
          await tx.bkEntryLine.createMany({
            data: [
              { entryId: e.id, bookId: book.id, accountId: acc["Rent"]!, amount: 1n, date: new Date("2026-07-15") },
              { entryId: e.id, bookId: book.id, accountId: acc["Meezan"]!, amount: -1n, date: new Date("2026-07-15") },
            ],
          });
        }),
      ).rejects.toThrow(/closed through/i);
      await B.setClosedThrough(book, null, today, null, "all open again");
      const log = await prisma.bkAuditEvent.findMany({ where: { bookId: book.id, action: { in: ["book.closed", "book.reopened"] } }, orderBy: { id: "asc" } });
      expect(log.map((e) => [e.action, (e.detail as any).from, (e.detail as any).to, (e.detail as any).reason ?? null])).toEqual([
        ["book.closed", null, "2026-07-31", null],
        ["book.closed", "2026-07-31", "2026-08-05", null],
        ["book.reopened", "2026-08-05", "2026-07-31", "late bill"],
        ["book.reopened", "2026-07-31", null, "all open again"],
      ]);
    } finally {
      await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: null } });
      await B.discardDraft(book, draft.id, null);
    }
  });

  it("a close waits for a posting in progress, and the posting still lands", async () => {
    const d = await B.saveDraft(book, { type: "expense", date: "2026-07-29", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount: "3" }] } }, null);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // A transaction that holds the same share lock a posting takes.
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM bk_books WHERE id = ${book.id} FOR SHARE`;
        await gate;
      }, { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 100));
      let closedAt = 0;
      const closing = B.setClosedThrough(book, "2026-07-31", "2026-10-13", null).then(() => (closedAt = Date.now()));
      await new Promise((r) => setTimeout(r, 300));
      expect(closedAt).toBe(0); // still waiting
      const releasedAt = Date.now();
      release();
      await holder;
      await closing;
      expect(closedAt).toBeGreaterThanOrEqual(releasedAt);
      await expect(B.postDocument(book, d.id, null)).rejects.toThrow(/closed through/);
    } finally {
      await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: null } });
      await B.discardDraft(book, d.id, null).catch(() => undefined);
    }
  });

  it("archiving: refused with a balance or for system accounts; archived accounts can't be posted to", async () => {
    await expect(B.setAccountArchived(book, acc["Packaging"]!, true, null)).rejects.toThrow(/still has a balance/);
    await expect(B.setAccountArchived(book, acc["Stock"]!, true, null)).rejects.toThrow(/Books needs this account/);
    await B.setAccountArchived(book, acc["Travel and transport"]!, true, null);
    const r = await expense("10", "Travel and transport", "2026-08-02");
    expect(r.error?.message).toMatch(/archived/);
    await B.discardDraft(book, r.doc.id, null);
    await B.setAccountArchived(book, acc["Travel and transport"]!, false, null);
  });

  it("new accounts get a free code in their range; duplicate names are refused", async () => {
    const a = await B.createAccount(book, { name: "Courier insurance", type: "expense", subtype: "operating" }, null);
    expect(a.code).toBe("6200");
    await expect(B.createAccount(book, { name: "courier insurance", type: "expense", subtype: "operating" }, null)).rejects.toThrow(/already exists/);
  });

  it("a double submit of the same form records one document, even when both arrive at once", async () => {
    const input = { type: "expense" as const, date: "2026-08-03", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount: "4242" }] }, clientKey: "dbl-submit-key-0001" };
    const [a, b] = await Promise.all([B.saveAndPost(book, input, null), B.saveAndPost(book, input, null)]);
    expect(a.doc.id).toBe(b.doc.id);
    expect(a.doc.status === "posted" || b.doc.status === "posted").toBe(true);
    const again = await B.saveAndPost(book, input, null); // a later retry
    expect(again.doc.id).toBe(a.doc.id);
    expect(await prisma.bkDocument.count({ where: { bookId: book.id, sourceRef: "dbl-submit-key-0001" } })).toBe(1);
    expect(await prisma.bkEntry.count({ where: { documentId: a.doc.id } })).toBe(1);
  });

  it("a malformed client key is ignored rather than trusted", async () => {
    const r = await B.saveAndPost(book, { type: "expense", date: "2026-08-03", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount: "1" }] }, clientKey: "bad key; drop" }, null);
    expect(r.doc.sourceRef).toBeNull();
  });

  it("a manual line can't name a contact from another book", async () => {
    const r = await B.saveAndPost(
      book,
      { type: "manual", date: "2026-08-04", data: { lines: [{ accountId: acc["Rent"], debit: "10", contactId: "someone-elses-contact" }, { accountId: acc["Meezan"], credit: "10" }] } },
      null,
    );
    expect(r.error?.message).toMatch(/contact that doesn't exist/);
    await B.discardDraft(book, r.doc.id, null);
  });

  it("restoring an archived contact or account can't create a duplicate name", async () => {
    const c1 = await B.createContact(book, { name: "Twin Traders", kinds: ["supplier"] }, null);
    await B.setContactArchived(book, c1.id, true, null);
    await B.createContact(book, { name: "twin traders", kinds: ["supplier"] }, null);
    await expect(B.setContactArchived(book, c1.id, false, null)).rejects.toThrow(/already called/);
    const a1 = await B.createAccount(book, { name: "Spare", type: "expense", subtype: "operating" }, null);
    await B.setAccountArchived(book, a1.id, true, null);
    await B.createAccount(book, { name: "SPARE", type: "expense", subtype: "operating" }, null);
    await expect(B.setAccountArchived(book, a1.id, false, null)).rejects.toThrow(/already called/);
  });

  it("setup twice at the same moment makes one book", async () => {
    const shop2 = `books-race-${Date.now()}`;
    const input = { currency: "PKR", fiscalYearStartMonth: 7, startDate: "2026-07-01", moneyAccounts: [{ subtype: "bank", name: "Bank", opening: 100n }] };
    const [x, y] = await Promise.all([B.setupBook(shop2, input, null), B.setupBook(shop2, input, null)]);
    expect(x.id).toBe(y.id);
    expect(await prisma.bkDocument.count({ where: { bookId: x.id } })).toBe(1);
    await B.purgeBooks(shop2);
  });

  it("setup refuses a money account named like a template account", async () => {
    await expect(
      B.setupBook(`books-x-${Date.now()}`, { currency: "PKR", fiscalYearStartMonth: 7, startDate: "2026-07-01", moneyAccounts: [{ subtype: "bank", name: "sales", opening: 0n }] }, null),
    ).rejects.toThrow(/already one of Books' accounts/);
  });

  it("a money account added later comes with its opening balance, atomically", async () => {
    const { account, openingId } = await B.createMoneyAccount(book, { subtype: "mobile_wallet", name: "JazzCash", opening: 250_000n, date: "2026-08-05" }, null);
    expect(account.code).toMatch(/^106/);
    expect(openingId).not.toBeNull();
    expect((await B.ledgerSums(book.id)).get(account.id)).toBe(250_000n);
    // A refused balance (closed month) leaves no half-made account behind.
    await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: new Date("2026-08-31") } });
    const locked = { ...book, lockedThrough: "2026-08-31" };
    await expect(B.createMoneyAccount(locked, { subtype: "cash", name: "Petty cash", opening: 100n, date: "2026-08-10" }, null)).rejects.toThrow(/closed through/);
    expect(await prisma.bkAccount.count({ where: { bookId: book.id, name: "Petty cash" } })).toBe(0);
    await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: null } });
    await expect(B.createMoneyAccount(book, { subtype: "bank", name: "jazzcash", opening: 0n, date: "2026-08-05" }, null)).rejects.toThrow(/already exists/);
    const plain = await B.createMoneyAccount(book, { subtype: "card", name: "Second card", opening: 0n, date: "2026-08-05" }, null);
    expect(plain.openingId).toBeNull();
  });

  it("sales summaries and courier payouts post and move 'owed by couriers' correctly", async () => {
    const s = await B.saveAndPost(
      book,
      {
        type: "sales_summary",
        date: "2026-08-06",
        data: {
          debits: [{ accountId: acc["Owed by couriers"], amount: "900000" }, { accountId: acc["Discounts given"], amount: "50000" }],
          credits: [{ accountId: acc["Sales"], amount: "850000" }, { accountId: acc["Shipping charged"], amount: "100000" }],
        },
      },
      null,
    );
    expect(s.error).toBeUndefined();
    expect(s.doc.number).toMatch(/^SAL-/);
    const p = await B.saveAndPost(
      book,
      { type: "courier_payout", date: "2026-08-07", newContactName: "TCS", newContactKind: "courier", data: { receivable: acc["Owed by couriers"], receivedIn: acc["Meezan"], received: "800000", deductions: [{ accountId: acc["Delivery charges"], amount: "90000" }] } },
      null,
    );
    expect(p.error).toBeUndefined();
    expect(await balance("Owed by couriers")).toBe(10_000n);
    const tcs = (await B.listContacts(book)).find((c) => c.name === "TCS");
    expect(tcs?.kinds).toEqual(["courier"]);
  });

  it("gateway payouts clear 'owed by payment gateways' and file the gateway as a contact", async () => {
    const s = await B.saveAndPost(
      book,
      { type: "sales_summary", date: "2026-08-06", data: { debits: [{ accountId: acc["Owed by payment gateways"], amount: "500000" }], credits: [{ accountId: acc["Sales"], amount: "500000" }] } },
      null,
    );
    expect(s.error).toBeUndefined();
    const p = await B.saveAndPost(
      book,
      {
        type: "gateway_payout",
        date: "2026-08-08",
        newContactName: "PayFast",
        newContactKind: "gateway",
        data: { receivable: acc["Owed by payment gateways"], receivedIn: acc["Meezan"], received: "485000", deductions: [{ accountId: acc["Payment gateway fees"], amount: "12500" }, { accountId: acc["Tax withheld by others"], amount: "2500" }] },
      },
      null,
    );
    expect(p.error).toBeUndefined();
    expect(p.doc.number).toMatch(/^GPY-/);
    expect(await balance("Owed by payment gateways")).toBe(0n);
    expect((await B.listContacts(book)).find((c) => c.name === "PayFast")?.kinds).toEqual(["gateway"]);
    // A gateway can't "keep" money as sales.
    const bad = await B.saveAndPost(
      book,
      { type: "gateway_payout", date: "2026-08-08", data: { receivable: acc["Owed by payment gateways"], receivedIn: acc["Meezan"], received: "100", deductions: [{ accountId: acc["Sales"], amount: "1" }] } },
      null,
    );
    expect(bad.error?.message).toMatch(/what the gateway kept/);
  });

  it("imported drafts: created once per day, refreshed while a draft, left alone once saved", async () => {
    const data = { debits: [{ accountId: acc["Owed by couriers"], amount: "100" }], credits: [{ accountId: acc["Sales"], amount: "100" }] };
    const a = await B.upsertImported(book, { source: "shopify_sales", sourceRef: "2026-08-08", type: "sales_summary", date: "2026-08-08", data, memo: "Shopify: 1 order" });
    expect(a.action).toBe("created");
    expect((await B.upsertImported(book, { source: "shopify_sales", sourceRef: "2026-08-08", type: "sales_summary", date: "2026-08-08", data, memo: "Shopify: 1 order" })).action).toBe("unchanged");
    const data2 = { debits: [{ accountId: acc["Owed by couriers"], amount: "150" }], credits: [{ accountId: acc["Sales"], amount: "150" }] };
    expect((await B.upsertImported(book, { source: "shopify_sales", sourceRef: "2026-08-08", type: "sales_summary", date: "2026-08-08", data: data2, memo: "Shopify: 2 orders" })).action).toBe("updated");
    await B.postDocument(book, a.doc.id, null);
    const after = await B.upsertImported(book, { source: "shopify_sales", sourceRef: "2026-08-08", type: "sales_summary", date: "2026-08-08", data, memo: "x" });
    expect(after.action).toBe("kept");
    expect(await prisma.bkDocument.count({ where: { bookId: book.id, source: "shopify_sales", sourceRef: "2026-08-08" } })).toBe(1);
    // Two runs racing on the same day still make one document.
    const [x, y] = await Promise.all([
      B.upsertImported(book, { source: "shopify_sales", sourceRef: "2026-08-09", type: "sales_summary", date: "2026-08-09", data, memo: "m" }),
      B.upsertImported(book, { source: "shopify_sales", sourceRef: "2026-08-09", type: "sales_summary", date: "2026-08-09", data, memo: "m" }),
    ]);
    expect(x.doc.id).toBe(y.doc.id);
    await expect(B.upsertImported(book, { source: "manual", sourceRef: "z", type: "sales_summary", date: "2026-08-09", data, memo: null })).rejects.toThrow(/bad connector source/);
  });

  describe("bills and payments", () => {
    let supplier: string;
    let other: string;
    const bill = (amount: string, extra: Record<string, unknown> = {}, contactId = supplier) =>
      B.saveAndPost(book, { type: "bill", date: "2026-08-10", contactId, data: { payable: acc["Owed to suppliers"], dueDate: "2026-08-25", lines: [{ accountId: acc["Packaging"], amount }], ...extra } }, null);
    const pay = (allocations: Array<{ billId: string; amount: string }>, contactId = supplier) =>
      B.saveAndPost(book, { type: "bill_payment", date: "2026-08-12", contactId, data: { payable: acc["Owed to suppliers"], paidFrom: acc["Meezan"], allocations } }, null);
    const open = async (id: string) => (await B.listBills(book, { ids: [id] }))[0]!.open;

    beforeAll(async () => {
      supplier = (await B.createContact(book, { name: "Box Co", kinds: ["supplier"] }, null)).id;
      other = (await B.createContact(book, { name: "Tape Co", kinds: ["supplier"] }, null)).id;
    });

    it("a bill puts the amount under 'You owe' for that supplier", async () => {
      const { doc, error } = await bill("50000", { reference: "BX-1" });
      expect(error).toBeUndefined();
      expect(doc.number).toMatch(/^BIL-/);
      expect((await B.listContacts(book)).find((c) => c.id === supplier)?.youOwe).toBe(50000n);
      expect(await open(doc.id)).toBe(50000n);
    });

    it("refuses: no supplier, due before the bill, a repeated supplier reference", async () => {
      const noSupplier = await B.saveAndPost(book, { type: "bill", date: "2026-08-10", data: { payable: acc["Owed to suppliers"], lines: [{ accountId: acc["Rent"], amount: "1" }] } }, null);
      expect(noSupplier.error?.message).toMatch(/Choose the supplier/);
      await B.discardDraft(book, noSupplier.doc.id, null);
      const early = await bill("1", { dueDate: "2026-08-01" });
      expect(early.error?.message).toMatch(/due date can't be before/);
      await B.discardDraft(book, early.doc.id, null);
      const dup = await bill("1", { reference: " bx-1 " });
      expect(dup.error?.message).toMatch(/already recorded bill/);
      await B.discardDraft(book, dup.doc.id, null);
      const otherSupplierSameRef = await bill("1", { reference: "BX-1" }, other);
      expect(otherSupplierSameRef.error).toBeUndefined();
    });

    it("part payments, then the rest; never more than is owed", async () => {
      const { doc: b } = await bill("10000", { reference: "BX-2" });
      const p1 = await pay([{ billId: b.id, amount: "4000" }]);
      expect(p1.error).toBeUndefined();
      expect(await open(b.id)).toBe(6000n);
      const over = await pay([{ billId: b.id, amount: "6001" }]);
      expect(over.error?.message).toMatch(/more than is still owed/);
      await B.discardDraft(book, over.doc.id, null);
      const p2 = await pay([{ billId: b.id, amount: "6000" }]);
      expect(p2.error).toBeUndefined();
      expect(await open(b.id)).toBe(0n);
    });

    it("two payments at the same moment can't overpay one bill", async () => {
      const { doc: b } = await bill("7000", { reference: "BX-3" });
      const [x, y] = await Promise.all([pay([{ billId: b.id, amount: "7000" }]), pay([{ billId: b.id, amount: "7000" }])]);
      const ok = [x, y].filter((r) => !r.error);
      expect(ok).toHaveLength(1);
      expect([x, y].find((r) => r.error)?.error?.message).toMatch(/more than is still owed/);
      expect(await open(b.id)).toBe(0n);
      for (const r of [x, y]) if (r.error) await B.discardDraft(book, r.doc.id, null);
    });

    it("one payment can cover several bills, but not another supplier's or an unsaved one", async () => {
      const { doc: b1 } = await bill("100", { reference: "BX-4" });
      const { doc: b2 } = await bill("200", { reference: "BX-5" });
      const both = await pay([{ billId: b1.id, amount: "100" }, { billId: b2.id, amount: "150" }]);
      expect(both.error).toBeUndefined();
      expect(both.doc.total).toBe(250n);
      expect([await open(b1.id), await open(b2.id)]).toEqual([0n, 50n]);
      const { doc: theirs } = await bill("300", { reference: "TP-1" }, other);
      const wrong = await pay([{ billId: theirs.id, amount: "10" }]);
      expect(wrong.error?.message).toMatch(/different supplier/);
      await B.discardDraft(book, wrong.doc.id, null);
      const draftBill = await B.saveDraft(book, { type: "bill", date: "2026-08-10", contactId: supplier, data: { payable: acc["Owed to suppliers"], lines: [{ accountId: acc["Rent"], amount: "5" }] } }, null);
      const unsaved = await pay([{ billId: draftBill.id, amount: "5" }]);
      expect(unsaved.error?.message).toMatch(/isn't saved/);
      await B.discardDraft(book, unsaved.doc.id, null);
      await B.discardDraft(book, draftBill.id, null);
    });

    it("a bill with payments can't be cancelled; cancelling the payment reopens the bill", async () => {
      const { doc: b } = await bill("900", { reference: "BX-6" });
      const { doc: p } = await pay([{ billId: b.id, amount: "900" }]);
      await expect(B.cancelDocument(book, b.id, "wrong", null)).rejects.toThrow(/Cancel those payments first/);
      await B.cancelDocument(book, p.id, "bounced", null);
      expect(await open(b.id)).toBe(900n);
      const allocs = await B.allocationsFor(book, { billId: b.id });
      expect(allocs.every((a) => a.voided)).toBe(true);
      await B.cancelDocument(book, b.id, "duplicate", null);
      expect(await open(b.id)).toBe(0n); // cancelled bills owe nothing
    });

    it("the payables account always equals what the open bills say", async () => {
      const bills = await B.listBills(book, { open: true });
      const openSum = bills.reduce((s, b) => s + b.open, 0n);
      expect(-(await balance("Owed to suppliers"))).toBe(openSum);
    });
  });

  it("bulk approve: oldest first, each on its own, never figures that changed since they were looked at", async () => {
    const draft = (date: string, amount: string) =>
      B.saveDraft(book, { type: "expense", date, data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount }] } }, null);
    const late = await draft("2026-08-20", "300");
    const early = await draft("2026-08-18", "100");
    const changed = await draft("2026-08-19", "200");
    const seenChanged = changed.updatedAt.toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await B.saveDraft(book, { id: changed.id, type: "expense", date: "2026-08-19", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount: "999" }] } }, null);
    // Closed month: one refused, the others still go through.
    const closed = await draft("2026-06-30", "50");
    await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: new Date("2026-06-30") } });
    const posted = (await B.listDocuments(book, { status: "posted", pageSize: 1 })).rows[0];

    const results = await B.approveDocuments(
      book,
      [
        { id: late.id, updatedAt: late.updatedAt.toISOString() },
        { id: early.id, updatedAt: early.updatedAt.toISOString() },
        { id: early.id, updatedAt: early.updatedAt.toISOString() }, // listed twice
        { id: changed.id, updatedAt: seenChanged },
        { id: closed.id, updatedAt: closed.updatedAt.toISOString() },
        { id: posted!.id, updatedAt: posted!.updatedAt.toISOString() },
        { id: "nope", updatedAt: "x" },
      ],
      null,
    );
    await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: null } });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId[early.id]!.ok && byId[late.id]!.ok).toBe(true);
    expect(Number(byId[early.id]!.number!.slice(4))).toBeLessThan(Number(byId[late.id]!.number!.slice(4))); // oldest first
    expect(byId[changed.id]).toMatchObject({ ok: false, message: expect.stringMatching(/changed since you looked/) });
    expect(byId[closed.id]).toMatchObject({ ok: false, message: expect.stringMatching(/closed through/) });
    expect(byId[posted!.id]).toMatchObject({ ok: false, message: "Already saved" });
    expect(byId["nope"]).toMatchObject({ ok: false, message: "It no longer exists" });
    expect(results.filter((r) => r.id === early.id)).toHaveLength(1);
    expect((await B.getDocument(book, changed.id))!.doc.status).toBe("draft");
    for (const id of [changed.id, closed.id]) await B.discardDraft(book, id, null);
  });

  it("bulk approve refuses an empty list and more than the limit", async () => {
    await expect(B.approveDocuments(book, [], null)).rejects.toThrow(/Choose what to save/);
    await expect(B.approveDocuments(book, Array.from({ length: B.MAX_APPROVE + 1 }, (_, i) => ({ id: `x${i}`, updatedAt: "" })), null)).rejects.toThrow(/up to 200/);
  });

  it("every write left an audit event", async () => {
    const n = await prisma.bkAuditEvent.count({ where: { bookId: book.id } });
    expect(n).toBeGreaterThan(30);
  });

  it("the store goes on every line, cancels included, and sums by store add up to the whole (D-65)", async () => {
    const before = await B.ledgerSums(book.id, { from: "2026-09-01", to: "2026-09-30" });
    const a = await B.saveAndPost(book, { type: "expense", date: "2026-09-02", storeId: "store-a", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Packaging"], amount: "700" }] } }, null);
    const b = await B.saveAndPost(book, { type: "expense", date: "2026-09-03", storeId: "store-b", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Packaging"], amount: "300" }] } }, null);
    const rent = await B.saveAndPost(book, { type: "expense", date: "2026-09-04", data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount: "50" }] } }, null);
    expect([a.error, b.error, rent.error]).toEqual([undefined, undefined, undefined]);
    const lines = await prisma.bkEntryLine.findMany({ where: { entry: { documentId: { in: [a.doc.id, b.doc.id, rent.doc.id] } } } });
    expect(lines.filter((l) => l.storeId === "store-a")).toHaveLength(2);
    expect(lines.filter((l) => l.storeId === "store-b")).toHaveLength(2);
    expect(lines.filter((l) => l.storeId === null)).toHaveLength(2);

    await B.cancelDocument(book, b.doc.id, "wrong store", null);
    const mirror = await prisma.bkEntryLine.findMany({ where: { entry: { documentId: b.doc.id, kind: "cancel" } } });
    expect(mirror.map((l) => l.storeId)).toEqual(["store-b", "store-b"]);

    const range = { from: "2026-09-01", to: "2026-09-30" };
    const [all, sa, sb, org] = await Promise.all([
      B.ledgerSums(book.id, range),
      B.ledgerSums(book.id, { ...range, storeId: "store-a" }),
      B.ledgerSums(book.id, { ...range, storeId: "store-b" }),
      B.ledgerSums(book.id, { ...range, storeId: null }),
    ]);
    expect(sa.get(acc["Packaging"]!)).toBe(700n);
    expect(sb.get(acc["Packaging"]!) ?? 0n).toBe(0n);
    expect(org.get(acc["Rent"]!)).toBe((before.get(acc["Rent"]!) ?? 0n) + 50n);
    for (const id of new Set([...all.keys()])) {
      expect((sa.get(id) ?? 0n) + (sb.get(id) ?? 0n) + (org.get(id) ?? 0n)).toBe(all.get(id));
    }

    // A connector's document carries its store too.
    const imp = await B.upsertImported(book, { source: "ad_spend", sourceRef: "store-a:meta:2026-09-05", type: "manual", date: "2026-09-05", storeId: "store-a", memo: null, data: { lines: [{ accountId: acc["Advertising"], debit: "10" }, { accountId: acc["Meezan"], credit: "10" }] } });
    const posted = await B.postDocument(book, imp.doc.id, null);
    expect(posted.storeId).toBe("store-a");
    expect((await B.ledgerSums(book.id, { ...range, storeId: "store-a" })).get(acc["Advertising"]!)).toBe(10n);
  });

  it("purge removes everything, past the permanence triggers", async () => {
    const other = `books-purge-${Date.now()}`;
    await B.setupBook(other, { currency: "PKR", fiscalYearStartMonth: 7, startDate: "2026-07-01", moneyAccounts: [{ subtype: "bank", name: "Bank", opening: 500n }] }, null);
    expect(await B.purgeBooks(other)).toBe(1);
    expect(await prisma.bkBook.findUnique({ where: { organizationId: other } })).toBeNull();
  });

  describe("ledger views and reports", () => {
    let V: typeof import("../ledger-views.server");
    let R: typeof import("../report-data.server");
    const from = "2026-07-01";
    const to = "2026-12-31";
    beforeAll(async () => {
      V = await import("../ledger-views.server");
      R = await import("../report-data.server");
    });

    it("general ledger: running balances end on each account's balance, and the whole ledger nets to zero", async () => {
      const gl = await V.generalLedger(book, { from, to });
      expect(gl.truncated).toBe(false);
      const sums = await B.ledgerSums(book.id, { to });
      for (const a of gl.accounts) {
        expect(a.closing).toBe(sums.get(a.account.id) ?? 0n);
        expect(a.lines.at(-1)?.running ?? a.opening).toBe(a.closing);
      }
      expect(gl.accounts.reduce((s, a) => s + a.closing, 0n)).toBe(0n);
      const one = await V.generalLedger(book, { from: "2026-08-01", to, accountId: acc["Meezan"] });
      expect(one.accounts.map((a) => a.account.id)).toEqual([acc["Meezan"]]);
      expect(one.accounts[0]!.opening).toBe((await B.ledgerSums(book.id, { to: "2026-07-31" })).get(acc["Meezan"]!) ?? 0n);
      const cut = await V.generalLedger(book, { from, to, limit: 3 });
      expect(cut.truncated).toBe(true);
      expect(cut.accounts.reduce((s, a) => s + a.lines.length, 0)).toBe(3);
      // End balances stay complete even when lines are cut short.
      expect(cut.accounts.find((a) => a.account.id === acc["Meezan"])?.closing).toBe(sums.get(acc["Meezan"]!));
    });

    it("journal: every entry balances and paging covers them all once", async () => {
      const total = await prisma.bkEntry.count({ where: { bookId: book.id, date: { gte: new Date(from), lte: new Date(to) } } });
      const seen = new Set<string>();
      for (let page = 1; ; page++) {
        const j = await V.journal(book, { from, to, page, pageSize: 7 });
        expect(j.count).toBe(total);
        for (const e of j.entries) {
          expect(e.lines.reduce((s, l) => s + l.amount, 0n)).toBe(0n);
          seen.add(e.id);
        }
        if (page * 7 >= j.count) break;
      }
      expect(seen.size).toBe(total);
    });

    it("activity: plain words, filters by kind, newest first", async () => {
      const all = await V.activityLog(book, {});
      expect(all.count).toBeGreaterThan(5);
      expect(all.events.every((e) => e.text && !e.text.includes("undefined"))).toBe(true);
      const settings = await V.activityLog(book, { kind: "settings" });
      expect(settings.events.length).toBeGreaterThan(0);
      expect(settings.events.some((e) => e.text === "Set up the books")).toBe(true);
      const docs = await V.activityLog(book, { kind: "document" });
      expect(docs.events.some((e) => e.text.startsWith("Saved to the books: "))).toBe(true);
      expect(docs.events.every((e) => !e.text.startsWith("Set up"))).toBe(true);
      expect(Number(all.events[0]!.id)).toBeGreaterThan(Number(all.events.at(-1)!.id));
    });

    it("owed to suppliers by age adds up to the payables balance", async () => {
      const a = await V.agedPayables(book, "2026-10-13");
      expect(a.payables).toBe(-(await balance("Owed to suppliers")));
      expect(a.total + a.notFromBills).toBe(a.payables);
      const open = (await B.listBills(book, { open: true })).reduce((s, b) => s + b.open, 0n);
      expect(a.total).toBe(open);
    });

    it("spending by supplier matches the ledger's costs and stock bought", async () => {
      const s = await V.spendingBySupplier(book, { from, to });
      const lines = await prisma.bkEntryLine.findMany({ where: { bookId: book.id, date: { gte: new Date(from), lte: new Date(to) } }, include: { entry: { select: { documentId: true } } } });
      const docs = new Map((await prisma.bkDocument.findMany({ where: { bookId: book.id }, select: { id: true, type: true } })).map((d) => [d.id, d.type]));
      const accounts = new Map((await B.reportAccounts(book)).map((x) => [x.id, x]));
      let expected = 0n;
      for (const l of lines) {
        const a = accounts.get(l.accountId)!;
        if (["sales_summary", "stock_adjustment", "opening"].includes(docs.get(l.entry.documentId)!)) continue;
        if (a.type === "expense" || (a.type === "asset" && a.subtype === "stock")) expected += l.amount;
      }
      expect(s.total).toBe(expected);
      expect(s.total).toBeGreaterThan(0n);
    });

    it("stock movement explains the Stock account's change", async () => {
      const stock = (await B.listAccounts(book)).find((x) => x.systemKey === "stock")!;
      const mv = await V.stockMovement(book, stock.id, from, to);
      const sums = await B.ledgerSums(book.id, { to });
      expect(mv.end).toBe(sums.get(stock.id) ?? 0n);
      expect(mv.start + mv.bought + mv.sold + mv.adjusted + mv.opening + mv.other).toBe(mv.end);
    });

    it("every report downloads as CSV, and the cash flow adds up", async () => {
      const params = new URLSearchParams({ range: "custom", from, to });
      for (const report of Object.keys(R.EXPORT_TITLES)) {
        const f = await R.reportFile(book, "2026-10-13", report, params);
        expect(f.body.startsWith("\uFEFF")).toBe(true);
        expect(f.body).not.toMatch(/undefined|NaN|\[object/);
        expect(f.filename).toMatch(/^[a-z0-9-]+$/);
      }
      for (const compare of ["months", "previous_period", "previous_year"]) {
        const r = await R.buildReport(book, "2026-10-13", "profit-and-loss", new URLSearchParams({ range: "custom", from, to, compare }));
        const plain = await R.buildReport(book, "2026-10-13", "profit-and-loss", params);
        expect(r.cols!.netProfit[0]! + (compare === "months" ? r.cols!.netProfit.slice(1).reduce((x, y) => x + y, 0n) : 0n)).toBe(plain.pl!.netProfit);
      }
      const { cf } = await R.buildCashFlow(book, "2026-10-13", params);
      expect(cf.difference).toBe(0n);
      const money = (await B.reportAccounts(book)).filter((x) => x.type === "asset" && ["bank", "cash", "mobile_wallet", "ad_wallet"].includes(x.subtype));
      const end = await B.ledgerSums(book.id, { to });
      expect(cf.closing).toBe(money.reduce((s, x) => s + (end.get(x.id) ?? 0n), 0n));
    });
  });

  describe("tax", () => {
    let T: typeof import("../taxes.server");
    const rates: Record<string, string> = {};
    beforeAll(async () => {
      T = await import("../taxes.server");
    });

    it("rates: validated by kind, unique by name, archived not deleted, audited", async () => {
      await expect(T.saveTaxRate(book, { name: "GST", kind: "sales", rateBp: 1800, accountId: acc["Tax you can claim back"]! }, null)).rejects.toThrow(/isn't a tax account you owe/);
      await expect(T.saveTaxRate(book, { name: "GST", kind: "sales", rateBp: 1800, accountId: null }, null)).rejects.toThrow(/Choose the account/);
      await expect(T.saveTaxRate(book, { name: "GST", kind: "nonsense", rateBp: 1800, accountId: null }, null)).rejects.toThrow(/what kind/);
      await expect(T.saveTaxRate(book, { name: "GST", kind: "sales", rateBp: -1, accountId: acc["Sales tax to pay"]! }, null)).rejects.toThrow(/rate like/);
      rates.sales = (await T.saveTaxRate(book, { name: "Sales tax 18%", kind: "sales", rateBp: 1800, accountId: acc["Sales tax to pay"]! }, "staff-1")).id;
      rates.input = (await T.saveTaxRate(book, { name: "GST input 18%", kind: "purchase", rateBp: 1800, accountId: acc["Tax you can claim back"]! }, null)).id;
      rates.cost = (await T.saveTaxRate(book, { name: "Tax not claimable", kind: "purchase", rateBp: 1000, accountId: null }, null)).id;
      rates.wht = (await T.saveTaxRate(book, { name: "WHT 4.5%", kind: "withholding", rateBp: 450, accountId: acc["Withholding tax to pay"]! }, null)).id;
      await expect(T.saveTaxRate(book, { name: "sales TAX 18%", kind: "sales", rateBp: 1700, accountId: acc["Sales tax to pay"]! }, null)).rejects.toThrow(/already a rate/);
      const changed = await T.saveTaxRate(book, { id: rates.sales, name: "Sales tax 18%", kind: "sales", rateBp: 1700, accountId: acc["Sales tax to pay"]! }, null);
      expect(changed.rateBp).toBe(1700);
      await T.saveTaxRate(book, { id: rates.sales, name: "Sales tax 18%", kind: "sales", rateBp: 1800, accountId: acc["Sales tax to pay"]! }, null);
      await T.setTaxRateArchived(book, rates.cost, true, null);
      expect((await T.listTaxRates(book)).map((r) => r.id)).not.toContain(rates.cost);
      expect((await T.listTaxRates(book, { includeArchived: true })).find((r) => r.id === rates.cost)?.archived).toBe(true);
      await T.setTaxRateArchived(book, rates.cost, false, null);
      expect(await prisma.bkAuditEvent.count({ where: { bookId: book.id, action: { startsWith: "tax_rate." } } })).toBe(8);
    });

    it("tax charged, claimed, withheld and paid — and the summary adds up", async () => {
      const from = "2026-09-01", to = "2026-09-30";
      const before = await T.taxSummary(book, from, to);
      const tax = (rateId: string, name: string, rateBp: number, accountId: string | null, amount: string) => ({ rateId, name, rateBp, accountId, amount });
      // Sold 10,000 + 18% tax for cash.
      const sale = await B.saveAndPost(book, { type: "money_in", date: "2026-09-02", data: { receivedIn: acc["Meezan"], lines: [{ accountId: acc["Other income"], amount: "1000000", tax: tax(rates.sales!, "Sales tax 18%", 1800, acc["Sales tax to pay"]!, "180000") }] } }, null);
      expect(sale.error).toBeUndefined();
      // Bought packaging 5,000 + 18% claimable, and 1,000 + 10% that can't be claimed.
      const buy = await B.saveAndPost(book, {
        type: "expense",
        date: "2026-09-03",
        data: {
          paidFrom: acc["Meezan"],
          lines: [
            { accountId: acc["Packaging"], amount: "500000", tax: tax(rates.input!, "GST input 18%", 1800, acc["Tax you can claim back"]!, "90000") },
            { accountId: acc["Packaging"], amount: "100000", tax: tax(rates.cost!, "Tax not claimable", 1000, null, "10000") },
          ],
        },
      }, null);
      expect(buy.error).toBeUndefined();
      // A bill of 20,000 paid with 4.5% withheld on the full amount.
      const supplier = (await B.listContacts(book)).find((c) => c.kinds.includes("supplier"))!.id;
      const bill = await B.saveAndPost(book, { type: "bill", date: "2026-09-04", contactId: supplier, data: { payable: acc["Owed to suppliers"], lines: [{ accountId: acc["Rent"], amount: "2000000" }] } }, null);
      expect(bill.error).toBeUndefined();
      const pay = await B.saveAndPost(book, { type: "bill_payment", date: "2026-09-05", contactId: supplier, data: { payable: acc["Owed to suppliers"], paidFrom: acc["Meezan"], allocations: [{ billId: bill.doc.id, amount: "2000000" }], withheld: { accountId: acc["Withholding tax to pay"], amount: "90000", rateId: rates.wht, name: "WHT 4.5%", rateBp: 450 } } }, null);
      expect(pay.error).toBeUndefined();
      // The bill is fully paid even though the bank paid less.
      expect((await B.listBills(book, { ids: [bill.doc.id] }))[0]!.open).toBe(0n);

      const t = await T.taxSummary(book, from, to);
      const acct = (name: string) => t.accounts.find((a) => a.accountId === acc[name])!;
      const prevEnd = (name: string) => before.accounts.find((a) => a.accountId === acc[name])?.end ?? 0n;
      expect(acct("Sales tax to pay").end - prevEnd("Sales tax to pay")).toBe(180000n);
      expect(acct("Tax you can claim back").end - prevEnd("Tax you can claim back")).toBe(90000n);
      expect(acct("Withholding tax to pay").end - prevEnd("Withholding tax to pay")).toBe(90000n);
      expect(t.net).toBe(t.owed - t.claimable);
      for (const a of t.accounts) expect(a.start + a.movements.reduce((s, m) => s + m.amount, 0n)).toBe(a.end);
      const byName = Object.fromEntries(t.rates.map((r) => [r.name, r]));
      expect(byName["Sales tax 18%"]).toMatchObject({ kind: "sales", base: 1000000n, tax: 180000n });
      expect(byName["GST input 18%"]).toMatchObject({ kind: "purchase", base: 500000n, tax: 90000n });
      expect(byName["Tax not claimable"]).toMatchObject({ kind: "purchase", base: 100000n, tax: 10000n });
      expect(byName["WHT 4.5%"]).toMatchObject({ kind: "withholding", base: 2000000n, tax: 90000n });

      // Pay it: sales tax and withholding owed, less what's claimable.
      const balances = await T.taxBalances(book, to);
      const owedNow = (name: string) => balances.find((b) => b.accountId === acc[name])!.balance;
      const paid = await B.saveAndPost(book, {
        type: "tax_payment",
        date: "2026-09-30",
        newContactName: "FBR",
        newContactKind: "tax_office",
        data: {
          paidFrom: acc["Meezan"],
          lines: [
            { accountId: acc["Sales tax to pay"], amount: owedNow("Sales tax to pay").toString() },
            { accountId: acc["Withholding tax to pay"], amount: owedNow("Withholding tax to pay").toString() },
            { accountId: acc["Tax you can claim back"], amount: owedNow("Tax you can claim back").toString() },
          ],
        },
      }, null);
      expect(paid.error).toBeUndefined();
      expect(paid.doc.number).toMatch(/^TAX-/);
      const after = await T.taxBalances(book, to);
      for (const name of ["Sales tax to pay", "Withholding tax to pay", "Tax you can claim back"]) expect(after.find((b) => b.accountId === acc[name])!.balance).toBe(0n);
      expect((await B.listContacts(book)).find((c) => c.name === "FBR")?.kinds).toEqual(["tax_office"]);
    });
  });

  describe("selling on credit", () => {
    let customer: string;
    let other: string;
    const rec = () => acc["Owed by customers"];
    const invoice = (amount: string, contactId = customer, extra: Record<string, unknown> = {}) =>
      B.saveAndPost(book, { type: "invoice", date: "2026-10-01", contactId, data: { receivable: rec(), dueDate: "2026-10-31", lines: [{ accountId: acc["Sales"], amount, tax: { accountId: acc["Sales tax to pay"], amount: "0" } }], ...extra } }, null);
    beforeAll(async () => {
      customer = (await B.createContact(book, { name: "Wholesale Co", kinds: ["customer"] }, null)).id;
      other = (await B.createContact(book, { name: "Other Buyer", kinds: ["customer"] }, null)).id;
    });

    it("invoices, part payments, credit notes and cancellations keep what's owed right", async () => {
      const inv = await invoice("100000");
      expect(inv.error).toBeUndefined();
      expect(inv.doc.number).toMatch(/^INV-/);
      const open = async (id: string) => (await B.listBills(book, { ids: [id], type: "invoice" }))[0]!.open;
      expect(await open(inv.doc.id)).toBe(100000n);
      // A bill can't be "paid" by a customer payment, and another customer's invoice is refused.
      const otherInv = await invoice("5000", other);
      const wrong = await B.saveAndPost(book, { type: "customer_payment", date: "2026-10-05", contactId: customer, data: { receivable: rec(), receivedIn: acc["Meezan"], allocations: [{ billId: otherInv.doc.id, amount: "100" }] } }, null);
      expect(wrong.error?.message).toMatch(/different customer/);
      await B.discardDraft(book, wrong.doc.id, null);
      // Part payment with 4% withheld by the customer.
      const pay = await B.saveAndPost(book, {
        type: "customer_payment",
        date: "2026-10-05",
        contactId: customer,
        data: { receivable: rec(), receivedIn: acc["Meezan"], allocations: [{ billId: inv.doc.id, amount: "60000" }], withheld: { accountId: acc["Tax you can claim back"], amount: "2400" } },
      }, null);
      expect(pay.error).toBeUndefined();
      expect(await open(inv.doc.id)).toBe(40000n);
      const over = await B.saveAndPost(book, { type: "customer_payment", date: "2026-10-06", contactId: customer, data: { receivable: rec(), receivedIn: acc["Meezan"], allocations: [{ billId: inv.doc.id, amount: "40001" }] } }, null);
      expect(over.error?.message).toMatch(/more than is still owed/);
      await B.discardDraft(book, over.doc.id, null);
      // A credit note set against the rest.
      const cn = await B.saveAndPost(book, { type: "credit_note", date: "2026-10-07", contactId: customer, data: { receivable: rec(), lines: [{ accountId: acc["Returns"], amount: "40000" }], allocations: [{ billId: inv.doc.id, amount: "40000" }] } }, null);
      expect(cn.error).toBeUndefined();
      expect(await open(inv.doc.id)).toBe(0n);
      // The invoice can't be cancelled while payments or credits stand against it.
      await expect(B.cancelDocument(book, inv.doc.id, "x", null)).rejects.toThrow(/payments or credit notes/);
      await B.cancelDocument(book, cn.doc.id, "wrong amount", null);
      expect(await open(inv.doc.id)).toBe(40000n);
      // A credit note on its own is fine (kept as credit).
      const loose = await B.saveAndPost(book, { type: "credit_note", date: "2026-10-08", contactId: customer, data: { receivable: rec(), lines: [{ accountId: acc["Discounts given"], amount: "500" }] } }, null);
      expect(loose.error).toBeUndefined();
    });

    it("sales tax on invoices counts in the tax summary; credit notes give it back", async () => {
      const T = await import("../taxes.server");
      const tax = (amount: string) => ({ name: "Invoice GST", rateBp: 1800, accountId: acc["Sales tax to pay"], amount });
      const inv = await B.saveAndPost(book, { type: "invoice", date: "2026-12-10", contactId: other, data: { receivable: rec(), lines: [{ accountId: acc["Sales"], amount: "10000", quantity: "4", unitPrice: "2500", tax: tax("1800") }] } }, null);
      expect(inv.error).toBeUndefined();
      expect(inv.doc.total).toBe(11800n);
      const cn = await B.saveAndPost(book, { type: "credit_note", date: "2026-12-11", contactId: other, data: { receivable: rec(), lines: [{ accountId: acc["Returns"], amount: "2500", tax: tax("450") }], allocations: [{ billId: inv.doc.id, amount: "2950" }] } }, null);
      expect(cn.error).toBeUndefined();
      const t = await T.taxSummary(book, "2026-12-01", "2026-12-31");
      expect(t.rates.find((r) => r.name === "Invoice GST")).toMatchObject({ kind: "sales", base: 7500n, tax: 1350n });
      const sales = t.accounts.find((a) => a.accountId === acc["Sales tax to pay"])!;
      expect(Object.fromEntries(sales.movements.map((m) => [m.label, m.amount]))).toMatchObject({ Invoices: 1800n, "Credit notes": -450n });
    });

    it("owed by customers, by age, adds up to the receivable balance", async () => {
      const V = await import("../ledger-views.server");
      const a = await V.agedReceivables(book, "2026-11-15");
      expect(a.total + a.notFromBills).toBe(a.payables);
      const wholesale = a.rows.find((r) => r.name === "Wholesale Co")!;
      // 40,000 open, due 31 Oct → 1–30 days late on 15 Nov.
      expect(wholesale.buckets[1]).toBe(40000n);
      expect(a.payables).toBe(await balance("Owed by customers"));
    });
  });

  describe("credits used later", () => {
    it("a supplier credit settles part now and the rest later; limits are enforced", async () => {
      const sup = (await B.createContact(book, { name: "Credit Supplier", kinds: ["supplier"] }, null)).id;
      const bill = (amount: string) => B.saveAndPost(book, { type: "bill", date: "2026-10-02", contactId: sup, data: { payable: acc["Owed to suppliers"], lines: [{ accountId: acc["Packaging"], amount }] } }, null);
      const b1 = (await bill("10000")).doc;
      const b2 = (await bill("8000")).doc;
      const open = async (id: string) => (await B.listBills(book, { ids: [id] }))[0]!.open;
      const credit = await B.saveAndPost(book, { type: "supplier_credit", date: "2026-10-03", contactId: sup, data: { payable: acc["Owed to suppliers"], lines: [{ accountId: acc["Packaging"], amount: "15000" }], allocations: [{ billId: b1.id, amount: "10000" }] } }, null);
      expect(credit.error).toBeUndefined();
      expect(credit.doc.number).toMatch(/^SCR-/);
      expect(await open(b1.id)).toBe(0n);
      expect(await B.creditLeft(book, credit.doc.id)).toBe(5000n);
      await expect(B.applyCredit(book, credit.doc.id, [{ billId: b2.id, amount: "5001" }], null)).rejects.toThrow(/left to use/);
      await expect(B.applyCredit(book, credit.doc.id, [{ billId: b1.id, amount: "1" }], null)).rejects.toThrow(/more than is still open/);
      const inv = (await B.listBills(book, { type: "invoice", open: true }))[0];
      if (inv) await expect(B.applyCredit(book, credit.doc.id, [{ billId: inv.id, amount: "1" }], null)).rejects.toThrow(/isn't a saved bill/);
      const r = await B.applyCredit(book, credit.doc.id, [{ billId: b2.id, amount: "5000" }], "staff-1");
      expect(r.left).toBe(0n);
      expect(await open(b2.id)).toBe(3000n);
      // Cancelling the credit reopens both bills.
      await B.cancelDocument(book, credit.doc.id, "wrong", null);
      expect(await open(b1.id)).toBe(10000n);
      expect(await open(b2.id)).toBe(8000n);
      await expect(B.applyCredit(book, credit.doc.id, [{ billId: b2.id, amount: "1" }], null)).rejects.toThrow(/Save the credit/);
    });
  });

  describe("sub-accounts, kinds and tags", () => {
    it("editing an account: kind within its type, parents one level deep, guards", async () => {
      const fb = await B.createAccount(book, { name: "Facebook ads", type: "expense", subtype: "operating", parentId: acc["Advertising"] }, null);
      expect(fb.parentId).toBe(acc["Advertising"]);
      await expect(B.createAccount(book, { name: "Under FB", type: "expense", subtype: "operating", parentId: fb.id }, null)).rejects.toThrow(/itself a sub-account/);
      await expect(B.createAccount(book, { name: "Wrong type", type: "income", subtype: "other", parentId: acc["Advertising"] }, null)).rejects.toThrow(/same type/);
      await expect(B.updateAccount(book, acc["Advertising"]!, { name: "Advertising", subtype: "operating", parentId: acc["Rent"]! }, null)).rejects.toThrow(/has sub-accounts/);
      await expect(B.setAccountArchived(book, acc["Advertising"]!, true, null)).rejects.toThrow();
      // Kind changes: within the type; money ↔ non-money refused once used; Books' own accounts keep theirs.
      await B.updateAccount(book, acc["Packaging"]!, { name: "Packaging", subtype: "operating", parentId: null }, null);
      expect((await prisma.bkAccount.findUniqueOrThrow({ where: { id: acc["Packaging"] } })).subtype).toBe("operating");
      await B.updateAccount(book, acc["Packaging"]!, { name: "Packaging", subtype: "cost_of_sales", parentId: null }, null);
      await expect(B.updateAccount(book, acc["Meezan"]!, { name: "Meezan", subtype: "receivable", parentId: null }, null)).rejects.toThrow(/money account has entries/);
      await expect(B.updateAccount(book, acc["Stock"]!, { name: "Stock", subtype: "other", parentId: null }, null)).rejects.toThrow(/Books uses this account/);
      await expect(B.updateAccount(book, acc["Sales tax to pay"]!, { name: "Sales tax to pay", subtype: "other", parentId: null }, null)).rejects.toThrow(/tax rate uses this account/);
      await expect(B.updateAccount(book, acc["Rent"]!, { name: "Meezan", subtype: "operating", parentId: null }, null)).rejects.toThrow(/already exists/);
      // A posting to the child shows under its parent in the P&L.
      await B.saveAndPost(book, { type: "expense", date: "2027-02-02", data: { paidFrom: acc["Meezan"], lines: [{ accountId: fb.id, amount: "1234" }] } }, null);
      const R = await import("../report-data.server");
      const r = await R.buildReport(book, "2027-02-28", "profit-and-loss", new URLSearchParams({ range: "custom", from: "2027-02-01", to: "2027-02-28" }));
      const rows = r.pl!.expenses.rows;
      const head = rows.find((x) => x.accountId === acc["Advertising"] && x.header);
      expect(head?.amount).toBe(1234n);
      expect(rows.find((x) => x.accountId === fb.id)).toMatchObject({ depth: 1, amount: 1234n });
    });

    it("tags: tidy, case-folded to the existing spelling, filter the P&L, and columns add up", async () => {
      const a = await expense("1000", "Rent", "2027-03-05");
      const b = await expense("2500", "Rent", "2027-03-06");
      await expect(B.setDocumentTags(book, a.doc.id, Array.from({ length: 11 }, (_, i) => `t${i}`), null)).rejects.toThrow(/Up to 10/);
      expect(await B.setDocumentTags(book, a.doc.id, [" Website ", "website", "Brand A"], "staff-1")).toEqual(["Website", "Brand A"]);
      expect(await B.setDocumentTags(book, b.doc.id, ["WEBSITE"], null)).toEqual(["Website"]);
      const tags = await B.listTags(book);
      expect(tags.find((t) => t.tag === "Website")?.count).toBe(2);
      const R = await import("../report-data.server");
      const p = (extra: Record<string, string>) => R.buildReport(book, "2027-03-31", "profit-and-loss", new URLSearchParams({ range: "custom", from: "2027-03-01", to: "2027-03-31", ...extra }));
      const all = await p({});
      const web = await p({ tag: "Website" });
      const brand = await p({ tag: "Brand A" });
      const none = await p({ tag: "__none" });
      expect(web.pl!.expenses.total).toBe(3500n);
      expect(brand.pl!.expenses.total).toBe(1000n);
      expect(web.pl!.netProfit + none.pl!.netProfit).toBe(all.pl!.netProfit);
      const byTag = await p({ compare: "tags" });
      expect(byTag.columns!.map((c) => c.label)).toEqual(expect.arrayContaining(["Website", "Brand A", "No tag"]));
      const webCol = byTag.columns!.findIndex((c) => c.label === "Website");
      expect(byTag.cols!.netProfit[webCol]).toBe(web.pl!.netProfit);
      // Tagging a cancelled entry is allowed (labels aren't the ledger).
      await B.cancelDocument(book, b.doc.id, "dup", null);
      expect(await B.setDocumentTags(book, b.doc.id, [], null)).toEqual([]);
    });

    it("the balance sheet against an earlier date", async () => {
      const R = await import("../report-data.server");
      const r = await R.buildReport(book, "2027-03-31", "balance-sheet", new URLSearchParams({ date: "2027-03-31", compare: "previous_month" }));
      expect(r.bsDates).toEqual(["2027-03-31", "2027-02-28"]);
      const plain = await R.buildReport(book, "2027-02-28", "balance-sheet", new URLSearchParams({ date: "2027-02-28" }));
      expect(r.bsCols!.assets.totals[1]).toBe(plain.bs!.assets.total);
      expect(r.bsCols!.equity.totals[0]).toBe(r.bs!.equity.total);
      const y = await R.buildReport(book, "2027-02-28", "balance-sheet", new URLSearchParams({ date: "2028-02-29", compare: "previous_year" }));
      expect(y.bsDates).toEqual(["2028-02-29", "2027-02-28"]);
    });
  });

  it("the accountant pack is a ZIP with every report for the period, each a non-empty CSV", async () => {
    const { inflateRawSync } = await import("node:zlib");
    const { accountantPack } = await import("../report-data.server");
    const pack = await accountantPack(book, "2026-10-13", new URLSearchParams({ range: "custom", from: "2026-07-01", to: "2026-09-30" }));
    expect(pack.filename).toBe("books-2026-07-01-2026-09-30");
    // Read the archive back through its central directory.
    const z = pack.body;
    const end = z.length - 22;
    expect(z.readUInt32LE(end)).toBe(0x06054b50);
    const count = z.readUInt16LE(end + 10);
    let at = z.readUInt32LE(end + 16);
    const files: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      expect(z.readUInt32LE(at)).toBe(0x02014b50);
      const size = z.readUInt32LE(at + 20);
      const nameLen = z.readUInt16LE(at + 28);
      const extra = z.readUInt16LE(at + 30) + z.readUInt16LE(at + 32);
      const local = z.readUInt32LE(at + 42);
      const name = z.subarray(at + 46, at + 46 + nameLen).toString("utf8");
      const dataAt = local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28);
      files[name] = inflateRawSync(z.subarray(dataAt, dataAt + size)).toString("utf8");
      at += 46 + nameLen + extra;
    }
    expect(Object.keys(files)).toHaveLength(13);
    expect(files["README.txt"]).toContain("2026-07-01 to 2026-09-30");
    for (const [name, body] of Object.entries(files)) {
      if (name.endsWith(".csv")) expect(body.startsWith("\uFEFF"), name).toBe(true);
    }
    expect(files["01 Profit and loss.csv"]).toContain("Profit and loss");
    expect(files["02 Profit and loss by month.csv"]).toContain("2026-08-01 to 2026-08-31");
    // The trial balance in the pack balances.
    const total = files["04 Trial balance.csv"]!.trim().split("\r\n").at(-1)!.split(",");
    expect(total[1]).toBe("Total");
    expect(total[2]).toBe(total[3]);
    expect(files["06 General ledger.csv"]!.split("\r\n").length).toBeGreaterThan(5);
  });

  describe("foreign currency", () => {
    let usd: string;
    let card: string;
    const fxBal = async (id: string) => (await B.foreignBalances(book.id, [id])).get(id) ?? 0n;

    it("a USD account starts with its balance in USD and its value in PKR", async () => {
      await expect(B.createMoneyAccount(book, { subtype: "bank", name: "Payoneer", opening: 2800000n, date: "2027-05-01", currency: "USD", fxOpening: null }, null)).rejects.toThrow(/both empty/);
      const r = await B.createMoneyAccount(book, { subtype: "bank", name: "Payoneer", opening: 2800000n, date: "2027-05-01", currency: "USD", fxOpening: 10000n }, null);
      usd = r.account.id;
      expect(r.account.currency).toBe("USD");
      expect(await fxBal(usd)).toBe(10000n);
      expect((await B.ledgerSums(book.id)).get(usd)).toBe(2800000n);
      // The book's own currency isn't "foreign".
      const pk = await B.createMoneyAccount(book, { subtype: "cash", name: "PKR box", opening: 0n, date: "2027-05-01", currency: "PKR" }, null);
      expect(pk.account.currency).toBeNull();
      card = (await B.createMoneyAccount(book, { subtype: "card", name: "USD card", opening: 0n, date: "2027-05-01", currency: "USD" }, null)).account.id;
      const list = await B.listAccounts(book);
      expect(list.find((a) => a.id === usd)).toMatchObject({ currency: "USD", fxBalance: 10000n });
      expect(list.find((a) => a.name === "Meezan")?.fxBalance).toBeNull();
    });

    it("spending on the USD card keeps both amounts; cancelling reverses both", async () => {
      const missing = await B.saveAndPost(book, { type: "expense", date: "2027-05-03", data: { paidFrom: card, lines: [{ accountId: acc["Advertising"], amount: "28100" }] } }, null);
      expect(missing.error?.message).toMatch(/amount in USD/);
      await B.discardDraft(book, missing.doc.id, null);
      const e = await B.saveAndPost(book, { type: "expense", date: "2027-05-03", data: { paidFrom: card, lines: [{ accountId: acc["Advertising"], amount: "28100" }], fx: { [card]: { amount: "100" } } } }, null);
      expect(e.error).toBeUndefined();
      expect(await fxBal(card)).toBe(-100n);
      await B.cancelDocument(book, e.doc.id, "wrong card", null);
      expect(await fxBal(card)).toBe(0n);
      expect((await B.ledgerSums(book.id)).get(card) ?? 0n).toBe(0n);
    });
  });
});

