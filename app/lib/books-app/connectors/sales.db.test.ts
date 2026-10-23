/**
 * The sales connector against Postgres (B3): Financify orders, Growzar's
 * order grain and Courierify parcels seeded synthetically, in a private schema
 * with all of Growzar's migrations (test-db.ts). Runs only with
 * BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../../books/__tests__/test-db";
import type { FeedOrder } from "./sales";

const run = TEST_DATABASE_URL ? describe : describe.skip;
const $ = (amount: number) => ({ amount: String(amount), currency: "PKR" });
const COD = "Cash on Delivery (COD)";

run("Sales connector against Postgres", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../../books/books.server");
  let R: typeof import("./runs.server");
  let S: typeof import("./sales.server");
  let book: Awaited<ReturnType<typeof import("../../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const org = `sales-org-${Date.now()}`;
  const store = `sales-store-${Date.now()}`;
  const day: Record<string, string> = {};
  const at = (d: string, hh = "10") => `${d}T${hh}:00:00+05:00`;

  const order = (id: string, d: string, patch: Partial<FeedOrder> & { cod?: boolean } = {}): FeedOrder => {
    const cod = patch.cod ?? true;
    const sub = Number(id === "B" ? 2000 : 1000);
    const tax = sub * 0.18;
    return {
      orderId: id,
      orderName: `#${id}`,
      createdAt: at(d),
      cancelledAt: null,
      test: false,
      currency: { code: "PKR" },
      money: { placed: $(sub + tax), discounts: $(0), shipping: $(0), tax: $(tax) },
      payment: { gateways: [cod ? COD : "card"] },
      transactions: cod ? [] : [{ kind: "sale", gateway: "card", amount: $(sub + tax) }],
      unpaidGateway: cod ? COD : null,
      everShipped: true,
      lineItems: [{ lineId: `${id}-1`, variantId: "v1", quantity: 1, unitPrice: $(sub), totalDiscount: $(0), unitCost: $(400), isGiftCard: false }],
      refunds: [],
      orderFacts: { available: true },
      ...patch,
    } as FeedOrder;
  };
  const putOrder = (o: FeedOrder) =>
    prisma.rawRecord.upsert({
      where: { storeId_app_entity_externalId: { storeId: store, app: "FINANCIFY", entity: "ORDER", externalId: o.orderId } },
      create: { storeId: store, app: "FINANCIFY", entity: "ORDER", externalId: o.orderId, sourceUpdatedAt: new Date(), payload: { ...o, localDay: o.createdAt.slice(0, 10) } as never },
      update: { payload: { ...o, localDay: o.createdAt.slice(0, 10) } as never, sourceUpdatedAt: new Date() },
    });
  const grain = (orderId: string, outcome: string, when: string | null) =>
    prisma.orderGrain.upsert({
      where: { storeId_orderId: { storeId: store, orderId } },
      create: { storeId: store, orderId, localDay: day.d1, outcome, outcomeAuthority: "courierify", outcomeAt: when ? new Date(when) : null, orderCancelled: outcome === "order_cancelled", shipmentCancelled: false, parcelCount: 1, lines: [], explain: {} },
      update: { outcome, outcomeAt: when ? new Date(when) : null },
    });
  const runIt = () => R.runConnector(book, "shopify_sales", "manual", S.runSales);
  const bal = async (name: string) => (await B.ledgerSums(book.id)).get(acc[name]!) ?? 0n;
  const docs = () => prisma.bkDocument.findMany({ where: { bookId: book.id, source: "shopify_sales" }, orderBy: { sourceRef: "asc" } });

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../../books/books.server");
    R = await import("./runs.server");
    S = await import("./sales.server");
    const D = await import("../../books/dates");
    const P = await import("../../books/posting");
    const today = D.todayIn("Asia/Karachi");
    for (const [k, n] of [["start", -6], ["d1", -5], ["d2", -4], ["d4", -2], ["y", -1]] as const) day[k] = P.addDays(today, n);
    await prisma.organization.create({ data: { id: org, name: "Sales Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, displayName: "Store One", currency: "PKR", timezone: "Asia/Karachi" } });
    await prisma.appConnection.create({ data: { storeId: store, app: "FINANCIFY", status: "CONNECTED" } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: day.start!, moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: day.start!, storeIds: [store], codBasis: "delivery" } }, "owner");

    // A: COD, delivered yesterday. B: paid by card. C: COD, came back. D: COD, cancelled before it shipped.
    await putOrder(order("A", day.d1!));
    // B carries a free gift with no cost on record: one note for the run, not one per day.
    await putOrder(order("B", day.d1!, { cod: false, lineItems: [{ lineId: "B-1", variantId: "v1", quantity: 1, unitPrice: $(2000), totalDiscount: $(0), unitCost: $(400), isGiftCard: false }, { lineId: "B-2", variantId: "gift", quantity: 1, unitPrice: $(0), totalDiscount: $(0), unitCost: null, isGiftCard: false }] } as Partial<FeedOrder>));
    await putOrder(order("C", day.d2!));
    await putOrder(order("D", day.d2!, { cancelledAt: at(day.d2!, "15"), everShipped: false }));
    await grain("A", "delivered", at(day.y!));
    await grain("B", "delivered", at(day.d2!));
    await grain("C", "returned", at(day.d4!));
    await grain("D", "order_cancelled", null);

    const mapping = await S.checkSalesMapping(book, await S.salesDefaults(book));
    await R.saveConnector(book, "shopify_sales", { enabled: true, mode: "auto", startDate: day.start!, settings: { mapping } as never }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("COD sales count when delivered; returns and a cancel before shipping come back off; every day carries the store", async () => {
    const r = await runIt();
    const all = await docs();
    expect(r?.status).toBe("ok");
    expect(r?.notes.filter((n) => /with no cost/.test(n))).toEqual([expect.stringMatching(/^Store One: 1 item with no cost in Shopify on 1 day \(.+\), left out of cost of sales/)]);
    expect(all.every((d) => d.status === "posted" && d.storeId === store && d.type === "sales_summary")).toBe(true);
    expect(all.map((d) => d.sourceRef)).toEqual(expect.arrayContaining([`${store}:${day.d1}`, `${store}:${day.d2}`, `${store}:${day.y}`]));
    expect(all.find((d) => d.sourceRef === `${store}:${day.y}`)?.memo).toMatch(/1 delivered/);
    // Sales that count: A (delivered) and B (prepaid); C came back, D was cancelled.
    const net = (await bal("Sales")) + (await bal("Returns")) + (await bal("COD sales held back")) + (await bal("Discounts given"));
    expect(net).toBe(-300_000n);
    expect(await bal("COD sales held back")).toBe(0n);
    expect(await bal("Owed by couriers")).toBe(118_000n);
    expect(await bal("Owed by payment gateways")).toBe(236_000n);
    expect(await bal("Sales tax to pay")).toBe(-54_000n);
    // Cost stays only for what was sold and kept: A and B.
    expect(await bal("Cost of what you sold")).toBe(80_000n);
    expect(await bal("Stock")).toBe(-80_000n);
    expect([...(await B.ledgerSums(book.id)).values()].reduce((s, v) => s + v, 0n)).toBe(0n);
  });

  it("a re-run over the same data posts nothing new", async () => {
    const lines = await prisma.bkEntryLine.count({ where: { bookId: book.id } });
    expect(await runIt()).toMatchObject({ created: 0, updated: 0 });
    expect(await prisma.bkEntryLine.count({ where: { bookId: book.id } })).toBe(lines);
  });

  it("a refund that reaches Growzar after its day was saved posts as a correction on that day, once (rule 3)", async () => {
    const returnsBefore = await bal("Returns");
    await putOrder(order("B", day.d1!, { cod: false, refunds: [{ createdAt: at(day.y!, "15"), total: $(590), tax: $(90), gateways: [{ gateway: "card", amount: $(590) }], lines: [] }] }));
    expect(await runIt()).toMatchObject({ created: 1 });
    const c1 = (await docs()).find((d) => d.sourceRef === `${store}:${day.y}:c1`)!;
    expect(c1).toMatchObject({ type: "manual", status: "posted", storeId: store });
    expect(c1.date.toISOString().slice(0, 10)).toBe(day.y);
    expect(await bal("Returns")).toBe(returnsBefore + 50_000n);
    expect(await bal("Owed by payment gateways")).toBe(236_000n - 59_000n);
    expect(await bal("Sales tax to pay")).toBe(-54_000n + 9_000n);
    expect(await runIt()).toMatchObject({ created: 0, updated: 0 });
  });

  it("an order still waiting for Financify's details holds its day back", async () => {
    await prisma.bkConnector.updateMany({ where: { bookId: book.id }, data: { settings: { ...(await R.getConnector(book, "shopify_sales")).settings, progress: {} } as never } });
    // Starting over from the first day: an order on it without facts stops the run before that day.
    await putOrder(order("E", day.d1!, { orderFacts: { available: false } }));
    const r = await runIt();
    expect(r?.status).toBe("partial");
    expect(r?.notes.join(" ")).toMatch(/still waits? for Financify's details/);
  });
});
