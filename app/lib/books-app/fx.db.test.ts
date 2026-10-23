/**
 * Books in more than one currency against Postgres (v1.1 V1, D-96 to D-99):
 * past rates filled in, orders and ad spend converted at their day's rate (or
 * left out and said with no rate), a store in another currency added to a
 * book, and a foreign card revalued at month end. Synthetic data only, in a
 * private schema with all of Growzar's migrations (test-db.ts). Runs only
 * with BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";
import type { FeedOrder } from "./connectors/sales";

const run = TEST_DATABASE_URL ? describe : describe.skip;
const money = (amount: number, currency: string) => ({ amount: amount.toFixed(2), currency });

run("Books in more than one currency", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../books/books.server");
  let R: typeof import("./connectors/runs.server");
  const was = process.env.BOOKS_ENABLED;
  const t = Date.now();
  const org = `fx-org-${t}`;
  const pkrStore = `fx-pkr-${t}`;
  const aedStore = `fx-aed-${t}`;
  const day: Record<string, string> = {};
  let book: Awaited<ReturnType<typeof import("../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};

  const order = (id: string, store: string, d: string, currency: string, sub: number, tax: number): FeedOrder =>
    ({
      orderId: id,
      orderName: `#${id}`,
      createdAt: `${d}T10:00:00+05:00`,
      cancelledAt: null,
      test: false,
      currency: { code: currency },
      money: { placed: money(sub + tax, currency), discounts: money(0, currency), shipping: money(0, currency), tax: money(tax, currency) },
      payment: { gateways: ["card"] },
      transactions: [{ kind: "sale", gateway: "card", amount: money(sub + tax, currency) }],
      unpaidGateway: null,
      everShipped: true,
      lineItems: [{ lineId: `${id}-1`, variantId: "v1", quantity: 1, unitPrice: money(sub, currency), totalDiscount: money(0, currency), unitCost: money(sub * 0.4, currency), isGiftCard: false }],
      refunds: [],
      orderFacts: { available: true },
      store,
    }) as unknown as FeedOrder;
  const putOrder = (o: FeedOrder & { store?: string }) =>
    prisma.rawRecord.create({ data: { storeId: o.store!, app: "FINANCIFY", entity: "ORDER", externalId: o.orderId, sourceUpdatedAt: new Date(), payload: { ...o, localDay: o.createdAt.slice(0, 10) } as never } });
  const bal = async (name: string) => (await B.ledgerSums(book.id)).get(acc[name]!) ?? 0n;

  beforeAll(async () => {
    process.env.BOOKS_ENABLED = "on";
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books/books.server");
    R = await import("./connectors/runs.server");
    const D = await import("../books/dates");
    const P = await import("../books/posting");
    const today = D.todayIn("Asia/Karachi");
    for (const [k, n] of [["start", -6], ["d1", -5], ["d2", -4]] as const) day[k] = P.addDays(today, n);
    await prisma.organization.create({ data: { id: org, name: "FX Org", slug: org, baseCurrency: "PKR" } });
    for (const [id, currency] of [[pkrStore, "PKR"], [aedStore, "AED"]] as const) {
      await prisma.store.create({ data: { id, organizationId: org, shopDomain: `${id}.myshopify.com`, displayName: currency === "PKR" ? "Lahore Store" : "Dubai Store", currency, timezone: "Asia/Karachi" } });
      await prisma.appConnection.create({ data: { storeId: id, app: "FINANCIFY", status: "CONNECTED" } });
    }
    await prisma.booksSettings.create({ data: { organizationId: org, enabled: true } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: day.start!, moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: day.start!, storeIds: [pkrStore], codBasis: "delivery" } }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
    // One stored rate, on d1: PKR per AED. Nothing for USD.
    await prisma.fxRate.create({ data: { base: "PKR", currency: "AED", day: day.d1!, rate: "75.5", source: "test rate" } });
  });

  afterAll(async () => {
    process.env.BOOKS_ENABLED = was;
    if (B) await B.purgeBooks(org).catch(() => undefined);
    if (B) await B.purgeBooks(`${org}-card`).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("past rates fill only the days nothing covers, inverted into units of the base (D-98)", async () => {
    const { fillFxHistory } = await import("../metrics/fx-history.server");
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      const d = /currency-api@([\d-]+)\//.exec(url)![1]!;
      return new Response(JSON.stringify({ date: d, sar: { pkr: 0.0135, usd: 0.26666667, sar: 1 } }));
    }) as unknown as typeof fetch;
    await prisma.fxRate.create({ data: { base: "SAR", currency: "PKR", day: "2026-07-02", rate: "0.0135", source: "Financify daily rate" } });
    const r = await fillFxHistory(["SAR"], new Date("2026-07-04T12:00:00Z"), fetcher);
    expect(r).toMatchObject({ days: 2, stored: 4, problems: [] });
    expect(asked.map((u) => /@([\d-]+)\//.exec(u)![1])).toEqual(["2026-07-01", "2026-07-03"]);
    const row = await prisma.fxRate.findUniqueOrThrow({ where: { base_currency_day: { base: "SAR", currency: "USD", day: "2026-07-03" } } });
    expect(row).toMatchObject({ rate: "3.74999995313", source: "fawazahmed0 currency-api (jsDelivr)" });
    // Financify's day stays as it was.
    expect((await prisma.fxRate.findUniqueOrThrow({ where: { base_currency_day: { base: "SAR", currency: "PKR", day: "2026-07-02" } } })).source).toBe("Financify daily rate");
  });

  it("a store in another currency joins the book; ad spend starts over from its start date (D-96)", async () => {
    const { addStore } = await import("./stores.server");
    await prisma.bkConnector.create({ data: { bookId: book.id, key: "ad_spend", enabled: false, mode: "auto", startDate: B.toDbDate(day.start!), syncedThrough: B.toDbDate(day.d2!), settings: {} } });
    expect(await addStore(book, org, aedStore, "owner")).toEqual({ name: "Dubai Store", currency: "AED" });
    book = (await B.getBook(org))!;
    expect(book.settings.storeIds).toEqual([pkrStore, aedStore]);
    expect((await prisma.bkConnector.findFirstOrThrow({ where: { bookId: book.id, key: "ad_spend" } })).syncedThrough).toBeNull();
    await expect(addStore(book, org, aedStore, "owner")).rejects.toThrow(/already in these books/);
    await expect(addStore(book, org, "someone-elses", "owner")).rejects.toThrow(/isn't in your organization/);
    await prisma.bkConnector.deleteMany({ where: { bookId: book.id, key: "ad_spend" } });
  });

  it("orders convert at their day's rate (or the latest within a week); with no rate they're left out and said", async () => {
    const S = await import("./connectors/sales.server");
    await putOrder(order("A", pkrStore, day.d1!, "PKR", 1000, 180));
    await putOrder(order("B", pkrStore, day.d1!, "AED", 100, 0));
    await putOrder(order("C", pkrStore, day.d1!, "USD", 50, 0));
    await putOrder(order("D", aedStore, day.d2!, "AED", 200, 0));
    const mapping = await S.checkSalesMapping(book, await S.salesDefaults(book));
    await R.saveConnector(book, "shopify_sales", { enabled: true, mode: "auto", startDate: day.start!, settings: { mapping } as never }, "owner");
    const r = await R.runConnector(book, "shopify_sales", "manual", S.runSales);
    const notes = r!.notes.join(" | ");
    expect(notes).toMatch(/Lahore Store: 1 order in AED \(100\.00\) converted into PKR at each day's rate \(test rate\)/);
    expect(notes).toMatch(/Dubai Store: 1 order in AED \(200\.00\) converted into PKR/);
    expect(notes).toMatch(/Lahore Store: 1 order in USD \(50\.00\) left out/);
    // 1,000 + 100 × 75.5 + 200 × 75.5; the USD order isn't in.
    expect(-(await bal("Sales"))).toBe(100_000n + 755_000n + 1_510_000n);
    expect(-(await bal("Sales tax to pay"))).toBe(18_000n);
    expect(await bal("Cost of what you sold")).toBe(40_000n + 302_000n + 604_000n);
    const docs = await prisma.bkDocument.findMany({ where: { bookId: book.id, source: "shopify_sales" }, select: { storeId: true } });
    expect(new Set(docs.map((d) => d.storeId))).toEqual(new Set([pkrStore, aedStore]));
    // A re-run converts the same way: nothing new, nothing corrected.
    expect(await R.runConnector(book, "shopify_sales", "manual", S.runSales)).toMatchObject({ created: 0, updated: 0 });
  });

  it("ad spend in another currency converts at its day's rate; with no rate it waits and says so", async () => {
    const A = await import("./connectors/ad-spend.server");
    const row = (store: string, d: string, currency: string, spend: string, fees: string) =>
      prisma.adSpend.create({ data: { storeId: store, day: d, level: "platform", key: "facebook", platform: "facebook", spendAmount: spend, feesAmount: fees, currency, method: "measured", fxStatus: "ok", detail: {} } });
    await row(aedStore, day.d1!, "AED", "10", "1");
    await row(pkrStore, day.d1!, "USD", "5", "0");
    const input = await A.parseAdSpendForm(book, { enabled: true, mode: "auto", startDate: day.start!, platforms: (await A.adSpendDefaults(book)).platforms }, day.d2!);
    await R.saveConnector(book, "ad_spend", { ...input, settings: input.settings as never }, "owner");
    const r = await R.runConnector(book, "ad_spend", "manual", A.runAdSpend);
    expect(r!.notes.join(" ")).toMatch(/1 platform-day of spend in USD have no USD rate yet, so it waits/);
    expect(await bal("Advertising")).toBe(75_500n + 7_550n);
  });

  it("a foreign card is revalued at month end against exchange gains and losses, once (D-99)", async () => {
    const V = await import("./revaluation.server");
    await prisma.organization.create({ data: { id: `${org}-card`, name: "Card Org", slug: `${org}-card`, baseCurrency: "PKR" } });
    const card = await B.setupBook(`${org}-card`, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: "2026-09-01", moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: "2026-09-01" } }, "owner");
    const usd = (await B.createMoneyAccount(card, { subtype: "card", name: "USD card", opening: 0n, date: "2026-09-01", currency: "USD" }, null)).account.id;
    const ads = (await B.listAccounts(card)).find((a) => a.name === "Advertising")!.id;
    // USD 100 of ads at 280: PKR 28,000 on the card.
    const r = await B.saveAndPost(card, { type: "expense", date: "2026-09-10", data: { paidFrom: usd, lines: [{ accountId: ads, amount: "2800000" }], fx: { [usd]: { amount: "10000" } } } }, "owner");
    expect(r.error).toBeUndefined();
    await prisma.fxRate.create({ data: { base: "PKR", currency: "USD", day: "2026-09-30", rate: "277.0", source: "test rate" } });
    const now = new Date("2026-10-02T12:00:00Z");
    expect(await V.revalueDue(card, now)).toEqual({ posted: 1, notes: [] });
    const sums = await B.ledgerSums(card.id);
    const gains = (await B.listAccounts(card)).find((a) => a.name === "Exchange gains and losses")!.id;
    expect(sums.get(usd)).toBe(-2_770_000n);
    expect(sums.get(gains)).toBe(-30_000n);
    expect(await V.revalueDue(card, now)).toEqual({ posted: 0, notes: [] });
    // Closed months aren't touched.
    await B.setClosedThrough(card, "2026-09-30", "2026-10-02", "owner");
    expect(await V.revalueDue((await B.getBook(`${org}-card`))!, new Date("2026-10-05T12:00:00Z"))).toEqual({ posted: 0, notes: [] });
  });
});
