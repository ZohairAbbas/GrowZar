/**
 * Creating a book from setup (B2) against Postgres, in a private schema of
 * growzar_shadow (see app/lib/books/__tests__/test-db.ts). Runs only with
 * BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";
import type { SetupPlan } from "./setup";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Books setup against Postgres", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let S: typeof import("./setup.server");
  let B: typeof import("../books/books.server");
  let T: typeof import("../books/taxes.server");
  let prisma: import("@prisma/client").PrismaClient;
  const org = `books-setup-${Date.now()}`;
  const viewer = { userId: "user-1", memberId: "m-1", organizationId: org, role: "owner", scopedStoreIds: null };
  const plan: SetupPlan = {
    currency: "PKR",
    startDate: "2026-07-01",
    fiscalYearStartMonth: 7,
    timeZone: "Asia/Karachi",
    codBasis: "money",
    storeIds: ["store-a", "store-b"],
    moneyAccounts: [
      { subtype: "bank", name: "Meezan", opening: 10_000_000n },
      { subtype: "card", name: "Business card", opening: 50_000n },
    ],
    taxRates: [
      { name: "Sales tax 18%", kind: "sales", rateBp: 1800 },
      { name: "Sales tax 18% (claimable)", kind: "purchase", rateBp: 1800 },
      { name: "WHT on goods 4.5%", kind: "withholding", rateBp: 450 },
    ],
  };

  beforeAll(async () => {
    dropSchema = await openTestSchema();
    ({ prisma } = await import("~/lib/db.server"));
    S = await import("./setup.server");
    B = await import("../books/books.server");
    T = await import("../books/taxes.server");
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("makes the book with its settings, money, opening balances and tax rates on the right accounts", async () => {
    const book = await S.createBook(viewer, plan);
    expect(book.organizationId).toBe(org);
    expect(book.settings).toMatchObject({ timeZone: "Asia/Karachi", startDate: "2026-07-01", storeIds: ["store-a", "store-b"], codBasis: "money" });

    const accounts = await B.listAccounts(book);
    const named = (n: string) => accounts.find((a) => a.name === n)!;
    expect(named("Meezan").balance).toBe(10_000_000n);
    // A card's balance is what's owed on it: a credit on a liability.
    expect(named("Business card").balance).toBe(-50_000n);
    expect(accounts.reduce((s, a) => s + a.balance, 0n)).toBe(0n);
    const opening = await prisma.bkDocument.findFirstOrThrow({ where: { bookId: book.id, type: "opening" } });
    expect(opening.status).toBe("posted");
    expect(opening.date.toISOString().slice(0, 10)).toBe("2026-07-01");

    const rates = await T.listTaxRates(book);
    const rateAccount = (n: string) => accounts.find((a) => a.id === rates.find((r) => r.name === n)!.accountId)?.name;
    expect(rateAccount("Sales tax 18%")).toBe("Sales tax to pay");
    expect(rateAccount("Sales tax 18% (claimable)")).toBe("Tax you can claim back");
    expect(rateAccount("WHT on goods 4.5%")).toBe("Withholding tax to pay");
  });

  it("opening balances for the rest post on the start day, and the difference goes to the owner's money", async () => {
    const book = (await B.getBook(org))!;
    const accounts = await B.listAccounts(book);
    const id = (n: string) => accounts.find((a) => a.name === n)!.id;
    const r = await B.saveAndPost(
      book,
      { type: "opening", date: book.settings.startDate!, data: { lines: [{ accountId: id("Stock"), amount: "3000000" }, { accountId: id("Owed to suppliers"), amount: "1000000" }] }, clientKey: "opn-test-0001" },
      "user-1",
    );
    expect(r.error).toBeUndefined();
    const sums = await B.ledgerSums(book.id);
    expect(sums.get(id("Stock"))).toBe(3_000_000n);
    expect(sums.get(id("Owed to suppliers"))).toBe(-1_000_000n);
    expect(sums.get(id("Opening balance adjustment"))).toBe(-(10_000_000n - 50_000n) - 2_000_000n);
    // The same form sent twice records one entry.
    const again = await B.saveAndPost(book, { type: "opening", date: book.settings.startDate!, data: { lines: [{ accountId: id("Stock"), amount: "3000000" }] }, clientKey: "opn-test-0001" }, "user-1");
    expect(again.doc.id).toBe(r.doc.id);
  });
});
