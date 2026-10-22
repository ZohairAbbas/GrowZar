/**
 * Books linked into the rest of Growzar against Postgres (B7): "received in
 * bank" from matched statements (rule #17), the cash-held card's lookup
 * (D-93), Ask's Books tools (D-73) and Plan's kept forecasts (D-94).
 * Synthetic data only (D-72), in a private schema with all of Growzar's
 * migrations (test-db.ts). Runs only with BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";
import type { CashForecast } from "../forecast/cash";
import type { ForecastBase } from "../forecast/base.server";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Books linked into Growzar", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../books/books.server");
  let R: typeof import("./bank-receipts.server");
  let book: Awaited<ReturnType<typeof import("../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const org = `links-org-${Date.now()}`;
  const store = `links-store-${Date.now()}`;
  const bankLine = new Map<string, string>();
  const was = process.env.BOOKS_ENABLED;

  const payout = async (ref: string, courier: string, day: string, net: string) => {
    const r = await B.upsertImported(book, {
      source: "courierify_payouts",
      sourceRef: ref,
      type: "courier_payout",
      date: day,
      data: { receivable: acc["Owed by couriers"]!, receivedIn: acc["Meezan"]!, received: net, deductions: [] },
      memo: `${courier} payout ${ref}`,
      contactName: courier,
      contactKind: "courier",
      storeId: store,
    });
    await B.postDocument(book, r.doc.id, null);
    const line = await prisma.bkEntryLine.findFirstOrThrow({ where: { bookId: book.id, accountId: acc["Meezan"]!, entry: { documentId: r.doc.id } } });
    bankLine.set(ref, line.id.toString());
  };

  beforeAll(async () => {
    process.env.BOOKS_ENABLED = "on";
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books/books.server");
    R = await import("./bank-receipts.server");
    await prisma.organization.create({ data: { id: org, name: "Links Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, displayName: "Store One", currency: "PKR", timezone: "Asia/Karachi" } });
    await prisma.booksSettings.create({ data: { organizationId: org, enabled: true } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: "2026-10-01", moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: "2026-10-01", storeIds: [store] } }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
    await payout("s1", "PostEx", "2026-10-05", "930000");
    await payout("s2", "PostEx", "2026-10-12", "500000");
    await payout("s3", "TCS", "2026-10-12", "200000");
    await payout("s4", "PostEx", "2026-10-20", "100000");
  });

  afterAll(async () => {
    process.env.BOOKS_ENABLED = was;
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("before any statement, nobody knows what reached the bank", async () => {
    expect(await R.payoutsInBank(store)).toBeNull();
    expect(await R.receivedInBank(store, "2026-10-01", "2026-10-31")).toBeNull();
  });

  it("a payout matched alone, two matched as one deposit, one not on a statement yet", async () => {
    const K = await import("../books/bank.server");
    const csv = ["Date,Description,Debit,Credit,Balance", "06/10/2026,COD SETTLEMENT REF 77,,9300.00,1", "13/10/2026,IBFT COURIERS 1234567890123,,7000.00,2"].join("\n");
    const mapping = { headerRow: 0, dateCol: 0, dateFormat: "DMY", descCols: [1], amountCol: null, outCol: 2, inCol: 3, balanceCol: 4, flip: false };
    await K.importStatement(book, { accountId: acc["Meezan"]!, fileName: "oct.csv", text: csv, mapping }, "owner");
    const lines = await prisma.bkStatementLine.findMany({ where: { bookId: book.id }, orderBy: { date: "asc" } });
    await K.matchStatementLine(book, lines[0]!.id.toString(), bankLine.get("s1")!);
    await K.matchGroup(book, [lines[1]!.id.toString()], [bankLine.get("s2")!, bankLine.get("s3")!]);

    const r = (await R.payoutsInBank(store))!;
    expect(r.payouts.map((p) => [p.settlementId, p.courier, p.day, p.net, p.inBankOn])).toEqual([
      ["s1", "PostEx", "2026-10-05", 930_000n, "2026-10-06"],
      ["s2", "PostEx", "2026-10-12", 500_000n, "2026-10-13"],
      ["s3", "TCS", "2026-10-12", 200_000n, "2026-10-13"],
      ["s4", "PostEx", "2026-10-20", 100_000n, null],
    ]);
    // Only amounts and days leave Books: never the statement's words.
    expect(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/SETTLEMENT|IBFT|1234567890123/);
  });

  it("Finance's received in bank, and the cash-held card's last day per payer", async () => {
    expect(await R.receivedInBank(store, "2026-10-01", "2026-10-31")).toEqual({
      payouts: 4,
      inBank: 3,
      received: { amount: "16300.00", currency: "PKR" },
      notYet: { amount: "1000.00", currency: "PKR" },
      lastInBankOn: "2026-10-13",
    });
    expect(await R.receivedInBank(store, "2026-10-01", "2026-10-07")).toMatchObject({ payouts: 1, inBank: 1 });
    expect(Object.fromEntries((await R.lastInBankByPayer(store, ["postex", "tcs", "leopards"]))!)).toEqual({ postex: "2026-10-13", tcs: "2026-10-13" });
  });

  it("Ask's Books tools: balances and report lines, no entry, memo or statement words", async () => {
    const { runTool } = await import("../ask/registry.server");
    const ctx = { organizationId: org, userId: "u", baseCurrency: "PKR", stores: [], can: () => true, now: new Date("2026-10-25T12:00:00Z"), memo: new Map(), booksTools: true };
    const bal = await runTool("books_balances", { date: "2026-10-25" }, ctx);
    expect(bal.status).toBe("ok");
    expect(bal.rows.find((x) => x.account === "Meezan")?.balance).toBe(17_300);
    expect(bal.rows.find((x) => x.account === "Owed by couriers")?.balance).toBe(-17_300);
    const pl = await runTool("books_report", { report: "balance_sheet", from: null, to: "2026-10-25", basis: null }, ctx);
    expect(pl.status).toBe("ok");
    const all = JSON.stringify([bal, pl]);
    expect(all).not.toMatch(/SETTLEMENT|IBFT|payout s1|PostEx payout/);
    // Without the gate the tool isn't there for this viewer.
    expect((await runTool("books_balances", { date: null }, { ...ctx, booksTools: false })).status).toBe("forbidden");
  });

  it("Books switched off: nothing reaches Finance", async () => {
    await prisma.booksSettings.update({ where: { organizationId: org }, data: { enabled: false } });
    expect(await R.receivedInBank(store, "2026-10-01", "2026-10-31")).toBeNull();
    expect(await R.lastInBankByPayer(store, ["postex"])).toBeNull();
    await prisma.booksSettings.update({ where: { organizationId: org }, data: { enabled: true } });
  });

  it("Plan keeps one forecast per week, and shows a past week against what happened", async () => {
    const H = await import("../forecast/cash-history.server");
    const range = (x: number) => ({ low: x * 0.8, likely: x, high: x * 1.2 });
    const forecast = (asOf: string, from: string): CashForecast => ({
      asOf,
      currency: "PKR",
      weeks: [0, 1, 2, 3].map((k) => {
        const d = (n: number) => new Date(Date.parse(`${from}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
        return { from: d(7 * k), to: d(7 * k + 6) };
      }),
      due: { byPayer: [], weeks: [range(10_000), range(1), range(1), range(1)], total: range(10_003) },
      paid: { byPayer: [{ payer: "postex", basis: "measured", weeks: [range(8_000), range(1), range(1), range(1)], total: range(8_003), reason: null }], weeks: [range(8_000), range(1), range(1), range(1)], total: range(8_003) },
      untimed: [],
      overdue: [],
      notTracked: { orders: 0, expected: range(0) },
      excluded: { noOdds: 0, otherCurrency: 0 },
      basis: { open: [], held: [] },
    });
    await H.keepWeekForecast(store, forecast("2026-10-12T06:00:00.000Z", "2026-10-12"));
    await H.keepWeekForecast(store, forecast("2026-10-14T06:00:00.000Z", "2026-10-14"));
    const kept = await prisma.cashForecastSnapshot.findMany({ where: { storeId: store } });
    expect(kept.map((k) => [k.week.toISOString().slice(0, 10), k.asOf.toISOString()])).toEqual([["2026-10-12", "2026-10-12T06:00:00.000Z"]]);
    const now = { asOf: new Date("2026-10-25T12:00:00Z"), parcels: [], rows: [] } as unknown as ForecastBase;
    const rows = await H.forecastHistory(store, now);
    expect(rows).toEqual([{ from: "2026-10-12", to: "2026-10-18", due: range(10_000), dueActual: 0, paid: range(8_000), paidActual: 0, bank: { received: 7_000, payouts: 2, inBank: 2 } }]);
    // The week still running isn't shown yet.
    expect(await H.forecastHistory(store, { ...now, asOf: new Date("2026-10-15T12:00:00Z") })).toEqual([]);
  });
});
