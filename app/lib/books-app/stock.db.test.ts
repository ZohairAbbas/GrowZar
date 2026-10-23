/**
 * The stock check against Postgres (Books v1.1 V4, D-97): Inventorify's
 * stock at cost against the books, with sales not brought in yet, as a draft
 * adjustment. Synthetic data only, in a private schema with all of Growzar's
 * migrations (test-db.ts). Runs only with BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;
const $ = (amount: number) => ({ amount: amount.toFixed(2), currency: "PKR" });

run("The stock check", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../books/books.server");
  let K: typeof import("./stock.server");
  let book: Awaited<ReturnType<typeof import("../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const t = Date.now();
  const org = `stock-org-${t}`;
  const store = `stock-store-${t}`;
  const day: Record<string, string> = {};

  const raw = (entity: "INVENTORY_VARIANT" | "STOCK_LEVEL", id: string, payload: object) =>
    prisma.rawRecord.create({ data: { storeId: store, app: "INVENTORIFY", entity, externalId: id, sourceUpdatedAt: new Date(), payload: payload as never } });

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books/books.server");
    K = await import("./stock.server");
    const R = await import("./connectors/runs.server");
    const S = await import("./connectors/sales.server");
    const D = await import("../books/dates");
    const P = await import("../books/posting");
    const today = D.todayIn("Asia/Karachi");
    for (const [k, n] of [["start", -6], ["y", -1], ["today", 0]] as const) day[k] = P.addDays(today, n);
    await prisma.organization.create({ data: { id: org, name: "Stock Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, displayName: "Store One", currency: "PKR", timezone: "Asia/Karachi" } });
    for (const app of ["INVENTORIFY", "FINANCIFY"] as const) await prisma.appConnection.create({ data: { storeId: store, app, status: "CONNECTED" } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: day.start!, moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: day.start!, storeIds: [store], codBasis: "delivery" } }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
    // Opening stock of PKR 1,000 (100,000 minor).
    const o = await B.saveAndPost(book, { type: "manual", date: day.start!, storeId: store, data: { lines: [{ accountId: acc["Stock"]!, debit: "100000" }, { accountId: acc["Owner's capital"]!, credit: "100000" }] } }, "owner");
    expect(o.error).toBeUndefined();
    // Inventorify: v1 200 available at 400 (80,000), v2 5 with no cost, v3 oversold.
    await raw("INVENTORY_VARIANT", "v1", { variantId: "v1", title: "Charger", sku: "CH-1", unitCost: { amount: "4.00", currency: "PKR" } });
    await raw("INVENTORY_VARIANT", "v2", { variantId: "v2", title: "Cable", sku: null, unitCost: null });
    await raw("INVENTORY_VARIANT", "v3", { variantId: "v3", title: "Case", unitCost: { amount: "1.00", currency: "PKR" } });
    await raw("STOCK_LEVEL", "v1:l1", { variantId: "v1", available: 200, locationActive: true });
    await raw("STOCK_LEVEL", "v2:l1", { variantId: "v2", available: 5, locationActive: true });
    await raw("STOCK_LEVEL", "v3:l1", { variantId: "v3", available: -2, locationActive: true });
    // Sales with cost tracking, brought in up to yesterday; one prepaid order today isn't in the books yet.
    const mapping = await S.checkSalesMapping(book, await S.salesDefaults(book));
    await R.saveConnector(book, "shopify_sales", { enabled: true, mode: "auto", startDate: day.start!, settings: { mapping } as never }, "owner");
    await R.runConnector(book, "shopify_sales", "manual", S.runSales);
    await prisma.rawRecord.create({
      data: {
        storeId: store, app: "FINANCIFY", entity: "ORDER", externalId: "T1", sourceUpdatedAt: new Date(),
        payload: {
          orderId: "T1", orderName: "#T1", createdAt: `${day.today}T09:00:00+05:00`, cancelledAt: null, test: false, currency: { code: "PKR" },
          money: { placed: $(10), discounts: $(0), shipping: $(0), tax: $(0) }, payment: { gateways: ["card"] }, transactions: [{ kind: "sale", gateway: "card", amount: $(10) }],
          unpaidGateway: null, everShipped: true, refunds: [], orderFacts: { available: true }, localDay: day.today,
          lineItems: [{ lineId: "T1-1", variantId: "v1", quantity: 1, unitPrice: $(10), totalDiscount: $(0), unitCost: $(4), isGiftCard: false }],
        } as never,
      },
    });
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("where the difference goes: cost of what you sold by default; the opening balance for a first count with no opening stock", async () => {
    // The opening stock above was a manual entry, not an opening balance: as far as the check knows, this is a first count.
    const c = await K.stockCounters(book);
    expect(c.firstCount).toBe(true);
    expect(c.defaultId).toBe(acc["Opening balance adjustment"]);
    expect(c.choices.map((x) => x.label)).toEqual(["Cost of what you sold", "Stock lost or damaged", "Opening balance (first count)"]);
  });

  it("Inventorify's available stock at cost against the books, less what's sold but not in the books yet", async () => {
    const s = await K.checkStock(book, store);
    expect(s).toMatchObject({ counted: "80000", booksValue: "100000", pending: "-400", itemsNoCost: 1, unitsNoCost: 5, oversoldUnits: -2, notTied: "0" });
    // 800 counted − (1,000 in the books − 4 sold today) = −196.
    expect(K.proposedChange(s)).toBe(-19_600n);
  });

  it("the adjustment is a draft, one at a time, and only from a fresh check with nothing saved since (D-97)", async () => {
    const r = await K.prepareStockAdjustment(book, { storeId: store, method: "inventorify", counter: acc["Cost of what you sold"] }, day.today!, "owner");
    expect(r.waiting).toBe(false);
    const doc = await prisma.bkDocument.findUniqueOrThrow({ where: { id: r.id } });
    expect(doc).toMatchObject({ type: "stock_adjustment", status: "draft", storeId: store });
    expect(doc.data).toMatchObject({ amount: "-19600", method: "inventorify", countedValue: "80000", booksValue: "100000", pendingValue: "-400", counter: acc["Cost of what you sold"] });
    expect(await K.prepareStockAdjustment(book, { storeId: store, method: "inventorify" }, day.today!, "owner")).toEqual({ id: r.id, waiting: true });
    await B.discardDraft(book, r.id, "owner");
    // Stock moved since the check: check again first.
    await B.saveAndPost(book, { type: "manual", date: day.y!, storeId: store, data: { lines: [{ accountId: acc["Stock"]!, debit: "500" }, { accountId: acc["Owner's capital"]!, credit: "500" }] } }, "owner");
    await expect(K.prepareStockAdjustment(book, { storeId: store, method: "inventorify" }, day.today!, "owner")).rejects.toThrow(/changed since the check/);
  });

  it("a count: only for a day whose sales are all in the books; the books on that day against it", async () => {
    await expect(K.prepareStockAdjustment(book, { storeId: store, method: "count", counted: "90000", date: "2999-01-01" }, day.today!, "owner")).rejects.toThrow(/future/);
    await expect(K.prepareStockAdjustment(book, { storeId: store, method: "count", counted: "90000", date: day.today! }, day.today!, "owner")).rejects.toThrow(/aren't all in your books yet/);
    const r = await K.prepareStockAdjustment(book, { storeId: store, method: "count", counted: "90000", date: day.y! }, day.today!, "owner");
    expect((await prisma.bkDocument.findUniqueOrThrow({ where: { id: r.id } })).data).toMatchObject({ amount: "-10500", method: "count", booksValue: "100500" });
  });
});
