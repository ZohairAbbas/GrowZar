/**
 * The Inventorify connector against Postgres (B3, D-88), with Inventorify's
 * feeds stubbed. Runs only with BOOKS_TEST_DATABASE_URL, in a private schema
 * with all of Growzar's migrations (test-db.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../../books/__tests__/test-db";
import type { InvLedgerEntry, InvReceipt } from "../../books/connectors/inventorify";

const run = TEST_DATABASE_URL ? describe : describe.skip;
const $ = (amount: string) => ({ amount, currency: "PKR" });

run("Inventorify connector against Postgres", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../../books/books.server");
  let R: typeof import("./runs.server");
  let I: typeof import("./inventorify.server");
  let book: Awaited<ReturnType<typeof import("../../books/books.server").setupBook>>;
  const org = `inv-org-${Date.now()}`;
  const store = `inv-store-${Date.now()}`;
  const start = "2026-10-01";
  let receipts: InvReceipt[] = [];
  let ledger: InvLedgerEntry[] = [];
  const asked: string[] = [];

  const fetchFeed = async <T,>(_shop: string, feed: "receipts" | "supplier-ledger", q: URLSearchParams) => {
    asked.push(`${feed}?${q.toString()}`);
    const since = q.get("updatedSince");
    const rows = (feed === "receipts" ? receipts : ledger).filter((x) => !since || x.createdAt >= since);
    return { data: rows as unknown as T[], pagination: { hasMore: false, nextCursor: null } };
  };
  const runIt = () => R.runConnector(book, "inventorify", "manual", (b, c) => I.runInventorify(b, c, fetchFeed));
  const docs = () => prisma.bkDocument.findMany({ where: { bookId: book.id, source: "inventorify" }, orderBy: { sourceRef: "asc" } });
  const bal = async (name: string) => {
    const a = (await B.listAccounts(book)).find((x) => x.name === name)!;
    return (await B.ledgerSums(book.id)).get(a.id) ?? 0n;
  };

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../../books/books.server");
    R = await import("./runs.server");
    I = await import("./inventorify.server");
    await prisma.organization.create({ data: { id: org, name: "Inv Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, currency: "PKR", timezone: "Asia/Karachi" } });
    await prisma.appConnection.create({ data: { storeId: store, app: "INVENTORIFY", status: "CONNECTED", capabilities: ["receipts:read", "supplier-ledger:read"] } });
    await prisma.rawRecord.create({ data: { storeId: store, app: "INVENTORIFY", entity: "SUPPLIER", externalId: "sup-1", sourceUpdatedAt: new Date(), payload: { id: "sup-1", name: "Karachi Fabrics" } } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: start, moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: start, storeIds: [store], codBasis: "delivery" } }, "owner");
    const input = await I.parseInventorifyForm(book, { startDate: null, settings: {} }, { enabled: true, mode: "draft", startDate: start }, "2026-10-22");
    await R.saveConnector(book, "inventorify", { ...input, settings: input.settings as never }, "owner");
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("a delivery becomes a draft bill from its supplier: good units to Stock, damaged ones awaiting the claim", async () => {
    receipts = [
      { id: "rcpt-000001", poId: "po-1", poNumber: "PO-7", supplierId: "sup-1", locationId: null, receivedOn: "2026-10-05", lines: [{ variantId: "v1", inventoryItemId: "i1", quantity: 10, quantityDamaged: 2, unitCost: $("150.00") }], billLedgerEntryId: "led-1", currency: "PKR", createdAt: "2026-10-05T08:00:00.000Z" },
    ];
    ledger = [{ id: "led-1", supplierId: "sup-1", kind: "bill", amount: $("1500.00"), currency: "PKR", date: "2026-10-05", sourceKey: "receipt:rcpt-000001", reference: null, poId: "po-1", receiptId: "rcpt-000001", claimId: null, reversalOf: null, createdAt: "2026-10-05T08:00:01.000Z" }];
    expect(await runIt()).toMatchObject({ status: "ok", created: 1 });
    const [bill] = await docs();
    expect(bill).toMatchObject({ type: "bill", status: "draft", storeId: store, sourceRef: `${store}:receipt:rcpt-000001` });
    expect((await prisma.bkContact.findUnique({ where: { id: bill!.contactId! } }))?.name).toBe("Karachi Fabrics");
    await B.postDocument(book, bill!.id, "owner");
    expect(await bal("Stock")).toBe(120_000n);
    expect(await bal("Damaged stock awaiting supplier claims")).toBe(30_000n);
    expect(await bal("Owed to suppliers")).toBe(-150_000n);
  });

  it("reads on from where it stopped; a row read twice adds nothing", async () => {
    expect(await runIt()).toMatchObject({ created: 0, updated: 0 });
    expect(asked.at(-1)).toMatch(/updatedSince=2026-10-05T08%3A00%3A01/);
  });

  it("typed bills post; payments are kept to match, not posted; a reversal cancels what it undoes", async () => {
    ledger.push(
      { id: "led-2", supplierId: "sup-1", kind: "bill", amount: $("500.00"), currency: "PKR", date: "2026-10-07", sourceKey: null, reference: "Freight", poId: null, receiptId: null, claimId: null, reversalOf: null, createdAt: "2026-10-07T09:00:00.000Z" },
      { id: "led-3", supplierId: "sup-1", kind: "payment", amount: $("-1000.00"), currency: "PKR", date: "2026-10-08", sourceKey: null, reference: "IBFT 123", poId: null, receiptId: null, claimId: null, reversalOf: null, createdAt: "2026-10-08T09:00:00.000Z" },
    );
    expect(await runIt()).toMatchObject({ created: 1 });
    const freight = (await docs()).find((d) => d.sourceRef === `${store}:ledger:led-2`)!;
    await B.postDocument(book, freight.id, "owner");
    expect(await bal("Purchase differences and charges")).toBe(50_000n);
    const c = await R.getConnector(book, "inventorify");
    expect((c.settings as { payments?: Array<{ id: string; supplierName: string }> }).payments).toEqual([expect.objectContaining({ id: "led-3", supplierName: "Karachi Fabrics", amount: "100000" })]);
    expect(await bal("Meezan")).toBe(0n);

    ledger.push({ id: "led-4", supplierId: "sup-1", kind: "reversal", amount: $("-500.00"), currency: "PKR", date: "2026-10-09", sourceKey: null, reference: null, poId: null, receiptId: null, claimId: null, reversalOf: "led-2", createdAt: "2026-10-09T09:00:00.000Z" });
    await runIt();
    expect((await docs()).find((d) => d.sourceRef === `${store}:ledger:led-2`)?.status).toBe("cancelled");
    expect(await bal("Purchase differences and charges")).toBe(0n);
  });
});
