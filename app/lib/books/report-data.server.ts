/**
 * Build a report from URL parameters, and its CSV. Shared by the report
 * screens and the CSV resource route so the file always matches what's on
 * screen.
 */

import { balanceSheetInputs, foreignBalances, ledgerSums, listTags, reportAccounts, type BookView } from "./books.server";
import { addMonths, compareColumns, monthStart, resolveRange, type DateRange } from "./dates";
import { GL_FILE_LIMIT, agedPayables, agedReceivables, generalLedger, journal, spendingBySupplier } from "./ledger-views.server";
import { currencyDecimals, formatAmount } from "./money";
import { addDays, isIsoDate } from "./posting";
import { TAX_KIND_LABELS, formatRate } from "./tax";
import { taxSummary } from "./taxes.server";
import { CASH_ACCOUNTS, cashSums } from "./cash-basis.server";
import { AGE_BUCKETS, balanceSheet, balanceSheetColumns, type BalanceSheetColumns, cashFlow, profitAndLoss, profitAndLossColumns, trialBalance, type ColumnSection, type ReportSection } from "./reports";

export { EXPORT_TITLES, REPORT_TITLES } from "./reports";

export function rangeFrom(book: BookView, today: string, params: URLSearchParams): DateRange {
  return resolveRange({ range: params.get("range"), from: params.get("from"), to: params.get("to") }, today, book.fiscalYearStartMonth);
}

export async function buildReport(book: BookView, today: string, report: string, params: URLSearchParams) {
  if (report === "profit-and-loss") {
    const range = rangeFrom(book, today, params);
    const compare = params.get("compare") ?? "";
    const tagParam = params.get("tag");
    // "__none" = entries with no tag.
    const tag = tagParam === null || tagParam === "" ? undefined : tagParam === "__none" ? "" : tagParam;
    // Accrual (when it happens) or cash (when money moves): the same views on either.
    const basis = params.get("basis") === "cash" ? "cash" : "accrual";
    const sums = basis === "cash" ? cashSums : ledgerSums;
    const [bookAccounts, tags] = await Promise.all([reportAccounts(book), listTags(book)]);
    const accounts = basis === "cash" ? [...bookAccounts, ...CASH_ACCOUNTS] : bookAccounts;
    const base = { report, range, basis, compare: compare === "tags" && tags.length === 0 ? "" : compare, tag: tagParam ?? "", tags: tags.map((t) => t.tag), bs: null, tb: null, asOf: null as string | null, tooMany: false, bsCols: null as BalanceSheetColumns | null, bsDates: null as string[] | null };
    // "By tag" needs tags; without any it's the plain report.
    if (compare === "tags" && tags.length > 0) {
      const top = tags.slice(0, 8).map((t) => t.tag);
      const columns = [...top.map((t) => ({ label: t, from: range.from, to: range.to })), { label: "No tag", from: range.from, to: range.to }];
      const moves = await Promise.all([...top.map((t) => sums(book.id, { from: range.from, to: range.to, tag: t })), sums(book.id, { from: range.from, to: range.to, tag: "" })]);
      return { ...base, columns, cols: profitAndLossColumns(accounts, moves), pl: null };
    }
    if (compare) {
      const columns = compareColumns(range.from, range.to, compare);
      if (columns && columns.length > 1) {
        const moves = await Promise.all(columns.map((c) => sums(book.id, { from: c.from, to: c.to, tag })));
        return { ...base, columns, cols: profitAndLossColumns(accounts, moves), pl: null };
      }
      if (!columns) {
        // Too many months: show the plain report and say why.
        const moves = await sums(book.id, { from: range.from, to: range.to, tag });
        return { ...base, columns: null, cols: null, pl: profitAndLoss(accounts, moves), tooMany: true };
      }
    }
    const moves = await sums(book.id, { from: range.from, to: range.to, tag });
    return { ...base, columns: null, cols: null, pl: profitAndLoss(accounts, moves) };
  }
  const asOfParam = params.get("date");
  const asOf = isIsoDate(asOfParam) ? asOfParam : today;
  const none = { range: null, basis: "accrual", compare: "", columns: null, cols: null, pl: null, tooMany: false, tag: "", tags: [] as string[], bsCols: null as BalanceSheetColumns | null, bsDates: null as string[] | null };
  if (report === "balance-sheet") {
    const inputs = await balanceSheetInputs(book, asOf);
    const bs = balanceSheet(inputs.accounts, inputs.balances, inputs.pnlBeforeYear);
    const bsCompare = params.get("compare") ?? "";
    // Against the end of the month before, or the same day a year earlier.
    const other = bsCompare === "previous_month" ? addDays(monthStart(asOf), -1) : bsCompare === "previous_year" ? addMonths(asOf, -12) : null;
    if (other) {
      const prev = await balanceSheetInputs(book, other);
      const cols = balanceSheetColumns([bs, balanceSheet(prev.accounts, prev.balances, prev.pnlBeforeYear)]);
      return { ...none, report, bs, bsCols: cols, bsDates: [asOf, other], compare: bsCompare, tb: null, asOf };
    }
    return { ...none, report, bs, compare: "", tb: null, asOf };
  }
  const [accounts, balances] = await Promise.all([reportAccounts(book), ledgerSums(book.id, { to: asOf })]);
  return { ...none, report, bs: null, tb: trialBalance(accounts, balances), asOf };
}

export async function buildCashFlow(book: BookView, today: string, params: URLSearchParams) {
  const range = rangeFrom(book, today, params);
  const [accounts, moves, opening] = await Promise.all([reportAccounts(book), ledgerSums(book.id, { from: range.from, to: range.to }), ledgerSums(book.id, { to: addDays(range.from, -1) })]);
  return { range, cf: cashFlow(accounts, moves, opening) };
}

/**
 * A CSV cell. Text a spreadsheet would run as a formula (=, +, -, @ at the
 * start; account and contact names are typed by people) is prefixed with a
 * quote so it shows as text. Plain numbers are left alone.
 */
export function csvCell(v: string): string {
  let out = v;
  if (/^[=+\-@\t\r]/.test(out) && !/^-?\d+(\.\d+)?$/.test(out)) out = `'${out}`;
  return /[",\n\r]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
}

function csvBody(rows: string[][]): string {
  // BOM so Excel opens UTF-8 names correctly.
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function amounts(book: BookView) {
  return (v: bigint) => formatAmount(v, book.decimals, { trimZeroFraction: false }).replace(/,/g, "").replace("−", "-");
}

export function reportCsv(book: BookView, r: Awaited<ReturnType<typeof buildReport>>): { filename: string; body: string } {
  const amt = amounts(book);
  const rows: string[][] = [];
  const sec = (s: ReportSection) => {
    rows.push([s.label, "", ""]);
    s.rows.forEach((x) => rows.push([x.depth ? "" : x.code, x.depth ? `  ${x.name}` : x.name, amt(x.amount)]));
    rows.push(["", `Total ${s.label.toLowerCase()}`, amt(s.total)]);
  };
  let filename: string;
  if (r.cols && r.columns && r.range) {
    const n = r.columns.length;
    rows.push([r.basis === "cash" ? "Profit and loss (cash basis)" : "Profit and loss", "", ...r.columns.map((c) => `${c.from} to ${c.to}`)]);
    const csec = (s: ColumnSection) => {
      rows.push([s.label, "", ...Array(n).fill("")]);
      s.rows.forEach((x) => rows.push([x.depth ? "" : x.code, x.depth ? `  ${x.name}` : x.name, ...x.amounts.map(amt)]));
      rows.push(["", `Total ${s.label.toLowerCase()}`, ...s.totals.map(amt)]);
    };
    csec(r.cols.sales);
    csec(r.cols.costOfSales);
    rows.push(["", "Gross profit", ...r.cols.grossProfit.map(amt)]);
    csec(r.cols.otherIncome);
    csec(r.cols.expenses);
    rows.push(["", "Net profit", ...r.cols.netProfit.map(amt)]);
    filename = `profit-and-loss-${r.basis === "cash" ? "cash-" : ""}${r.range.from}-${r.range.to}-${r.compare}${r.tag ? `-${r.tag === "__none" ? "untagged" : r.tag.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}`;
  } else if (r.pl && r.range) {
    rows.push([r.basis === "cash" ? "Profit and loss (cash basis)" : "Profit and loss", `${r.range.from} to ${r.range.to}`, book.currency]);
    if (r.tag) rows.push(["Tag", r.tag === "__none" ? "No tag" : r.tag, ""]);
    sec(r.pl.sales);
    sec(r.pl.costOfSales);
    rows.push(["", "Gross profit", amt(r.pl.grossProfit)]);
    sec(r.pl.otherIncome);
    sec(r.pl.expenses);
    rows.push(["", "Net profit", amt(r.pl.netProfit)]);
    filename = `profit-and-loss-${r.basis === "cash" ? "cash-" : ""}${r.range.from}-${r.range.to}${r.tag ? `-${r.tag === "__none" ? "untagged" : r.tag.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}`;
  } else if (r.bsCols && r.bsDates) {
    rows.push(["Balance sheet", "", ...r.bsDates]);
    for (const s of [r.bsCols.assets, r.bsCols.liabilities, r.bsCols.equity]) {
      rows.push([s.label, "", ...r.bsDates.map(() => "")]);
      s.rows.forEach((x) => rows.push([x.depth ? "" : x.code, x.depth ? `  ${x.name}` : x.name, ...x.amounts.map(amt)]));
      rows.push(["", `Total ${s.label.toLowerCase()}`, ...s.totals.map(amt)]);
    }
    filename = `balance-sheet-${r.bsDates.join("-vs-")}`;
  } else if (r.bs) {
    rows.push(["Balance sheet", r.asOf!, book.currency]);
    for (const s of [r.bs.assets, r.bs.liabilities, r.bs.equity]) sec(s);
    filename = `balance-sheet-${r.asOf}`;
  } else {
    const tb = r.tb!;
    rows.push(["Code", "Account", "Debit", "Credit"]);
    tb.rows.forEach((x) => rows.push([x.code, x.name, x.debit ? amt(x.debit) : "", x.credit ? amt(x.credit) : ""]));
    rows.push(["", "Total", amt(tb.totalDebit), amt(tb.totalCredit)]);
    filename = `trial-balance-${r.asOf}`;
  }
  return { filename, body: csvBody(rows) };
}

/** The CSV for any report in EXPORT_TITLES. */
export async function reportFile(book: BookView, today: string, report: string, params: URLSearchParams): Promise<{ filename: string; body: string }> {
  const amt = amounts(book);
  const dc = (v: bigint) => (v > 0n ? [amt(v), ""] : v < 0n ? ["", amt(-v)] : ["", ""]);
  const rows: string[][] = [];

  if (report === "cash-flow") {
    const { range, cf } = await buildCashFlow(book, today, params);
    rows.push(["Cash flow", `${range.from} to ${range.to}`, book.currency]);
    rows.push(["", "Money at the start", amt(cf.opening)]);
    for (const s of [cf.operating, cf.financing]) {
      rows.push([s.label, "", ""]);
      s.rows.forEach((x) => rows.push([x.code, x.name, amt(x.amount)]));
      rows.push(["", `Total ${s.label.toLowerCase()}`, amt(s.total)]);
    }
    rows.push(["", "Change in money", amt(cf.netChange)], ["", "Money at the end", amt(cf.closing)]);
    return { filename: `cash-flow-${range.from}-${range.to}`, body: csvBody(rows) };
  }

  if (report === "general-ledger") {
    const range = rangeFrom(book, today, params);
    const gl = await generalLedger(book, { from: range.from, to: range.to, accountId: params.get("account") || null, limit: GL_FILE_LIMIT });
    rows.push(["Code", "Account", "Date", "Number", "Kind", "Contact", "Note", "Debit", "Credit", "Balance"]);
    for (const a of gl.accounts) {
      rows.push([a.account.code, a.account.name, range.from, "", "Balance carried in", "", "", "", "", amt(a.opening)]);
      for (const l of a.lines) rows.push([a.account.code, a.account.name, l.date, l.number ?? "", l.cancel ? `${l.kind} (cancelled)` : l.kind, l.contactName ?? "", l.note ?? "", ...dc(l.amount), amt(l.running)]);
      rows.push([a.account.code, a.account.name, range.to, "", "Balance at the end", "", "", "", "", amt(a.closing)]);
    }
    if (gl.truncated) rows.push(["", `Cut short at ${gl.limit} lines. Download one account or a shorter period.`]);
    return { filename: `general-ledger-${range.from}-${range.to}`, body: csvBody(rows) };
  }

  if (report === "journal") {
    const range = rangeFrom(book, today, params);
    const accounts = new Map((await reportAccounts(book)).map((a) => [a.id, a]));
    rows.push(["Date", "Number", "Kind", "Code", "Account", "Debit", "Credit", "Contact", "Note"]);
    let lines = 0;
    for (let page = 1; lines < GL_FILE_LIMIT; page++) {
      const j = await journal(book, { from: range.from, to: range.to, page, pageSize: 2000 });
      for (const e of j.entries) {
        for (const l of e.lines) {
          const a = accounts.get(l.accountId);
          rows.push([e.date, e.number ?? "", e.cancel ? `${e.kind} (cancelled)` : e.kind, a?.code ?? "", a?.name ?? "", ...dc(l.amount), l.contactName ?? e.contactName ?? "", l.description ?? e.memo ?? ""]);
          lines++;
        }
      }
      if (page * j.pageSize >= j.count) break;
    }
    return { filename: `journal-${range.from}-${range.to}`, body: csvBody(rows) };
  }

  if (report === "aged-payables") {
    const a = await agedPayables(book, today);
    rows.push(["Supplier", ...AGE_BUCKETS, "Total"]);
    for (const r of a.rows) rows.push([r.name, ...r.buckets.map(amt), amt(r.total)]);
    rows.push(["Total open bills", ...a.totals.map(amt), amt(a.total)]);
    if (a.notFromBills !== 0n) rows.push(["Owed but not on a bill", ...AGE_BUCKETS.map(() => ""), amt(a.notFromBills)]);
    rows.push(["Total you owe suppliers", ...AGE_BUCKETS.map(() => ""), amt(a.payables)]);
    return { filename: `owed-to-suppliers-${today}`, body: csvBody(rows) };
  }

  if (report === "aged-receivables") {
    const a = await agedReceivables(book, today);
    rows.push(["Customer", ...AGE_BUCKETS, "Total"]);
    for (const r of a.rows) rows.push([r.name, ...r.buckets.map(amt), amt(r.total)]);
    rows.push(["Total open invoices", ...a.totals.map(amt), amt(a.total)]);
    if (a.notFromBills !== 0n) rows.push(["Owed but not on an invoice", ...AGE_BUCKETS.map(() => ""), amt(a.notFromBills)]);
    rows.push(["Total owed by customers", ...AGE_BUCKETS.map(() => ""), amt(a.payables)]);
    return { filename: `owed-by-customers-${today}`, body: csvBody(rows) };
  }

  if (report === "spending-by-supplier") {
    const range = rangeFrom(book, today, params);
    const s = await spendingBySupplier(book, range);
    rows.push(["Supplier", "Account", "Amount"]);
    for (const r of s.rows) {
      for (const x of r.accounts) rows.push([r.name, x.name, amt(x.amount)]);
      rows.push([r.name, "Total", amt(r.total)]);
    }
    rows.push(["Everyone", "Total", amt(s.total)]);
    return { filename: `spending-by-supplier-${range.from}-${range.to}`, body: csvBody(rows) };
  }

  if (report === "tax-summary") {
    const range = rangeFrom(book, today, params);
    const t = await taxSummary(book, range.from, range.to);
    rows.push(["Tax summary", `${range.from} to ${range.to}`, book.currency]);
    for (const a of t.accounts) {
      rows.push([a.name, a.side === "owed" ? "Tax you owe" : "Tax you can claim", ""]);
      rows.push(["", `At ${range.from}`, amt(a.start)]);
      for (const m of a.movements) rows.push(["", m.label, amt(m.amount)]);
      rows.push(["", `At ${range.to}`, amt(a.end)]);
    }
    rows.push(["", "Tax you owe", amt(t.owed)], ["", "Tax you can claim back", amt(t.claimable)], ["", "Net to pay (negative: to get back)", amt(t.net)]);
    if (t.rates.length) {
      rows.push([], ["Rate", "Kind", "Taxable amount", "Tax"]);
      for (const r of t.rates) rows.push([`${r.name}${r.rateBp != null ? ` (${formatRate(r.rateBp)})` : ""}`, TAX_KIND_LABELS[r.kind].label, amt(r.base), amt(r.tax)]);
    }
    return { filename: `tax-summary-${range.from}-${range.to}`, body: csvBody(rows) };
  }

  return reportCsv(book, await buildReport(book, today, report, params));
}

/**
 * Everything an accountant asks for at year end (or month end), as one ZIP
 * of CSVs: statements for the period, the ledger and journal, tax, what's
 * owed both ways, and the chart of accounts.
 */
export async function accountantPack(book: BookView, today: string, params: URLSearchParams, organizationName = "your business"): Promise<{ filename: string; body: Buffer }> {
  const range = rangeFrom(book, today, params);
  const period = new URLSearchParams({ range: "custom", from: range.from, to: range.to });
  const asOf = new URLSearchParams({ date: range.to });
  const parts: Array<[string, string, URLSearchParams]> = [
    ["01 Profit and loss", "profit-and-loss", period],
    ["02 Profit and loss by month", "profit-and-loss", new URLSearchParams({ ...Object.fromEntries(period), compare: "months" })],
    ["03 Balance sheet", "balance-sheet", asOf],
    ["04 Trial balance", "trial-balance", asOf],
    ["05 Cash flow", "cash-flow", period],
    ["06 General ledger", "general-ledger", period],
    ["07 Journal", "journal", period],
    ["08 Tax summary", "tax-summary", period],
    ["09 Owed to suppliers by age", "aged-payables", period],
    ["10 Owed by customers by age", "aged-receivables", period],
  ];
  const files: Array<{ name: string; data: string }> = [];
  for (const [name, report, p] of parts) files.push({ name: `${name}.csv`, data: (await reportFile(book, today, report, p)).body });

  // Chart of accounts with each account's balance at the period end.
  const [accounts, balances] = await Promise.all([reportAccounts(book), ledgerSums(book.id, { to: range.to })]);
  const amt = amounts(book);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const fxEnd = await foreignBalances(book.id, accounts.filter((a) => a.currency).map((a) => a.id), range.to);
  const chart: string[][] = [["Code", "Account", "Type", "Kind", "Part of", "Archived", `Balance on ${range.to} in ${book.currency} (debit +, credit −)`, "Currency", "Balance in its currency"]];
  for (const a of [...accounts].sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))) {
    const fxv = a.currency ? formatAmount(fxEnd.get(a.id) ?? 0n, currencyDecimals(a.currency), { trimZeroFraction: false }).replace(/,/g, "").replace("−", "-") : "";
    chart.push([a.code, a.name, a.type, a.subtype, a.parentId ? byId.get(a.parentId)?.name ?? "" : "", a.archived ? "yes" : "", amt(balances.get(a.id) ?? 0n), a.currency ?? "", fxv]);
  }
  files.push({ name: "11 Chart of accounts.csv", data: csvBody(chart) });
  files.push({ name: "12 Profit and loss (cash basis).csv", data: (await reportFile(book, today, "profit-and-loss", new URLSearchParams({ ...Object.fromEntries(period), basis: "cash" }))).body });
  files.push({
    name: "README.txt",
    data: [
      `Books — accountant pack for ${organizationName}`,
      `Period: ${range.from} to ${range.to}. Balances are on ${range.to}. Currency: ${book.currency}.`,
      `Made on ${today}. Ages of what's owed are as of ${today}.`,
      book.lockedThrough ? `The books are closed through ${book.lockedThrough}.` : "No period is closed yet.",
      "",
      "Every file is a CSV (UTF-8) that opens in Excel or Google Sheets.",
      "Amounts use a dot for decimals and no thousands separator. In the general ledger,",
      "journal and chart of accounts, debits are positive and credits negative (or in their own columns).",
      "Cancelled entries appear with their reversal, so they net to zero.",
      "File 12 is the profit and loss on cash basis: sales when the money arrived, costs when paid,",
      "stock when paid for. Everything else is on accrual basis (when it happened).",
    ].join("\r\n"),
  });
  const { zip } = await import("./zip.server");
  return { filename: `books-${range.from}-${range.to}`, body: zip(files) };
}
