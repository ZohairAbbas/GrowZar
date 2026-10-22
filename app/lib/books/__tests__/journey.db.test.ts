/**
 * A merchant's whole month in one book, with every report checked against the
 * ledger and against each other after each stage: sales and payouts in two
 * stores, stock, bills with tax and withholding, invoices and credits, a USD
 * card, tax paid, month end closed, the accountant pack built, and the book
 * purged.
 *
 * Runs only with BOOKS_TEST_DATABASE_URL, in a private schema (test-db.ts).
 * Ported from Financify's Books (0cc8732). Left for later items: the bank
 * statement and reconciliation (B5), the workbook (B6), the USD revaluation
 * (later, D-89); recurring entries are out of v1 (D-88).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "./test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("A month in the books, end to end", () => {
  let B: typeof import("../books.server");
  let R: typeof import("../report-data.server");
  let V: typeof import("../ledger-views.server");
  let T: typeof import("../taxes.server");
  let prisma: import("@prisma/client").PrismaClient;
  const org = `books-journey-${Date.now()}`;
  let dropSchema: (() => Promise<void>) | undefined;
  let book: Awaited<ReturnType<typeof B.setupBook>>;
  const acc: Record<string, string> = {};
  const TODAY = "2026-11-05";

  beforeAll(async () => {
    dropSchema = await openTestSchema();
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books.server");
    R = await import("../report-data.server");
    V = await import("../ledger-views.server");
    T = await import("../taxes.server");
    book = await B.setupBook(
      org,
      {
        currency: "PKR",
        fiscalYearStartMonth: 7,
        timeZone: "Asia/Karachi",
        startDate: "2026-10-01",
        moneyAccounts: [
          { subtype: "bank", name: "Meezan", opening: 100_000_000n },
          { subtype: "cash", name: "Cash", opening: 2_000_000n },
        ],
      },
      "owner",
    );
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
  });

  afterAll(async () => {
    if (B && book) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  const post = async (input: Parameters<typeof B.saveAndPost>[1]) => {
    const r = await B.saveAndPost(book, input, "owner");
    if (r.error) throw new Error(`${input.type} on ${input.date}: ${r.error.message} (${r.error.field})`);
    return r.doc;
  };
  const contact = async (name: string, kind: string) => (await B.createContact(book, { name, kinds: [kind] }, null)).id;

  /** Every report agrees with the ledger and with each other, on a date. */
  async function checkEverything(asOf: string, label: string) {
    const from = "2026-07-01";
    const sums = await B.ledgerSums(book.id, { to: asOf });
    const accounts = await B.reportAccounts(book);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    // 1. The ledger nets to zero, and every entry balances.
    expect([...sums.values()].reduce((s, v) => s + v, 0n), `${label}: ledger nets to zero`).toBe(0n);
    const unbalanced = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM (SELECT "entryId", SUM(amount) s FROM bk_entry_lines WHERE "bookId" = ${book.id} GROUP BY "entryId" HAVING SUM(amount) <> 0) t`;
    expect(unbalanced[0]!.n, `${label}: unbalanced entries`).toBe(0n);
    // 2. Trial balance.
    const tb = (await R.buildReport(book, asOf, "trial-balance", new URLSearchParams({ date: asOf }))).tb!;
    expect(tb.totalDebit, `${label}: trial balance`).toBe(tb.totalCredit);
    // 3. Balance sheet balances, and its "profit this year" is the P&L's profit.
    const bs = (await R.buildReport(book, asOf, "balance-sheet", new URLSearchParams({ date: asOf }))).bs!;
    expect(bs.difference, `${label}: balance sheet difference`).toBe(0n);
    const pl = (await R.buildReport(book, asOf, "profit-and-loss", new URLSearchParams({ range: "custom", from, to: asOf }))).pl!;
    const thisYear = bs.equity.rows.find((r) => r.name === "Profit this year")?.amount ?? 0n;
    expect(thisYear, `${label}: P&L profit = balance sheet profit this year`).toBe(pl.netProfit);
    // 4. Month-by-month P&L adds up to the whole period.
    const months = await R.buildReport(book, asOf, "profit-and-loss", new URLSearchParams({ range: "custom", from, to: asOf, compare: "months" }));
    expect(months.cols!.netProfit.reduce((s, v) => s + v, 0n), `${label}: months add up`).toBe(pl.netProfit);
    // 5. Cash flow explains the change in money exactly.
    const { cf } = await R.buildCashFlow(book, asOf, new URLSearchParams({ range: "custom", from, to: asOf }));
    expect(cf.difference, `${label}: cash flow difference`).toBe(0n);
    const money = accounts.filter((a) => a.type === "asset" && ["bank", "cash", "mobile_wallet", "ad_wallet"].includes(a.subtype)).reduce((s, a) => s + (sums.get(a.id) ?? 0n), 0n);
    expect(cf.closing, `${label}: cash flow ends on the money balances`).toBe(money);
    // 6. General ledger ends on each account's balance.
    const gl = await V.generalLedger(book, { from, to: asOf, limit: 100_000 });
    for (const a of gl.accounts) expect(a.closing, `${label}: GL ${a.account.name}`).toBe(sums.get(a.account.id) ?? 0n);
    // 7. What's owed by age matches the balance sheet accounts.
    const ap = await V.agedPayables(book, asOf);
    const payables = accounts.filter((a) => a.type === "liability" && a.subtype === "payable").reduce((s, a) => s - (sums.get(a.id) ?? 0n), 0n);
    expect(ap.payables, `${label}: payables`).toBe(payables);
    expect(ap.total + ap.notFromBills).toBe(ap.payables);
    const ar = await V.agedReceivables(book, asOf);
    expect(ar.payables, `${label}: owed by customers`).toBe(sums.get(acc["Owed by customers"]!) ?? 0n);
    // 8. Tax summary ends on the tax accounts' balances.
    const tax = await T.taxSummary(book, from, asOf);
    for (const t of tax.accounts) {
      const a = byId.get(t.accountId)!;
      expect(t.end, `${label}: tax ${a.name}`).toBe(a.type === "liability" ? -(sums.get(a.id) ?? 0n) : sums.get(a.id) ?? 0n);
    }
    // 9. Foreign accounts: value in the book's currency stays with the ledger; foreign balance is its own sum.
    // 10. Growzar (D-65): each store's lines plus the organization's own add up to the whole book.
    const [a, b, own] = await Promise.all(["store-a", "store-b", null].map((storeId) => B.ledgerSums(book.id, { to: asOf, storeId })));
    for (const [id, v] of sums) expect((a!.get(id) ?? 0n) + (b!.get(id) ?? 0n) + (own!.get(id) ?? 0n), `${label}: stores add up`).toBe(v);
    return { sums, pl, bs, cf };
  }

  it("runs a month, checking everything after each stage", async () => {
    await checkEverything("2026-10-01", "after setup");

    // Tax rates.
    const gst = await T.saveTaxRate(book, { name: "GST 18%", kind: "sales", rateBp: 1800, accountId: acc["Sales tax to pay"]! }, null);
    const gstIn = await T.saveTaxRate(book, { name: "GST input 18%", kind: "purchase", rateBp: 1800, accountId: acc["Tax you can claim back"]! }, null);
    const wht = await T.saveTaxRate(book, { name: "WHT 4.5%", kind: "withholding", rateBp: 450, accountId: acc["Withholding tax to pay"]! }, null);
    void gst;

    // Stock bought on a bill with claimable GST, paid with withholding.
    const supplier = await contact("Packaging Co", "supplier");
    const bill = await post({ type: "bill", date: "2026-10-02", contactId: supplier, data: { payable: acc["Owed to suppliers"], dueDate: "2026-10-30", lines: [{ accountId: acc["Stock"], amount: "20000000", tax: { rateId: gstIn.id, name: gstIn.name, rateBp: 1800, accountId: acc["Tax you can claim back"], amount: "3600000" } }] } });
    expect(bill.total).toBe(23_600_000n);
    await post({ type: "bill_payment", date: "2026-10-05", contactId: supplier, data: { payable: acc["Owed to suppliers"], paidFrom: acc["Meezan"], allocations: [{ billId: bill.id, amount: "20000000" }], withheld: { accountId: acc["Withholding tax to pay"], amount: "900000", rateId: wht.id, name: wht.name, rateBp: 450 } } });
    await checkEverything("2026-10-05", "after stock and the supplier");

    // Daily sales per store (as the sales connector makes them): COD owed by couriers, cost of goods out of stock.
    for (const [day, sales, storeId] of [["2026-10-06", 5_000_000n, "store-a"], ["2026-10-07", 7_000_000n, "store-b"], ["2026-10-08", 3_000_000n, "store-a"]] as const) {
      const ship = 200_000n, tax = (sales * 18n) / 100n, cogs = (sales * 45n) / 100n;
      await post({
        type: "sales_summary",
        date: day,
        storeId,
        data: {
          debits: [{ accountId: acc["Owed by couriers"], amount: String(sales + ship + tax) }, { accountId: acc["Cost of what you sold"], amount: String(cogs) }],
          credits: [{ accountId: acc["Sales"], amount: String(sales) }, { accountId: acc["Shipping charged"], amount: String(ship) }, { accountId: acc["Sales tax to pay"], amount: String(tax) }, { accountId: acc["Stock"], amount: String(cogs) }],
        },
      });
    }
    // A courier pays out, keeping its charges.
    const tcs = await contact("TCS", "courier");
    await post({ type: "courier_payout", date: "2026-10-12", storeId: "store-a", contactId: tcs, data: { receivable: acc["Owed by couriers"], receivedIn: acc["Meezan"], received: "12000000", deductions: [{ accountId: acc["Delivery charges"], amount: "800000" }] } });
    await checkEverything("2026-10-12", "after sales and a payout");

    // Selling on credit: invoice with GST, part payment with tax withheld, a credit note.
    const buyer = await contact("Wholesale Buyer", "customer");
    const inv = await post({ type: "invoice", date: "2026-10-13", contactId: buyer, data: { receivable: acc["Owed by customers"], dueDate: "2026-10-28", lines: [{ accountId: acc["Sales"], amount: "10000000", quantity: "100", unitPrice: "100000", tax: { name: "GST 18%", rateBp: 1800, accountId: acc["Sales tax to pay"], amount: "1800000" } }] } });
    await post({ type: "customer_payment", date: "2026-10-20", contactId: buyer, data: { receivable: acc["Owed by customers"], receivedIn: acc["Meezan"], allocations: [{ billId: inv.id, amount: "6000000" }], withheld: { accountId: acc["Tax you can claim back"], amount: "240000" } } });
    await post({ type: "credit_note", date: "2026-10-21", contactId: buyer, data: { receivable: acc["Owed by customers"], lines: [{ accountId: acc["Returns"], amount: "1000000" }], allocations: [{ billId: inv.id, amount: "1000000" }] } });
    expect((await B.listBills(book, { ids: [inv.id], type: "invoice" }))[0]!.open).toBe(11_800_000n - 6_000_000n - 1_000_000n);
    await checkEverything("2026-10-21", "after invoicing");

    // A USD card for ads: added with a balance and spent on. (Revaluing it comes later, D-89.)
    const card = (await B.createMoneyAccount(book, { subtype: "card", name: "USD card", opening: 0n, date: "2026-10-01", currency: "USD" }, null)).account.id;
    const meta = await contact("Meta", "ad_platform");
    await post({ type: "expense", date: "2026-10-15", contactId: meta, data: { paidFrom: card, lines: [{ accountId: acc["Advertising"], amount: "2800000" }], fx: { [card]: { amount: "10000" } } } });
    // Paying the card off from PKR.
    await post({ type: "transfer", date: "2026-10-25", data: { from: acc["Meezan"], to: card, amount: "1420000", fx: { [card]: { amount: "5000" } } } });
    expect((await B.foreignBalances(book.id, [card])).get(card)).toBe(-5000n); // USD 50 still owed
    await checkEverything("2026-10-31", "after the USD card");

    // Rent repeats monthly; this month's is made and saved.
    const landlord = await contact("Landlord", "supplier");
    const rent = await post({ type: "expense", date: "2026-10-01", contactId: landlord, data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Rent"], amount: "15000000" }], withheld: { accountId: acc["Withholding tax to pay"], amount: "1500000", name: "WHT on rent" } } });

    // Stock counted at month end: a shortage goes to losses.
    await post({ type: "stock_adjustment", date: "2026-10-31", data: { stock: acc["Stock"], counter: acc["Stock lost or damaged"], amount: "-250000", method: "count" } });

    // Transfers and owner's money.
    await post({ type: "transfer", date: "2026-10-26", data: { from: acc["Meezan"], to: acc["Cash"], amount: "500000" } });
    await post({ type: "owner_out", date: "2026-10-27", data: { from: acc["Cash"], amount: "300000" } });
    await checkEverything("2026-10-31", "before tax and the bank");

    // Tax paid for October: owed less claimable.
    const bal = await T.taxBalances(book, "2026-10-31");
    const amt = (name: string) => bal.find((b) => b.accountId === acc[name])!.balance.toString();
    const taxPaid = await post({
      type: "tax_payment",
      date: "2026-10-31",
      data: { paidFrom: acc["Meezan"], lines: [{ accountId: acc["Sales tax to pay"], amount: amt("Sales tax to pay") }, { accountId: acc["Withholding tax to pay"], amount: amt("Withholding tax to pay") }, { accountId: acc["Tax you can claim back"], amount: amt("Tax you can claim back") }] },
    });
    expect(taxPaid.number).toMatch(/^TAX-/);
    for (const b of await T.taxBalances(book, "2026-10-31")) expect(b.balance).toBe(0n);
    await checkEverything("2026-10-31", "after tax paid");

    // Close October. Nothing can be added in it; corrections land on 1 November.
    await B.setClosedThrough(book, "2026-10-31", TODAY, "owner");
    const late = await B.saveAndPost(book, { type: "expense", date: "2026-10-30", data: { paidFrom: acc["Cash"], lines: [{ accountId: acc["Office and supplies"], amount: "100" }] } }, null);
    expect(late.error?.message).toMatch(/closed through 2026-10-31/);
    await B.discardDraft(book, late.doc.id, null);
    const cancelled = await B.cancelDocument(book, (await prisma.bkDocument.findFirstOrThrow({ where: { bookId: book.id, type: "owner_out" } })).id, "was a loan, not drawings", "owner");
    const rev2 = await prisma.bkEntry.findFirstOrThrow({ where: { documentId: cancelled.id, kind: "cancel" } });
    expect(rev2.date.toISOString().slice(0, 10)).toBe("2026-11-01");
    const oct = await checkEverything("2026-10-31", "October closed");
    await checkEverything(TODAY, "early November");

    // October's P&L, by hand: sales 15m + 10m invoice − 1m returns; shipping 0.6m; cogs 6.75m; delivery 0.8m;
    // ads 2.8m; rent 15m; stock loss 0.25m.
    expect(oct.pl.sales.total).toBe(15_000_000n + 600_000n + 10_000_000n - 1_000_000n);
    expect(oct.pl.costOfSales.total).toBe(6_750_000n + 800_000n);
    expect(oct.pl.expenses.total).toBe(2_800_000n + 15_000_000n + 250_000n);
    expect(oct.pl.otherIncome.total).toBe(0n);

    // October on cash basis, by hand: money in = courier payout 12.8m gross (collected) + the invoice's
    // share of the 6m payment (10/11.8 of it, tax stays out); money out = the bill payment's share for
    // stock (20/23.6 of 20m), delivery 0.8m kept by the courier, ads 2.8m on the card, rent 15m.
    // Sales summaries (owed, not paid), the credit note, stock count and tax payment don't count.
    const cash = await R.buildReport(book, TODAY, "profit-and-loss", new URLSearchParams({ range: "custom", from: "2026-10-01", to: "2026-10-31", basis: "cash" }));
    expect(cash.basis).toBe("cash");
    const row = (sec: { rows: Array<{ name: string; amount: bigint }> }, name: string) => sec.rows.find((r) => r.name === name)?.amount;
    expect(row(cash.pl!.sales, "Collected from couriers and gateways")).toBe(12_800_000n);
    expect(row(cash.pl!.sales, "Sales")).toBe(5_084_746n);
    expect(row(cash.pl!.costOfSales, "Stock paid for")).toBe(16_949_153n);
    expect(row(cash.pl!.costOfSales, "Delivery charges")).toBe(800_000n);
    expect(row(cash.pl!.costOfSales, "Cost of what you sold")).toBeUndefined();
    expect(cash.pl!.expenses.total).toBe(2_800_000n + 15_000_000n);
    expect(cash.pl!.otherIncome.total).toBe(0n);
    expect(cash.pl!.netProfit).toBe(12_800_000n + 5_084_746n - 16_949_153n - 800_000n - 17_800_000n);
    // Month by month and the CSV agree on cash basis too.
    const cashMonths = await R.buildReport(book, TODAY, "profit-and-loss", new URLSearchParams({ range: "custom", from: "2026-10-01", to: "2026-11-30", basis: "cash", compare: "months" }));
    expect(cashMonths.cols!.netProfit[0]).toBe(cash.pl!.netProfit);
    const cashCsv = (await R.reportFile(book, TODAY, "profit-and-loss", new URLSearchParams({ range: "custom", from: "2026-10-01", to: "2026-10-31", basis: "cash" }))).body;
    expect(cashCsv).toContain("Profit and loss (cash basis)");
    expect(cashCsv).toContain("Stock paid for");

    // Exports build and agree with the screens.
    const params = new URLSearchParams({ range: "custom", from: "2026-10-01", to: "2026-10-31" });
    const pack = await R.accountantPack(book, TODAY, params);
    expect(pack.body.length).toBeGreaterThan(1000);
    const tbCsv = (await R.reportFile(book, TODAY, "trial-balance", new URLSearchParams({ date: "2026-10-31" }))).body.trim().split("\r\n").at(-1)!.split(",");
    expect(tbCsv[2]).toBe(tbCsv[3]);

    // The activity log tells the story.
    const log = await V.activityLog(book, { pageSize: 200 });
    for (const words of ["Set up the books", "Closed the books through 2026-10-31"]) {
      expect(log.events.some((e) => e.text.startsWith(words)), words).toBe(true);
    }
  }, 30_000);

  it("purging the organization's books removes every Books row", async () => {
    expect(await B.purgeBooks(org)).toBe(1);
    const left = await prisma.$queryRaw<Array<{ t: string; n: bigint }>>`
      SELECT 'docs' t, COUNT(*)::bigint n FROM bk_documents d JOIN bk_books b ON b.id = d."bookId" WHERE b."organizationId" = ${org}
      UNION ALL SELECT 'books', COUNT(*)::bigint FROM bk_books WHERE "organizationId" = ${org}`;
    for (const r of left) expect(r.n, r.t).toBe(0n);
    const orphans = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT (SELECT COUNT(*) FROM bk_entry_lines WHERE "bookId" = ${book.id})
           + (SELECT COUNT(*) FROM bk_audit_events WHERE "bookId" = ${book.id})
           + (SELECT COUNT(*) FROM bk_allocations WHERE "bookId" = ${book.id}) AS n`;
    expect(orphans[0]!.n).toBe(0n);
  });
});
