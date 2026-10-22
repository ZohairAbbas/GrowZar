/**
 * The parcel register and courier files against Postgres (B5b): Financify
 * orders, Growzar's order grain and Courierify parcels seeded synthetically
 * (no real courier file is ever used), in a private schema with all of
 * Growzar's migrations (test-db.ts). Runs only with BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../../books/__tests__/test-db";
import type { FeedOrder } from "./sales";

const run = TEST_DATABASE_URL ? describe : describe.skip;
const $ = (amount: number) => ({ amount: String(amount), currency: "PKR" });
const COD = "Cash on Delivery (COD)";

run("Parcel register and courier files against Postgres", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../../books/books.server");
  let R: typeof import("./runs.server");
  let S: typeof import("./sales.server");
  let P: typeof import("../../books/connectors/parcels.server");
  let CS: typeof import("../../books/courier-sheets.server");
  let G: typeof import("./parcels.server");
  let book: Awaited<ReturnType<typeof import("../../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const org = `parcel-org-${Date.now()}`;
  const store = `parcel-store-${Date.now()}`;
  const day: Record<string, string> = {};
  let today = "";
  const at = (d: string, hh = "10") => `${d}T${hh}:00:00+05:00`;

  const order = (id: string, d: string): FeedOrder =>
    ({
      orderId: id,
      orderName: `#${id}`,
      createdAt: at(d),
      cancelledAt: null,
      test: false,
      currency: { code: "PKR" },
      money: { placed: $(1180), discounts: $(0), shipping: $(0), tax: $(180) },
      payment: { gateways: [COD] },
      transactions: [],
      unpaidGateway: COD,
      everShipped: true,
      lineItems: [{ lineId: `${id}-1`, variantId: "v1", quantity: 1, unitPrice: $(1000), totalDiscount: $(0), unitCost: $(400), isGiftCard: false }],
      refunds: [],
      orderFacts: { available: true },
    }) as FeedOrder;
  const putOrder = (o: FeedOrder) =>
    prisma.rawRecord.create({ data: { storeId: store, app: "FINANCIFY", entity: "ORDER", externalId: o.orderId, sourceUpdatedAt: new Date(), payload: { ...o, localDay: o.createdAt.slice(0, 10) } as never } });
  const putParcel = (orderId: string, tracking: string) =>
    prisma.rawRecord.create({
      data: {
        storeId: store,
        app: "COURIERIFY",
        entity: "PARCEL",
        externalId: `p-${orderId}`,
        sourceUpdatedAt: new Date(),
        payload: { orderId, courier: "postex", trackingNumber: tracking, bookedFee: $(150), cod: $(1180), bookedAt: at(day.d1!, "12"), settlement: { settled: false, settledAt: null, settlementId: null } } as never,
      },
    });
  const grain = (orderId: string, outcome: string, when: string | null) =>
    prisma.orderGrain.create({ data: { storeId: store, orderId, localDay: day.d1!, outcome, outcomeAuthority: "courierify", outcomeAt: when ? new Date(when) : null, orderCancelled: false, shipmentCancelled: false, parcelCount: 1, lines: [], explain: {} } });
  const runSales = () => R.runConnector(book, "shopify_sales", "manual", S.runSales);
  const bal = async (name: string) => (await B.ledgerSums(book.id)).get(acc[name]!) ?? 0n;
  const parcel = (orderId: string) => prisma.bkParcel.findFirstOrThrow({ where: { bookId: book.id, orderId } });
  const stage = async (orderId: string) => (await P.loadParcels(book, today)).find((p) => p.orderId === orderId)!;

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../../books/books.server");
    R = await import("./runs.server");
    S = await import("./sales.server");
    P = await import("../../books/connectors/parcels.server");
    CS = await import("../../books/courier-sheets.server");
    G = await import("./parcels.server");
    const D = await import("../../books/dates");
    const Po = await import("../../books/posting");
    today = D.todayIn("Asia/Karachi");
    for (const [k, n] of [["start", -6], ["d1", -5], ["d2", -4], ["d4", -2], ["y", -1]] as const) day[k] = Po.addDays(today, n);
    await prisma.organization.create({ data: { id: org, name: "Parcel Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, displayName: "Store One", currency: "PKR", timezone: "Asia/Karachi" } });
    await prisma.appConnection.create({ data: { storeId: store, app: "FINANCIFY", status: "CONNECTED" } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: day.start!, moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: day.start!, storeIds: [store], codBasis: "delivery" } }, "owner");

    // A and B: COD, delivered. C: COD, came back. F: COD, still on the way.
    for (const id of ["A", "B", "C", "F"]) {
      await putOrder(order(id, day.d1!));
      await putParcel(id, `PX-${id}`);
    }
    await grain("A", "delivered", at(day.d2!));
    await grain("B", "delivered", at(day.d2!));
    await grain("C", "returned", at(day.d4!));
    await grain("F", "in_transit", at(day.d1!, "18"));

    const mapping = await S.checkSalesMapping(book, await S.salesDefaults(book));
    await R.saveConnector(book, "shopify_sales", { enabled: true, mode: "auto", startDate: day.start!, settings: { mapping } as never }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("the sales run keeps the register: a row per COD order, with the store, courier and tracking from Courierify", async () => {
    expect((await runSales())?.status).toBe("ok");
    const rows = await prisma.bkParcel.findMany({ where: { bookId: book.id }, orderBy: { orderId: "asc" } });
    expect(rows.map((r) => r.orderId)).toEqual(["A", "B", "C", "F"]);
    expect(rows.every((r) => r.storeId === store && r.courier === "PostEx" && r.trackingNumber === `PX-${r.orderId}` && r.bookedFees === 15_000n)).toBe(true);
    expect((await stage("A")).stage).toBe("delivered");
    expect((await stage("C")).stage).toBe("came_back");
    // F is a COD sale held back until it is delivered: not owed yet.
    expect((await stage("F")).stage).toBe("held");
    // Squares with the books: what couriers owe is A and B, delivered and not paid yet.
    const o = await P.courierOverview(book, today);
    expect(o.ledger).toBe(236_000n);
    expect(o.registerOpen).toBe(236_000n);
    expect(o.difference).toBe(0n);
  });

  it("Courierify saying a parcel is settled shows it as paid by the courier, not in the books yet", async () => {
    await prisma.rawRecord.updateMany({
      where: { storeId: store, externalId: "p-B" },
      data: { payload: { orderId: "B", courier: "postex", trackingNumber: "PX-B", bookedFee: $(150), cod: $(1180), bookedAt: at(day.d1!, "12"), settlement: { settled: true, settledAt: at(day.y!), settlementId: "CPR-9" } } as never },
    });
    await G.refreshRegister(book, store);
    expect((await stage("B")).stage).toBe("paid_not_recorded");
    expect((await P.courierOverview(book, today)).unrecorded).toEqual([expect.objectContaining({ ref: "CPR-9", parcels: 1 })]);
  });

  it("a payout in the books clears the parcels it paid, and marks a returned one", async () => {
    const doc = await prisma.bkDocument.findFirstOrThrow({ where: { bookId: book.id, status: "posted" } });
    await G.stampPayout(book, store, doc.id, day.y!, "CPR-9", [
      { orderId: "B", status: "delivered", collected: 118_000n, net: 103_000n, kept: 15_000n },
      { orderId: "C", status: "Returned", collected: 0n, net: -10_000n, kept: 10_000n },
    ]);
    expect(await parcel("B")).toMatchObject({ payoutDocId: doc.id, paid: 118_000n, settlementRef: "CPR-9", settledStatus: "delivered", settledNet: 103_000n });
    expect(await parcel("C")).toMatchObject({ payoutDocId: null, settledStatus: "returned" });
    // Put back as it was, so the settlement file below can pay B.
    await prisma.bkParcel.updateMany({ where: { bookId: book.id }, data: { payoutDocId: null, paid: 0n, settlementRef: null, settledAt: null, settledNet: null, settledFees: null, settledStatus: null } });
  });

  it("a settlement file pays the parcels it names, once; undoing it cancels the entry and frees them", async () => {
    const text = [
      "PostEx Settlement Report",
      "Tracking Number,Order Ref,Status,COD Amount,Delivery Charges,Return Charges,Net Payable,Payment Date",
      "PX-A,#A,Delivered,1180,150,0,1030,",
      "PX-C,#C,Returned,0,0,100,-100,",
    ].join("\n");
    const preview = await CS.previewSettlement(book, { text, courier: "PostEx", ref: "CPR-1" });
    expect(preview.lines.map((l) => l.orderName)).toEqual(["#A", "#C"]);
    const input = { text, courier: "PostEx", ref: "CPR-1", date: day.y!, receivedIn: acc["Meezan"]!, unmatched: "owed" as const, formKey: "settle-key-0001" };
    const owedBefore = await bal("Owed by couriers");
    const r = await CS.recordSettlement(book, input, "owner");
    expect(r.documents).toHaveLength(1);
    const doc = await prisma.bkDocument.findUniqueOrThrow({ where: { id: r.documents[0]!.id } });
    expect(doc).toMatchObject({ type: "courier_payout", status: "posted", storeId: store });
    expect(await bal("Owed by couriers")).toBe(owedBefore - 118_000n);
    expect(await bal("Meezan")).toBe(93_000n);
    expect(await parcel("A")).toMatchObject({ payoutDocId: doc.id, paid: 118_000n, settlementRef: "CPR-1" });
    expect((await parcel("C")).settledStatus).toBe("returned");
    expect((await stage("A")).stage).toBe("cleared");
    // The same form sent twice records once; the same file again is refused.
    expect(await CS.recordSettlement(book, input, "owner")).toMatchObject({ again: true });
    await expect(CS.recordSettlement(book, { ...input, formKey: "settle-key-0002" }, "owner")).rejects.toThrow(/already/);

    expect(await CS.undoSettlement(book, r.sheetId, "owner")).toEqual({ cancelled: 1 });
    expect((await prisma.bkDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe("cancelled");
    expect(await bal("Owed by couriers")).toBe(owedBefore);
    expect(await parcel("A")).toMatchObject({ payoutDocId: null, paid: 0n, settlementRef: null });
    expect((await parcel("C")).settledStatus).toBeNull();
  });

  it("a loadsheet dates the dispatch of the parcels it lists; removing it takes the date back off", async () => {
    const text = ["Tracking Number,Order Ref,COD Amount", "PX-F,#F,1180"].join("\n");
    const r = await CS.recordLoadsheet(book, { text, courier: "PostEx", ref: "LS-1", date: day.d2!, formKey: "load-key-0001" }, "owner");
    const f = await parcel("F");
    expect(B.fromDbDate(f.dispatchedOn)).toBe(day.d2);
    expect(f.loadsheetId).toBe(r.sheetId);
    await CS.removeLoadsheet(book, r.sheetId!);
    expect(await parcel("F")).toMatchObject({ dispatchedOn: null, loadsheetId: null });
  });

  it("a lost parcel comes off sales with its share of tax, for its store; one that came back can't be", async () => {
    const before = { owed: await bal("Owed by couriers"), returns: await bal("Returns"), tax: await bal("Sales tax to pay") };
    const a = await parcel("A");
    const tax = await G.orderTotals([store], ["A"]);
    expect(tax.get("A")).toEqual({ total: "1180", tax: "180" });
    const w = await P.writeOffParcels(book, tax, { parcelIds: [a.id], reason: "lost", date: today }, "owner");
    expect(w).toMatchObject({ count: 1, amount: 118_000n });
    expect((await prisma.bkDocument.findUniqueOrThrow({ where: { id: w.docId } })).storeId).toBe(store);
    expect(await bal("Owed by couriers")).toBe(before.owed - 118_000n);
    expect(await bal("Returns")).toBe(before.returns + 100_000n);
    expect(await bal("Sales tax to pay")).toBe(before.tax + 18_000n);
    expect((await stage("A")).stage).not.toBe("delivered");
    // A parcel that came back can't be written off.
    const c = await parcel("C");
    await expect(P.writeOffParcels(book, tax, { parcelIds: [c.id], reason: "lost", date: today }, "owner")).rejects.toThrow(/can't be written off/);
  });
});
