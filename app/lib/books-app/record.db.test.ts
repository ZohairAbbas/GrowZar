/**
 * Recording by hand (B4) against Postgres: every kind of entry through
 * saveRecord (the Record screen's own path), the drafts inbox, cancelling,
 * and the whole book still adding up. Runs only with BOOKS_TEST_DATABASE_URL,
 * in a private schema (app/lib/books/__tests__/test-db.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";
import type { RecordInput } from "./record.server";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Recording by hand against Postgres", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../books/books.server");
  let RS: typeof import("./record.server");
  let T: typeof import("../books/taxes.server");
  let book: Awaited<ReturnType<typeof import("../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const rate: Record<string, string> = {};
  const org = `rec-org-${Date.now()}`;
  const D = "2026-10-10";
  let n = 0;

  const rec = (type: RecordInput["type"], data: Record<string, unknown>, extra: Partial<RecordInput> = {}) =>
    RS.saveRecord(book, { type, date: D, data, clientKey: `test-key-${++n}-${Date.now()}`, ...extra }, "user-1");
  const bal = async (name: string) => (await B.ledgerSums(book.id)).get(acc[name]!) ?? 0n;
  const ok = async (p: ReturnType<typeof rec>) => {
    const r = await p;
    expect(r.error?.message ?? null).toBeNull();
    expect(r.doc.status).toBe("posted");
    return r.doc;
  };

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books/books.server");
    RS = await import("./record.server");
    T = await import("../books/taxes.server");
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: "2026-07-01", moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 100_000_000n }, { subtype: "cash", name: "Cash", opening: 0n }], settings: { startDate: "2026-07-01", storeIds: ["store-a", "store-b"], codBasis: "delivery" } }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
    for (const [name, kind, bp, account] of [["GST input 18%", "purchase", 1800, "Tax you can claim back"], ["GST 18%", "sales", 1800, "Sales tax to pay"], ["WHT services 10%", "withholding", 1000, "Withholding tax to pay"]] as const) {
      rate[name] = (await T.saveTaxRate(book, { name, kind, rateBp: bp, accountId: acc[account]! }, null)).id;
    }
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("an expense with claimable tax and tax withheld, for one store, with a new supplier", async () => {
    const doc = await ok(rec("expense", { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Packaging"], amount: "10,000", taxRateId: rate["GST input 18%"] }], withheld: { rateId: rate["WHT services 10%"], amount: "" } }, { storeId: "store-a", newContactName: "Box Co" }));
    expect(doc.storeId).toBe("store-a");
    expect(await bal("Packaging")).toBe(1_000_000n);
    expect(await bal("Tax you can claim back")).toBe(180_000n);
    expect(await bal("Withholding tax to pay")).toBe(-100_000n);
    expect(await bal("Meezan")).toBe(100_000_000n - 1_080_000n);
    expect((await prisma.bkContact.findUnique({ where: { id: doc.contactId! } }))?.kinds).toEqual(["supplier"]);
  });

  it("a store that isn't the book's is refused, naming the field", async () => {
    await expect(rec("owner_in", { to: acc["Cash"], amount: "5" }, { storeId: "someone-else" })).rejects.toMatchObject({ field: "storeId" });
  });

  it("money in, transfers and the owner's money", async () => {
    await ok(rec("money_in", { receivedIn: acc["Cash"], lines: [{ accountId: acc["Other income"], amount: "2000" }] }));
    await ok(rec("transfer", { from: acc["Meezan"], to: acc["Cash"], amount: "5000" }));
    await ok(rec("owner_in", { to: acc["Meezan"], amount: "50000" }));
    await ok(rec("owner_out", { from: acc["Cash"], amount: "1000" }));
    expect(await bal("Cash")).toBe(200_000n + 500_000n - 100_000n);
    expect(await bal("Other income")).toBe(-200_000n);
  });

  it("a bill, part paid with tax withheld, and a supplier credit", async () => {
    const bill = await ok(rec("bill", { payable: acc["Owed to suppliers"], reference: "INV-77", lines: [{ accountId: acc["Stock"], amount: "20000" }] }, { newContactName: "Fabric House" }));
    await ok(rec("bill_payment", { payable: acc["Owed to suppliers"], paidFrom: acc["Meezan"], allocations: [{ billId: bill.id, amount: "12000" }], withheld: { rateId: rate["WHT services 10%"], amount: "1200" } }, { contactId: bill.contactId }));
    await ok(rec("supplier_credit", { payable: acc["Owed to suppliers"], reference: "CN-1", lines: [{ accountId: acc["Stock"], amount: "1000" }] }, { contactId: bill.contactId }));
    expect(await bal("Owed to suppliers")).toBe(-2_000_000n + 1_200_000n + 100_000n);
    // The same supplier's bill number twice is refused.
    const dup = await rec("bill", { payable: acc["Owed to suppliers"], reference: "INV-77", lines: [{ accountId: acc["Stock"], amount: "1" }] }, { contactId: bill.contactId });
    expect(dup.error?.field).toBe("reference");
  });

  it("a courier payout by hand, and a courier's invoice", async () => {
    await ok(rec("courier_payout", { receivable: acc["Owed by couriers"], receivedIn: acc["Meezan"], received: "9500", deductions: [{ accountId: acc["Delivery charges"], amount: "500" }] }, { storeId: "store-b", newContactName: "TCS" }));
    await ok(rec("courier_payout", { receivable: acc["Owed by couriers"], receivedIn: acc["Meezan"], received: "-300", deductions: [{ accountId: acc["Return charges"], amount: "300" }] }, { storeId: "store-b", newContactName: "TCS" }));
    expect(await bal("Owed by couriers")).toBe(-1_000_000n);
    expect(await bal("Return charges")).toBe(30_000n);
  });

  it("parcels written off: lost with its tax, and paid short to Courier shortfalls", async () => {
    await ok(rec("parcel_writeoff", { reason: "lost", receivable: acc["Owed by couriers"], account: acc["Returns"], parcels: [{ orderName: "#1001", amount: "1180" }], taxAmount: "180" }));
    expect(await bal("Returns")).toBe(100_000n);
    expect(await bal("Sales tax to pay")).toBe(18_000n);
    await ok(rec("parcel_writeoff", { reason: "short_paid", receivable: acc["Owed by couriers"], account: "", parcels: [{ orderName: "#1002", amount: "50" }] }));
    const shortfalls = (await B.listAccounts(book)).find((a) => a.name === "Courier shortfalls")!;
    expect((await B.ledgerSums(book.id)).get(shortfalls.id)).toBe(5_000n);
  });

  it("tax paid: owed less what you can claim back", async () => {
    await ok(rec("tax_payment", { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Withholding tax to pay"], amount: "2200" }, { accountId: acc["Tax you can claim back"], amount: "1800" }] }));
    expect(await bal("Withholding tax to pay")).toBe(0n);
    expect(await bal("Tax you can claim back")).toBe(0n);
  });

  it("a journal entry that doesn't balance is kept as a draft with the reason; one that does is saved", async () => {
    const bad = await rec("manual", { lines: [{ accountId: acc["Rent"], debit: "100" }, { accountId: acc["Meezan"], credit: "90" }] });
    expect(bad.error?.message).toMatch(/Debits and credits must be equal/);
    expect(bad.doc.status).toBe("draft");
    await ok(rec("manual", { lines: [{ accountId: acc["Rent"], debit: "100" }, { accountId: acc["Meezan"], credit: "100" }] }));
  });

  it("the same form sent twice records once", async () => {
    const input: RecordInput = { type: "owner_in", date: D, data: { to: acc["Cash"], amount: "77" }, clientKey: "same-form-0001" };
    const a = await RS.saveRecord(book, input, "user-1");
    const b = await RS.saveRecord(book, input, "user-1");
    expect(b.doc.id).toBe(a.doc.id);
  });

  it("drafts wait, are approved oldest first, and a saved entry is only ever cancelled", async () => {
    const d1 = await rec("expense", { paidFrom: acc["Cash"], lines: [{ accountId: acc["Rent"], amount: "10" }] }, { asDraft: true });
    expect(d1.doc.status).toBe("draft");
    const results = await B.approveDocuments(book, [{ id: d1.doc.id, updatedAt: d1.doc.updatedAt.toISOString() }], "user-1");
    expect(results).toEqual([expect.objectContaining({ ok: true })]);
    await B.cancelDocument(book, d1.doc.id, "typed twice", "user-1");
    const lines = await prisma.bkEntryLine.findMany({ where: { entry: { documentId: d1.doc.id } } });
    expect(lines.reduce((s, l) => s + l.amount, 0n)).toBe(0n);
    expect(lines).toHaveLength(4);
  });

  it("the whole book still adds up", async () => {
    expect([...(await B.ledgerSums(book.id)).values()].reduce((s, v) => s + v, 0n)).toBe(0n);
    const opts = await RS.recordOptions(book, "2026-10-22");
    expect(opts.stores).toEqual([]); // the book names stores this schema doesn't hold
    expect(opts.rates.length).toBe(3);
  });
});
