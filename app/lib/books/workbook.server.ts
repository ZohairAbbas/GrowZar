/**
 * The full Books export as an Excel workbook, styled like the dashboard's
 * reports (same writer, same styles): summary, statements, the ledger and
 * journal, tax and what's owed — one sheet each.
 *
 * Growzar: written with exceljs (xlsx.server.ts, D-91); the organization's
 * name in place of the shop's.
 */

import { buildXlsx, type StyleKey, type XCell, type XSheet } from "./xlsx.server";
import { foreignBalances, ledgerSums, reportAccounts, type BookView } from "./books.server";
import { currencyDecimals } from "./money";
import { formatDate, monthColumns } from "./dates";
import { agedPayables, agedReceivables, generalLedger, journal } from "./ledger-views.server";
import { buildCashFlow, buildReport, rangeFrom } from "./report-data.server";
import { AGE_BUCKETS, homeTiles, type ColumnSection, type ReportSection } from "./reports";
import { TAX_KIND_LABELS, formatRate } from "./tax";
import { taxSummary } from "./taxes.server";
import { SUBTYPE_LABELS, TYPE_LABELS, type AccountType } from "./chart";

/** Lines per ledger sheet; the CSV pack has everything. */
export const WORKBOOK_LINE_LIMIT = 30_000;

export async function buildWorkbook(book: BookView, today: string, params: URLSearchParams, organizationName: string): Promise<{ filename: string; body: Uint8Array }> {
  const range = rangeFrom(book, today, params);
  const scale = 10 ** book.decimals;
  const n = (v: bigint | string | number) => Number(v) / scale;
  const m = (v: bigint | string, s: "money" | "moneySubtotal" | "moneyTotal" | "moneySubtle" = "money"): XCell => ({ v: n(v), s });
  const t = (v: string, s: StyleKey = "default"): XCell => ({ v, s });
  const period = `${formatDate(range.from)} – ${formatDate(range.to)}`;
  const head = (title: string, sub: string): XCell[][] => [[t(title, "title")], [t(`${organizationName} · ${sub} · ${book.currency}`, "subtle")], []];
  const notes: string[] = [];

  const p = (extra: Record<string, string> = {}) => new URLSearchParams({ range: "custom", from: range.from, to: range.to, ...extra });
  const [pl, plMonths, bs, tb, cf, accounts, endBalances, tax, payables, receivables, plCash] = await Promise.all([
    buildReport(book, today, "profit-and-loss", p()),
    monthColumns(range.from, range.to) ? buildReport(book, today, "profit-and-loss", p({ compare: "months" })) : null,
    buildReport(book, today, "balance-sheet", new URLSearchParams({ date: range.to })),
    buildReport(book, today, "trial-balance", new URLSearchParams({ date: range.to })),
    buildCashFlow(book, today, p()),
    reportAccounts(book),
    ledgerSums(book.id, { to: range.to }),
    taxSummary(book, range.from, range.to),
    agedPayables(book, today),
    agedReceivables(book, today),
    buildReport(book, today, "profit-and-loss", p({ basis: "cash" })),
  ]);

  // A statement section: heading, rows (sub-accounts indented), total.
  const section = (rows: XCell[][], s: ReportSection, width = 2) => {
    rows.push([t(s.label, "section"), ...Array(width - 1).fill(t("", "section"))]);
    if (s.rows.length === 0) rows.push([t("Nothing in this period", "indent")]);
    for (const r of s.rows) rows.push([t(r.depth ? `    ${r.name}` : r.name, r.header ? "bold" : r.depth ? "indent" : "default"), m(r.amount, r.header ? "moneySubtotal" : "money")]);
    rows.push([t(`Total ${s.label.toLowerCase()}`, "labelSubtotal"), m(s.total, "moneySubtotal")]);
    rows.push([]);
  };
  const colSection = (rows: XCell[][], s: ColumnSection, cols: number) => {
    rows.push([t(s.label, "section"), ...Array(cols).fill(t("", "section"))]);
    for (const r of s.rows) rows.push([t(r.depth ? `    ${r.name}` : r.name, r.header ? "bold" : r.depth ? "indent" : "default"), ...r.amounts.map((a) => m(a, r.header ? "moneySubtotal" : "money"))]);
    rows.push([t(`Total ${s.label.toLowerCase()}`, "labelSubtotal"), ...s.totals.map((a) => m(a, "moneySubtotal"))]);
    rows.push([]);
  };
  const sheets: XSheet[] = [];

  // ── Profit and loss ──
  {
    const r = pl.pl!;
    const rows: XCell[][] = [...head("Profit and loss", period), [t("Account", "header"), t(book.currency, "headerRight")]];
    section(rows, r.sales);
    section(rows, r.costOfSales);
    rows.push([t("Gross profit", "labelSubtotal"), m(r.grossProfit, "moneySubtotal")], []);
    if (r.otherIncome.rows.length) section(rows, r.otherIncome);
    section(rows, r.expenses);
    rows.push([t(r.netProfit < 0n ? "Loss" : "Profit", "labelTotal"), m(r.netProfit, "moneyTotal")]);
    sheets.push({ name: "Profit and loss", cols: [44, 18], rows, freezeRows: 4, merges: ["A1:B1", "A2:B2"] });
  }

  // ── Profit and loss by month ──
  if (plMonths?.cols && plMonths.columns) {
    const c = plMonths.cols;
    const k = plMonths.columns.length;
    const rows: XCell[][] = [...head("Profit and loss by month", period), [t("Account", "header"), ...plMonths.columns.map((x) => t(x.label, "headerRight"))]];
    colSection(rows, c.sales, k);
    colSection(rows, c.costOfSales, k);
    rows.push([t("Gross profit", "labelSubtotal"), ...c.grossProfit.map((a) => m(a, "moneySubtotal"))], []);
    if (c.otherIncome.rows.length) colSection(rows, c.otherIncome, k);
    colSection(rows, c.expenses, k);
    rows.push([t("Profit", "labelTotal"), ...c.netProfit.map((a) => m(a, "moneyTotal"))]);
    sheets.push({ name: "P&L by month", cols: [40, ...Array(k).fill(15)], rows, freezeRows: 4, landscape: true });
  } else if (!monthColumns(range.from, range.to)) notes.push("Profit and loss by month is left out: the period is longer than 24 months.");
  // Growzar: a period inside one month has no month-by-month sheet, and needs no note (Financify said "longer than 24 months").


  // ── Profit and loss on cash basis ──
  {
    const r = plCash.pl!;
    const rows: XCell[][] = [...head("Profit and loss (cash basis)", period), [t("Account", "header"), t(book.currency, "headerRight")]];
    section(rows, r.sales);
    section(rows, r.costOfSales);
    rows.push([t("Gross profit", "labelSubtotal"), m(r.grossProfit, "moneySubtotal")], []);
    if (r.otherIncome.rows.length) section(rows, r.otherIncome);
    section(rows, r.expenses);
    rows.push([t(r.netProfit < 0n ? "Loss" : "Profit", "labelTotal"), m(r.netProfit, "moneyTotal")], []);
    rows.push([t("Sales count when the money arrives (courier and gateway payouts, invoices paid); costs when paid; stock when paid for. Tax, loans and owner money stay out.", "note")]);
    sheets.push({ name: "P&L cash basis", cols: [52, 18], rows, freezeRows: 4, merges: ["A1:B1", "A2:B2"] });
  }

  // ── Balance sheet ──
  {
    const b = bs.bs!;
    const rows: XCell[][] = [...head("Balance sheet", `on ${formatDate(range.to)}`), [t("Account", "header"), t(book.currency, "headerRight")]];
    section(rows, b.assets);
    section(rows, b.liabilities);
    rows.push([t("What you have minus what you owe", "labelSubtotal"), m(b.assets.total - b.liabilities.total, "moneySubtotal")], []);
    section(rows, b.equity);
    if (b.difference !== 0n) rows.push([t(`Doesn't balance by ${n(b.difference)} — please contact support`, "note")]);
    sheets.push({ name: "Balance sheet", cols: [44, 18], rows, freezeRows: 4, merges: ["A1:B1", "A2:B2"] });
  }

  // ── Cash flow ──
  {
    const c = cf.cf;
    const rows: XCell[][] = [...head("Cash flow", period), [t("", "header"), t(book.currency, "headerRight")], [t("Money at the start", "bold"), m(c.opening, "moneySubtotal")], []];
    section(rows, c.operating);
    section(rows, c.financing);
    rows.push([t("Change in money", "labelSubtotal"), m(c.netChange, "moneySubtotal")], [t("Money at the end", "labelTotal"), m(c.closing, "moneyTotal")], []);
    rows.push([t("Money means bank accounts, cash, mobile wallets and prepaid ad wallets. Credit cards count as something you owe.", "note")]);
    sheets.push({ name: "Cash flow", cols: [52, 18], rows, freezeRows: 4 });
  }

  // ── Trial balance ──
  {
    const x = tb.tb!;
    const rows: XCell[][] = [...head("Trial balance", `on ${formatDate(range.to)}`), [t("Code", "header"), t("Account", "header"), t("Debit", "headerRight"), t("Credit", "headerRight")]];
    for (const r of x.rows) rows.push([r.code, r.name, r.debit ? m(r.debit) : null, r.credit ? m(r.credit) : null]);
    rows.push([t("", "labelTotal"), t("Total", "labelTotal"), m(x.totalDebit, "moneyTotal"), m(x.totalCredit, "moneyTotal")]);
    sheets.push({ name: "Trial balance", cols: [10, 40, 18, 18], rows, freezeRows: 4 });
  }

  // ── Chart of accounts ──
  {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const fxIds = accounts.filter((a) => a.currency).map((a) => a.id);
    const fxEnd = await foreignBalances(book.id, fxIds, range.to);
    const rows: XCell[][] = [...head("Chart of accounts", `balances on ${formatDate(range.to)}`), [t("Code", "header"), t("Account", "header"), t("Type", "header"), t("Kind", "header"), t("Part of", "header"), t(`Balance in ${book.currency} (Dr + / Cr −)`, "headerRight"), t("Currency", "header"), t("Balance in its currency", "headerRight"), t("", "header")]];
    for (const a of [...accounts].sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))) {
      const fxv = a.currency ? Number(fxEnd.get(a.id) ?? 0n) / 10 ** currencyDecimals(a.currency) : null;
      rows.push([a.code, a.name, TYPE_LABELS[a.type as AccountType]?.accountant ?? a.type, SUBTYPE_LABELS[a.subtype] ?? a.subtype, a.parentId ? byId.get(a.parentId)?.name ?? "" : "", m(endBalances.get(a.id) ?? 0n), a.currency ?? "", fxv === null ? null : { v: fxv, s: "money" }, a.archived ? t("Archived", "subtle") : null]);
    }
    sheets.push({ name: "Chart of accounts", cols: [10, 36, 12, 18, 24, 22, 10, 20, 10], rows, freezeRows: 4 });
  }

  // ── General ledger ──
  {
    const gl = await generalLedger(book, { from: range.from, to: range.to, limit: WORKBOOK_LINE_LIMIT });
    const rows: XCell[][] = [...head("General ledger", period), [t("Date", "header"), t("Number", "header"), t("What", "header"), t("Contact", "header"), t("Note", "header"), t("Debit", "headerRight"), t("Credit", "headerRight"), t("Balance", "headerRight")]];
    for (const a of gl.accounts) {
      rows.push([t(`${a.account.code} · ${a.account.name}`, "section"), ...Array(7).fill(t("", "section"))]);
      rows.push([formatDate(range.from), "", t("Balance carried in", "subtle"), "", "", null, null, m(a.opening, "moneySubtle")]);
      for (const l of a.lines) {
        rows.push([formatDate(l.date), l.number ?? "", l.cancel ? `${l.kind} (cancelled)` : l.kind, l.contactName ?? "", l.note ?? "", l.amount > 0n ? m(l.amount) : null, l.amount < 0n ? m(-l.amount) : null, m(l.running)]);
      }
      rows.push([formatDate(range.to), "", t("Balance at the end", "labelSubtotal"), "", "", m(a.movement > 0n ? a.movement : 0n, "moneySubtotal"), m(a.movement < 0n ? -a.movement : 0n, "moneySubtotal"), m(a.closing, "moneySubtotal")], []);
    }
    if (gl.truncated) notes.push(`The general ledger sheet stops at ${WORKBOOK_LINE_LIMIT.toLocaleString()} lines (end balances are complete). The CSV pack has every line.`);
    sheets.push({ name: "General ledger", cols: [13, 11, 26, 22, 34, 15, 15, 16], rows, freezeRows: 4, landscape: true });
  }

  // ── Journal ──
  {
    const accById = new Map(accounts.map((a) => [a.id, a]));
    const rows: XCell[][] = [...head("Journal", period), [t("Date", "header"), t("Number", "header"), t("What", "header"), t("Code", "header"), t("Account", "header"), t("Debit", "headerRight"), t("Credit", "headerRight"), t("Contact", "header"), t("Note", "header")]];
    let lines = 0;
    let more = false;
    for (let page = 1; ; page++) {
      const j = await journal(book, { from: range.from, to: range.to, page, pageSize: 2000 });
      for (const e of j.entries) {
        if (lines >= WORKBOOK_LINE_LIMIT) {
          more = true;
          break;
        }
        e.lines.forEach((l, i) => {
          const a = accById.get(l.accountId);
          rows.push([i === 0 ? formatDate(e.date) : "", i === 0 ? e.number ?? "" : "", i === 0 ? (e.cancel ? `${e.kind} (cancelled)` : e.kind) : "", a?.code ?? "", a?.name ?? "", l.amount > 0n ? m(l.amount) : null, l.amount < 0n ? m(-l.amount) : null, l.contactName ?? (i === 0 ? e.contactName ?? "" : ""), l.description ?? (i === 0 ? e.memo ?? "" : "")]);
          lines++;
        });
      }
      if (more || page * j.pageSize >= j.count) break;
    }
    if (more) notes.push(`The journal sheet stops at ${WORKBOOK_LINE_LIMIT.toLocaleString()} lines. The CSV pack has every line.`);
    sheets.push({ name: "Journal", cols: [13, 11, 24, 8, 30, 15, 15, 22, 32], rows, freezeRows: 4, landscape: true });
  }

  // ── Tax ──
  {
    const rows: XCell[][] = [...head("Tax summary", period), [t("", "header"), t(book.currency, "headerRight")]];
    for (const a of tax.accounts) {
      rows.push([t(`${a.name} — ${a.side === "owed" ? "tax you owe" : "tax you can claim"}`, "section"), t("", "section")]);
      rows.push([t(`At ${formatDate(range.from)}`, "subtle"), m(a.start, "moneySubtle")]);
      for (const mv of a.movements) rows.push([t(mv.label, "indent"), m(mv.amount)]);
      rows.push([t(`At ${formatDate(range.to)}`, "labelSubtotal"), m(a.end, "moneySubtotal")], []);
    }
    rows.push([t("Tax you owe", "bold"), m(tax.owed)], [t("Tax you can claim back", "bold"), m(tax.claimable)], [t(tax.net >= 0n ? "To pay" : "To get back", "labelTotal"), m(tax.net >= 0n ? tax.net : -tax.net, "moneyTotal")], []);
    if (tax.rates.length) {
      rows.push([t("Rate", "header"), t("Kind", "header"), t("Taxable amount", "headerRight"), t("Tax", "headerRight")]);
      for (const r of tax.rates) rows.push([`${r.name}${r.rateBp != null ? ` (${formatRate(r.rateBp)})` : ""}`, TAX_KIND_LABELS[r.kind].label, m(r.base), m(r.tax)]);
    }
    sheets.push({ name: "Tax summary", cols: [44, 22, 18, 16], rows, freezeRows: 4 });
  }

  // ── What's owed, by age ──
  for (const [name, who, a, notOn] of [
    ["Owed by customers", "Customer", receivables, "Owed but not on an invoice"],
    ["Owed to suppliers", "Supplier", payables, "Owed but not on a bill"],
  ] as const) {
    const rows: XCell[][] = [...head(`${name} by age`, `on ${formatDate(today)}`), [t(who, "header"), ...AGE_BUCKETS.map((b) => t(b, "headerRight")), t("Total", "headerRight")]];
    for (const r of a.rows) rows.push([r.name, ...r.buckets.map((b) => (b ? m(b) : null)), m(r.total)]);
    rows.push([t("Total open", "labelSubtotal"), ...a.totals.map((b) => m(b, "moneySubtotal")), m(a.total, "moneySubtotal")]);
    if (a.notFromBills !== 0n) rows.push([t(notOn, "subtle"), ...AGE_BUCKETS.map(() => null), m(a.notFromBills, "moneySubtle")]);
    rows.push([t("Total", "labelTotal"), ...AGE_BUCKETS.map(() => null), m(a.payables, "moneyTotal")]);
    sheets.push({ name, cols: [30, ...AGE_BUCKETS.map(() => 16), 16], rows, freezeRows: 4, landscape: true });
  }

  // ── Summary first ──
  {
    const r = pl.pl!;
    const tiles = homeTiles(accounts, endBalances);
    const rows: XCell[][] = [
      ...head("Books", period),
      [t("Profit and loss", "section"), t("", "section")],
      [t("Sales (after discounts and returns)"), m(r.sales.total)],
      [t("Cost of sales"), m(r.costOfSales.total)],
      [t("Gross profit", "labelSubtotal"), m(r.grossProfit, "moneySubtotal")],
      [t("Running costs"), m(r.expenses.total)],
      [t(r.netProfit < 0n ? "Loss" : "Profit", "labelTotal"), m(r.netProfit, "moneyTotal")],
      [],
      [t(`On ${formatDate(range.to)}`, "section"), t("", "section")],
      [t("Money in your accounts"), m(tiles.money)],
      [t("Owed to you"), m(tiles.owedToYou)],
      [t("Stock at cost"), m(tiles.stock)],
      [t("You owe"), m(tiles.youOwe)],
      [],
      [t(`Made on ${formatDate(today)}. ${book.lockedThrough ? `Closed through ${formatDate(book.lockedThrough)}.` : "No period is closed."}`, "note")],
      ...notes.map((x) => [t(x, "note")]),
    ];
    sheets.unshift({ name: "Summary", cols: [44, 18], rows, merges: ["A1:B1", "A2:B2"] });
  }

  const slug = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "books";
  return { filename: `${slug}-books-${range.from}-${range.to}`, body: await buildXlsx(sheets, { title: `Books — ${period}`, creator: "Growzar Books", decimals: book.decimals }) };
}
