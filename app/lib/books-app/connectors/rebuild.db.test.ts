/**
 * Bringing sales in again from a date (Books v1.1 V3, D-100) against
 * Postgres: synthetic orders in a private schema with all of Growzar's
 * migrations (test-db.ts). Runs only with BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../../books/__tests__/test-db";
import type { FeedOrder } from "./sales";

const run = TEST_DATABASE_URL ? describe : describe.skip;
const $ = (amount: number) => ({ amount: amount.toFixed(2), currency: "PKR" });

run("Bringing sales in again", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../../books/books.server");
  let R: typeof import("./runs.server");
  let S: typeof import("./sales.server");
  let X: typeof import("./rebuild.server");
  let book: Awaited<ReturnType<typeof import("../../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const t = Date.now();
  const org = `rebuild-org-${t}`;
  const store = `rebuild-store-${t}`;
  const day: Record<string, string> = {};

  const order = (id: string, d: string, cost: number | null): FeedOrder =>
    ({
      orderId: id,
      orderName: `#${id}`,
      createdAt: `${d}T10:00:00+05:00`,
      cancelledAt: null,
      test: false,
      currency: { code: "PKR" },
      money: { placed: $(1000), discounts: $(0), shipping: $(0), tax: $(0) },
      payment: { gateways: ["card"] },
      transactions: [{ kind: "sale", gateway: "card", amount: $(1000) }],
      unpaidGateway: null,
      everShipped: true,
      lineItems: [{ lineId: `${id}-1`, variantId: "v1", quantity: 1, unitPrice: $(1000), totalDiscount: $(0), unitCost: cost === null ? null : $(cost), isGiftCard: false }],
      refunds: [],
      orderFacts: { available: true },
    }) as unknown as FeedOrder;
  const putOrder = (o: FeedOrder) =>
    prisma.rawRecord.upsert({
      where: { storeId_app_entity_externalId: { storeId: store, app: "FINANCIFY", entity: "ORDER", externalId: o.orderId } },
      create: { storeId: store, app: "FINANCIFY", entity: "ORDER", externalId: o.orderId, sourceUpdatedAt: new Date(), payload: { ...o, localDay: o.createdAt.slice(0, 10) } as never },
      update: { payload: { ...o, localDay: o.createdAt.slice(0, 10) } as never, sourceUpdatedAt: new Date() },
    });
  const runSales = () => R.runConnector(book, "shopify_sales", "manual", S.runSales);
  const bal = async (name: string) => (await B.ledgerSums(book.id)).get(acc[name]!) ?? 0n;

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../../books/books.server");
    R = await import("./runs.server");
    S = await import("./sales.server");
    X = await import("./rebuild.server");
    const D = await import("../../books/dates");
    const P = await import("../../books/posting");
    const today = D.todayIn("Asia/Karachi");
    for (const [k, n] of [["start", -6], ["d1", -5], ["d2", -4], ["y", -1]] as const) day[k] = P.addDays(today, n);
    await prisma.organization.create({ data: { id: org, name: "Rebuild Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, displayName: "Store One", currency: "PKR", timezone: "Asia/Karachi" } });
    await prisma.appConnection.create({ data: { storeId: store, app: "FINANCIFY", status: "CONNECTED" } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: day.start!, moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: day.start!, storeIds: [store], codBasis: "delivery" } }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
    // A has its cost; B's cost is missing in Shopify.
    await putOrder(order("A", day.d1!, 400));
    await putOrder(order("B", day.d2!, null));
    const mapping = await S.checkSalesMapping(book, await S.salesDefaults(book));
    await R.saveConnector(book, "shopify_sales", { enabled: true, mode: "auto", startDate: day.start!, settings: { mapping } as never }, "owner");
    expect((await runSales())?.status).toBe("ok");
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("refuses a day in a closed month, before the start, in the future, or a store not in the books", async () => {
    await expect(X.rebuildPreview(book, { from: "2020-01-01", storeId: null })).rejects.toThrow(/Sales come in from/);
    await expect(X.rebuildPreview(book, { from: "2999-01-01", storeId: null })).rejects.toThrow(/before today/);
    await expect(X.rebuildPreview(book, { from: day.d2!, storeId: "elsewhere" })).rejects.toThrow(/isn't in these books/);
    await B.setClosedThrough(book, day.d1!, day.y!, "owner");
    await expect(X.rebuildPreview((await B.getBook(org))!, { from: day.d1!, storeId: null })).rejects.toThrow(/closed up to/);
    await B.setClosedThrough((await B.getBook(org))!, null, day.y!, "owner", "test over");
    book = (await B.getBook(org))!;
  });

  it("after the cost is fixed: the days from the date come in again with it; earlier days and their later corrections stay", async () => {
    expect(await bal("Cost of what you sold")).toBe(40_000n);
    // A correction for d1, dated d2 (as one is when its month was closed): it must survive bringing in again from d2.
    const late = await B.upsertImported(book, { source: "shopify_sales", sourceRef: `${store}:${day.d1}:c1`, type: "manual", date: day.d2!, data: { lines: [{ accountId: acc["Returns"]!, debit: "100" }, { accountId: acc["Owed by payment gateways"]!, credit: "100" }] }, memo: "late", storeId: store });
    await B.postDocument(book, late.doc.id, null);

    await putOrder(order("B", day.d2!, 450));
    expect(await X.rebuildPreview(book, { from: day.d2!, storeId: null })).toEqual({ days: 1, entries: 1, drafts: 0 });
    expect(await X.rebuildSales(book, { from: day.d2!, storeId: null }, "owner")).toEqual({ cancelled: 1, discarded: 0 });

    const old = await prisma.bkDocument.findMany({ where: { bookId: book.id, source: "shopify_sales", status: "cancelled" } });
    expect(old.map((d) => d.sourceRef!.split("~")[0])).toEqual([`${store}:${day.d2}`]);
    expect((await prisma.bkDocument.findFirstOrThrow({ where: { id: late.doc.id } })).status).toBe("posted");
    const c = await prisma.bkConnector.findFirstOrThrow({ where: { bookId: book.id, key: "shopify_sales" } });
    expect(c.lastRunAt).toBeNull();
    expect((c.settings as { progress: Record<string, string> }).progress[store]).toBe(day.d1);

    expect((await runSales())?.status).toBe("ok");
    const d2 = await prisma.bkDocument.findFirstOrThrow({ where: { bookId: book.id, sourceRef: `${store}:${day.d2}` } });
    expect(d2.status).toBe("posted");
    // A's 400 and B's 450 now; the cancelled day nets to nothing.
    expect(await bal("Cost of what you sold")).toBe(85_000n);
    expect(-(await bal("Sales"))).toBe(200_000n);
    const log = await prisma.bkAuditEvent.findFirstOrThrow({ where: { bookId: book.id, action: "connector.rebuilt" } });
    expect(log.detail).toMatchObject({ key: "shopify_sales", from: day.d2, cancelled: 1 });
  });
});
