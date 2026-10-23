/**
 * Recurring entries and attachments against Postgres (Books v1.1 V6), ported
 * from Financify's books.db.test.ts "recurring entries", with Growzar's store
 * on each entry made, and attachments. Runs only with BOOKS_TEST_DATABASE_URL,
 * in a private schema (test-db.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "./test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Recurring entries and attachments", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../books.server");
  let R: typeof import("../recurring.server");
  let A: typeof import("../attachments.server");
  let book: Awaited<ReturnType<typeof import("../books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const org = `recurring-${Date.now()}`;
  const store = "store-a";
  const fromDb = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const expense = (amount: string, account: string, date: string) =>
    B.saveAndPost(book, { type: "expense", date, storeId: store, data: { paidFrom: acc["Meezan"]!, lines: [{ accountId: acc[account]!, amount }] } }, "owner");
  const sched = (patch: Record<string, unknown> = {}) => ({ name: "Office rent", frequency: "monthly", interval: 1, dayOfMonth: 1, startDate: "2027-01-01", endDate: null, mode: "draft", ...patch }) as import("../recurring.server").ScheduleInput;
  const made = (id: string) => prisma.bkDocument.findMany({ where: { bookId: book.id, source: "recurring", sourceRef: { startsWith: `${id}:` } }, orderBy: { date: "asc" } });

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books.server");
    R = await import("../recurring.server");
    A = await import("../attachments.server");
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: "2026-10-01", moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }] }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("makes each due date once, even when two runs race; drafts by default, with the entry's store", async () => {
    const rent = await expense("5000000", "Rent", "2026-12-01");
    await expect(R.createRecurringFromDocument(book, rent.doc.id, sched({ name: " " }), null)).rejects.toThrow(/Give it a name/);
    await expect(R.createRecurringFromDocument(book, rent.doc.id, sched({ endDate: "2026-12-31" }), null)).rejects.toThrow(/end date must be after/);
    const r = await R.createRecurringFromDocument(book, rent.doc.id, sched(), "owner");
    expect(fromDb(r.nextDate)).toBe("2027-01-01");
    expect(r.storeId).toBe(store);
    await Promise.all([R.runRecurring(book, "2027-03-15"), R.runRecurring(book, "2027-03-15")]);
    const docs = await made(r.id);
    expect(docs.map((d) => [fromDb(d.date), d.status, d.storeId])).toEqual([
      ["2027-01-01", "draft", store],
      ["2027-02-01", "draft", store],
      ["2027-03-01", "draft", store],
    ]);
    expect(fromDb((await prisma.bkRecurring.findUniqueOrThrow({ where: { id: r.id } })).nextDate)).toBe("2027-04-01");
    expect(await R.runRecurring(book, "2027-03-20")).toBe(0);
  });

  it("saves automatically; a closed month leaves a draft and says why", async () => {
    const sub = await expense("1000", "Software and apps", "2026-12-05");
    const r = await R.createRecurringFromDocument(book, sub.doc.id, sched({ name: "Apps", dayOfMonth: 5, startDate: "2027-01-05", mode: "auto" }), null);
    await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: new Date("2027-01-31") } });
    try {
      await R.runRecurring(book, "2027-02-10");
    } finally {
      await prisma.bkBook.update({ where: { id: book.id }, data: { lockedThrough: null } });
    }
    expect((await made(r.id)).map((d) => [fromDb(d.date), d.status])).toEqual([
      ["2027-01-05", "draft"],
      ["2027-02-05", "posted"],
    ]);
    expect((await prisma.bkRecurring.findUniqueOrThrow({ where: { id: r.id } })).lastMessage).toMatch(/2027-01-05: kept as a draft — The books are closed/);
  });

  it("pausing skips missed dates; changing and stopping; a switched-off organization makes nothing", async () => {
    const rent = await expense("2000", "Rent", "2026-12-10");
    const r = await R.createRecurringFromDocument(book, rent.doc.id, sched({ name: "Store rent", dayOfMonth: 10, startDate: "2027-01-10" }), null);
    await R.runRecurring(book, "2027-01-10");
    await R.setRecurringPaused(book, r.id, true, "2027-01-11", null);
    await R.runRecurring(book, "2027-04-20");
    expect((await made(r.id)).length).toBe(1);
    await R.setRecurringPaused(book, r.id, false, "2027-04-20", null);
    expect(fromDb((await prisma.bkRecurring.findUniqueOrThrow({ where: { id: r.id } })).nextDate)).toBe("2027-05-10");
    await R.updateRecurring(book, r.id, sched({ name: "Store rent (quarterly)", interval: 3, dayOfMonth: 10, startDate: "2027-01-10" }), "2027-04-20", null);
    expect(fromDb((await prisma.bkRecurring.findUniqueOrThrow({ where: { id: r.id } })).nextDate)).toBe("2027-07-10");
    expect((await R.listRecurring(book)).find((x) => x.id === r.id)).toMatchObject({ name: "Store rent (quarterly)", schedule: "Every 3 months on the 10th", total: 2000n, problem: null });
    // The worker's pass skips an organization whose Books is off.
    expect(await R.runAllRecurring(new Date("2027-08-01T12:00:00Z"), async () => false)).toBe(0);
    await R.deleteRecurring(book, r.id, null);
    expect(await prisma.bkRecurring.count({ where: { id: r.id } })).toBe(0);
    expect((await made(r.id)).length).toBe(1);
  });

  it("attachments: a photo or PDF by its bytes, listed, removed; gone with a thrown-away draft", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const doc = (await expense("300", "Rent", "2026-12-15")).doc;
    await expect(A.addAttachment(book, doc.id, { name: "notes.txt", bytes: new TextEncoder().encode("hello") }, null)).rejects.toThrow(/photo .* or a PDF/);
    await expect(A.addAttachment(book, doc.id, { name: "big.png", bytes: new Uint8Array(A.MAX_ATTACHMENT_BYTES + 1).fill(1) }, null)).rejects.toThrow(/too large/);
    const a = await A.addAttachment(book, doc.id, { name: "receipt <1>.png", bytes: png }, "owner");
    expect(a).toMatchObject({ fileName: "receipt 1.png", contentType: "image/png", size: 11 });
    expect((await A.listAttachments(book, doc.id)).map((x) => x.id)).toEqual([a.id]);
    expect(Buffer.from((await A.getAttachment(book, a.id))!.data)).toEqual(Buffer.from(png));
    await A.deleteAttachment(book, a.id, "owner");
    expect(await A.listAttachments(book, doc.id)).toEqual([]);
    const draft = await B.saveDraft(book, { type: "expense", date: "2026-12-16", data: { paidFrom: acc["Meezan"]!, lines: [{ accountId: acc["Rent"]!, amount: "100" }] } }, "owner");
    await A.addAttachment(book, draft.id, { name: "r.pdf", bytes: new TextEncoder().encode("%PDF-1.4 x") }, "owner");
    await B.discardDraft(book, draft.id, "owner");
    expect(await prisma.bkAttachment.count({ where: { documentId: draft.id } })).toBe(0);
  });
});
