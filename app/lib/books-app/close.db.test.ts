/**
 * Closing the books and the comparison with Finance against Postgres (B6,
 * D-69, D-70), on synthetic data in a private schema with all of Growzar's
 * migrations (test-db.ts). Runs only with BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Closing the books and comparing with Finance", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../books/books.server");
  let book: Awaited<ReturnType<typeof import("../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const org = `close-org-${Date.now()}`;
  const store = `close-store-${Date.now()}`;
  const TODAY = "2026-11-05";
  const fresh = async () => (book = (await B.getBook(org))!);

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books/books.server");
    await prisma.organization.create({ data: { id: org, name: "Close Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, displayName: "Store One", currency: "PKR", timezone: "Asia/Karachi" } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: "2026-10-01", moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: "2026-10-01", storeIds: [store] } }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
    // A day's sales for the store, and rent for the whole business.
    const post = async (input: Parameters<typeof B.saveAndPost>[1]) => {
      const r = await B.saveAndPost(book, input, "owner");
      if (r.error) throw new Error(r.error.message);
    };
    await post({ type: "sales_summary", date: "2026-10-06", storeId: store, data: { debits: [{ accountId: acc["Meezan"]!, amount: "118000" }, { accountId: acc["Cost of what you sold"]!, amount: "40000" }], credits: [{ accountId: acc["Sales"]!, amount: "100000" }, { accountId: acc["Sales tax to pay"]!, amount: "18000" }, { accountId: acc["Stock"]!, amount: "40000" }] } });
    await post({ type: "expense", date: "2026-10-01", data: { paidFrom: acc["Meezan"]!, lines: [{ accountId: acc["Rent"]!, amount: "15000" }] } });
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("an accountant prepares a close; it changes nothing until an owner closes, which clears it", async () => {
    await expect(B.prepareClose(book, "2026-12-01", TODAY, "accountant")).rejects.toThrow(/already happened/);
    await B.prepareClose(book, "2026-10-31", TODAY, "accountant", "October's bank is reconciled");
    await fresh();
    expect(book.lockedThrough).toBeNull();
    expect(book.settings.preparedClose).toMatchObject({ through: "2026-10-31", by: "accountant", note: "October's bank is reconciled" });
    expect(await B.setClosedThrough(book, "2026-10-31", TODAY, "owner")).toBe("2026-10-31");
    await fresh();
    expect(book.lockedThrough).toBe("2026-10-31");
    expect(book.settings.preparedClose).toBeUndefined();
    expect(book.settings.storeIds).toEqual([store]);
    await expect(B.prepareClose(book, "2026-10-15", TODAY, "accountant")).rejects.toThrow(/already closed/);
    const log = await prisma.bkAuditEvent.findMany({ where: { bookId: book.id, action: { in: ["book.close_prepared", "book.closed"] } }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => [l.action, l.actor])).toEqual([["book.close_prepared", "accountant"], ["book.closed", "owner"]]);
  });

  it("a prepared close can be withdrawn; a close of fewer days leaves a later prepared one waiting", async () => {
    await B.prepareClose(book, "2026-11-04", TODAY, "accountant");
    await B.prepareClose(book, null, TODAY, "accountant");
    expect((await fresh()).settings.preparedClose).toBeUndefined();
    await B.prepareClose(book, "2026-11-04", TODAY, "accountant");
    await B.setClosedThrough(await fresh(), "2026-11-02", TODAY, "owner");
    expect((await fresh()).settings.preparedClose?.through).toBe("2026-11-04");
    await B.setClosedThrough(book, null, TODAY, "owner", "test over");
    await B.prepareClose(await fresh(), null, TODAY, "owner");
  });

  it("the pre-close check lists Inventorify when it's behind", async () => {
    await prisma.bkConnector.create({ data: { bookId: book.id, key: "inventorify", enabled: true, mode: "auto", startDate: B.toDbDate("2026-10-01"), syncedThrough: B.toDbDate("2026-10-20"), settings: {} } });
    expect((await B.closeCheck(book, "2026-10-31")).behind).toEqual([{ key: "inventorify", syncedThrough: "2026-10-20" }]);
  });

  it("Books next to Finance: the store's own lines, the whole business apart, and Finance's figures for the same days", async () => {
    const { compareWithFinance } = await import("./compare-finance.server");
    const { resolveRange } = await import("../books/dates");
    const c = await compareWithFinance(await fresh(), store, resolveRange({ range: "custom", from: "2026-10-01", to: "2026-10-31" }, TODAY, 7));
    expect(c.problems).toEqual([]);
    const row = (k: string) => c.rows!.find((r) => r.key === k)!;
    expect(row("sales")).toMatchObject({ books: 100_000n, finance: 0n, difference: 100_000n });
    expect(row("cogs").books).toBe(-40_000n);
    expect(row("unassigned").books).toBe(-15_000n);
    expect(c.booksNet).toBe(100_000n - 40_000n - 15_000n);
    expect(c.financeNet).toBe(0n);
    // No source is switched on here: the screen says Books has none of their figures.
    expect(c.coverage.map((x) => x.enabled)).toEqual([false, false, false]);
  });
});
