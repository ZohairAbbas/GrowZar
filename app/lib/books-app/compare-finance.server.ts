import { prisma } from "../db.server";
import { storeSummary } from "../metrics/summaries.server";
import { ledgerSums, listAccounts, toDbDate, type BookView } from "../books/books.server";
import type { DateRange } from "../books/dates";
import { decimalToMinor, type SalesMapping } from "../books/connectors/shopify-sales";
import type { AdSpendSettings } from "./connectors/ad-spend";
import type { PayoutMapping } from "./connectors/courier-payouts";
import { getConnector } from "./connectors/runs.server";
import { booksRows, classifyAccounts, compareRows, financeRows } from "./compare-finance";

/**
 * The one place Books reads Finance (D-69): to show Finance's profit next to
 * Books' so the merchant can see why the two differ. Read-only: nothing here
 * is written to the books, and nothing in Books is built from these numbers.
 * One store at a time, because Finance works store by store.
 */
export async function compareWithFinance(book: BookView, storeId: string, range: DateRange) {
  const [accounts, storeMoves, unassignedMoves, sales, ads, courier, drafts, summary] = await Promise.all([
    listAccounts(book, { includeArchived: true }),
    ledgerSums(book.id, { from: range.from, to: range.to, storeId }),
    ledgerSums(book.id, { from: range.from, to: range.to, storeId: null }),
    getConnector(book, "shopify_sales"),
    getConnector(book, "ad_spend"),
    getConnector(book, "courierify_payouts"),
    prisma.bkDocument.count({ where: { bookId: book.id, status: "draft", date: { gte: toDbDate(range.from), lte: toDbDate(range.to) } } }),
    storeSummary(storeId, range.from, range.to),
  ]);
  const m = (sales.settings as { mapping?: Partial<SalesMapping> }).mapping ?? {};
  const platforms = (ads.settings as Partial<AdSpendSettings>).platforms ?? {};
  const payout = (courier.settings as { mapping?: Partial<PayoutMapping> }).mapping ?? {};
  const classes = classifyAccounts(accounts, {
    salesAccounts: [m.sales, m.shipping, m.discounts, m.returns, m.held].filter((x): x is string => !!x),
    cogs: m.cogs ?? null,
    adAccounts: Object.values(platforms).flatMap((p) => [p.advertising, p.fees]).filter((x): x is string => !!x),
    courierAccounts: [payout.delivery, payout.returns, payout.other, payout.tax].filter((x): x is string => !!x),
  });
  const books = booksRows(classes, storeMoves, unassignedMoves);
  const booksNet = Object.values(books).reduce((a, b) => a + b, 0n);
  const coverage = [sales, ads, courier].map((c) => ({ key: c.key, enabled: c.enabled, startDate: c.startDate, syncedThrough: c.syncedThrough }));

  const problems: string[] = [];
  let finance: ReturnType<typeof financeRows> | null = null;
  if (!summary.store.currency || !summary.profit) {
    problems.push("Finance has no profit for this store yet.");
  } else if (summary.store.currency !== book.currency) {
    problems.push(`Finance shows this store in ${summary.store.currency} and your books are in ${book.currency}, so the two can't be put side by side.`);
  } else {
    finance = financeRows(summary.profit.parts, (s) => decimalToMinor(s, book.decimals));
    if (summary.store.timezone && book.settings.timeZone && summary.store.timezone !== book.settings.timeZone) {
      problems.push(`Your store's days run on ${summary.store.timezone} time and your books on ${book.settings.timeZone}, so days near midnight may fall differently.`);
    }
  }
  return {
    range,
    drafts,
    coverage,
    problems,
    // What Finance itself says it couldn't count (orders still open, fees unknown, ad spend not fetched…).
    financeMissing: summary.profit?.missing ?? [],
    booksNet,
    financeNet: finance?.net ?? null,
    rows: finance ? compareRows(finance.rows, books) : null,
    booksOnly: books,
  };
}
