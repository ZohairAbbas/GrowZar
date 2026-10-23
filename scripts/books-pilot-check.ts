/**
 * B8 (one-off, not committed): the pilot's checks on Pilot's book. Prints
 * aggregates only: totals per month, counts, differences. No order, buyer,
 * statement line or memo.
 *
 * 1. Whole-book checks per month: the ledger nets to zero, every entry
 *    balances, the balance sheet balances, P&L ties to the balance sheet's
 *    profit for the year, cash flow closes on money.
 * 2. Books against Finance per store and month (compare-finance rows).
 * 3. Courier payouts in Books against Courierify's attributable settlements.
 * 4. Connector runs: last status and notes.
 */
import { prisma } from "../app/lib/db.server";
import { getBook, ledgerSums, reportAccounts } from "../app/lib/books/books.server";
import { addDays } from "../app/lib/books/posting";
import { monthEnd, resolveRange, todayIn } from "../app/lib/books/dates";
import { buildCashFlow, buildReport } from "../app/lib/books/report-data.server";
import { compareWithFinance } from "../app/lib/books-app/compare-finance.server";
import { attributable } from "../app/lib/metrics/settlements";

const ORG = "4c9385d8-38fe-44fb-9709-261640cb92a6";
const book = (await getBook(ORG))!;
const today = todayIn(book.settings.timeZone);
const start = book.settings.startDate!;
const stores = await prisma.store.findMany({ where: { id: { in: book.settings.storeIds ?? [] } }, select: { id: true, shopDomain: true } });
const name = (id: string) => stores.find((s) => s.id === id)?.shopDomain.replace(/\.myshopify\.com$/, "") ?? id;
const f = (v: bigint) => (Number(v) / 10 ** book.decimals).toLocaleString("en-US", { maximumFractionDigits: 0 });
const months: Array<{ from: string; to: string }> = [];
for (let m = start; m <= today; m = addDays(monthEnd(m), 1)) months.push({ from: m, to: monthEnd(m) < today ? monthEnd(m) : today });

console.log(`# Pilot book: ${book.currency}, from ${start}, today ${today}, closed through ${book.lockedThrough ?? "nothing"}\n`);
const docs = await prisma.bkDocument.groupBy({ by: ["source", "status"], where: { bookId: book.id }, _count: { _all: true } });
console.log("## Entries by source and state");
for (const d of docs.sort((a, b) => String(a.source).localeCompare(String(b.source)))) console.log(`- ${d.source ?? "manual"} · ${d.status}: ${d._count._all}`);

console.log("\n## 1. Whole-book checks (each month end)");
const unbalanced = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM (SELECT "entryId" FROM bk_entry_lines WHERE "bookId" = ${book.id} GROUP BY "entryId" HAVING SUM(amount) <> 0) t`;
console.log(`- Unbalanced entries: ${unbalanced[0]!.n}`);
for (const m of months) {
  const sums = await ledgerSums(book.id, { to: m.to });
  const net = [...sums.values()].reduce((a, b) => a + b, 0n);
  const bs = (await buildReport(book, today, "balance-sheet", new URLSearchParams({ date: m.to }))).bs!;
  const tb = (await buildReport(book, today, "trial-balance", new URLSearchParams({ date: m.to }))).tb!;
  const plYear = (await buildReport(book, today, "profit-and-loss", new URLSearchParams({ range: "custom", from: start, to: m.to }))).pl!;
  const pl = (await buildReport(book, today, "profit-and-loss", new URLSearchParams({ range: "custom", from: m.from, to: m.to }))).pl!;
  const profitRow = bs.equity.rows.find((r) => /profit/i.test(r.name) && !r.depth);
  const cf = (await buildCashFlow(book, today, new URLSearchParams({ range: "custom", from: m.from, to: m.to }))).cf;
  console.log(
    `- ${m.from.slice(0, 7)}: ledger ${net === 0n ? "nets to 0" : `OFF ${f(net)}`}; TB ${tb.totalDebit === tb.totalCredit ? "equal" : "OFF"}; BS ${bs.difference === 0n ? "balances" : `OFF ${f(bs.difference)}`}; ` +
      `P&L year-to-date ${f(plYear.netProfit)} vs BS profit ${profitRow ? f(profitRow.amount) : "—"}; cash flow ${cf.difference === 0n ? "closes" : `OFF ${f(cf.difference)}`}; month profit ${f(pl.netProfit)} (sales ${f(pl.sales.total)}, cost of sales ${f(pl.costOfSales.total)}, running costs ${f(pl.expenses.total)})`,
  );
}

console.log("\n## 2. Books against Finance (per store and month; Books − Finance)");
for (const s of stores) {
  for (const m of months) {
    const c = await compareWithFinance(book, s.id, resolveRange({ range: "custom", from: m.from, to: m.to }, today, book.fiscalYearStartMonth));
    if (!c.rows) {
      console.log(`- ${name(s.id)} ${m.from.slice(0, 7)}: ${c.problems.join(" ")}`);
      continue;
    }
    const row = (k: string) => c.rows!.find((r) => r.key === k)!;
    console.log(
      `- ${name(s.id)} ${m.from.slice(0, 7)}: profit Finance ${f(c.financeNet!)} / Books ${f(c.booksNet)}; ` +
        ["sales", "cogs", "courier", "ads", "payment", "taxes", "other", "unassigned"].map((k) => `${k} ${f(row(k).finance)}/${f(row(k).books)}`).join(", ") +
        `${c.financeMissing.length ? ` · Finance incomplete: ${c.financeMissing.join("; ")}` : ""}`,
    );
  }
}

console.log("\n## 3. Courier payouts: Books against Courierify's settlements (by settlement month)");
for (const s of stores) {
  const raw = await prisma.rawRecord.findMany({ where: { storeId: s.id, app: "COURIERIFY", entity: "SETTLEMENT", deletedAt: null }, select: { payload: true } });
  const payouts = await prisma.bkDocument.findMany({ where: { bookId: book.id, storeId: s.id, type: "courier_payout", source: "courierify_payouts" }, select: { status: true, date: true, data: true } });
  for (const m of months) {
    const inMonth = raw.map((r) => r.payload as Record<string, unknown>).filter((p) => typeof p.settlementDate === "string" && p.settlementDate.slice(0, 10) >= m.from && p.settlementDate.slice(0, 10) <= m.to && (p.direction ?? "payout") === "payout");
    const mine = inMonth.filter(attributable);
    const net = mine.reduce((a, p) => a + Number((p.netPaid as { amount?: string } | null)?.amount ?? p.netPaid ?? 0), 0);
    const books = payouts.filter((d) => d.date.toISOString().slice(0, 10) >= m.from && d.date.toISOString().slice(0, 10) <= m.to);
    const posted = books.filter((d) => d.status === "posted");
    console.log(`- ${name(s.id)} ${m.from.slice(0, 7)}: Courierify ${mine.length} settlements for this store (net ${Math.round(net).toLocaleString("en-US")}; ${inMonth.length - mine.length} whole-account batches left out) · Books ${posted.length} posted (net received ${f(posted.reduce((a, d) => a + BigInt(String((d.data as { received?: string }).received ?? "0")), 0n))}), ${books.length - posted.length} other`);
  }
}

console.log("\n## 4. Connector runs");
for (const c of await prisma.bkConnector.findMany({ where: { bookId: book.id }, orderBy: { key: "asc" } })) {
  console.log(`- ${c.key}: ${c.enabled ? "on" : "off"}, ${c.mode}, synced through ${c.syncedThrough?.toISOString().slice(0, 10) ?? "—"}, last ${c.lastStatus ?? "—"} at ${c.lastRunAt?.toISOString() ?? "—"}`);
  const runs = await prisma.bkConnectorRun.findMany({ where: { connectorId: c.id }, orderBy: { startedAt: "desc" }, take: 3, select: { status: true, message: true, startedAt: true } });
  for (const r of runs) console.log(`  - ${r.startedAt.toISOString()} ${r.status}: ${(r.message ?? "").slice(0, 400)}`);
}
await prisma.$disconnect();
