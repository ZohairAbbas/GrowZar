import { z } from "zod";

import { getBook, ledgerSums, reportAccounts, type BookView } from "../../books/books.server";
import { naturalBalance, TYPE_LABELS, type AccountType } from "../../books/chart";
import { formatDate, todayIn } from "../../books/dates";
import { isIsoDate } from "../../books/posting";
import { buildCashFlow, buildReport } from "../../books/report-data.server";
import type { ReportSection } from "../../books/reports";
import { maskSensitive } from "../../books/statement-csv";
import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { refusal } from "./common.server";

/**
 * Books' tools for Ask (B7, D-73): account balances and report lines, and
 * nothing else. Never an entry, a memo, a contact, a bank statement line or
 * its words: what reaches the model is what the Reports tab's totals show.
 * Account names are the merchant's own words, so they pass the statement
 * masking (an account number typed into a name shows its last four digits).
 *
 * Offered only where the viewer can open Books (books:view, every store in
 * scope, Books on for the organization; `ctx.booksTools`). Books is the
 * whole organization's, never one store's.
 */

const booksGate = (ctx: AskContext) => !!ctx.booksTools;
const minorToMajor = (book: BookView, v: bigint) => Number(v) / 10 ** book.decimals;
const NO_BOOK = "Books isn't set up for this organization yet.";

const dateArg = z.string().nullable().describe("A day, YYYY-MM-DD. Null for today.");

function asOf(book: BookView, date: string | null, now: Date): string | { error: string } {
  const today = todayIn(book.settings.timeZone, now);
  if (date === null) return today;
  if (!isIsoDate(date) || date > today) return { error: "The date must be a real day (YYYY-MM-DD), today or earlier." };
  return date;
}

const baseMeta = (book: BookView, notes: string[] = []) => ({
  stores: [],
  currency: book.currency,
  rules: [
    "These are the organization's books (double entry, every store together), not Finance: sales count as the books are set (cash on delivery at delivery by default), returns and changes on the day they're seen, and a day already in the books never changes.",
    "Books gives Ask balances and report lines only, never entries, memos, contacts or bank statement lines.",
  ],
  gaps: [],
  notes,
});

// ── books_balances ───────────────────────────────────────────────────────────

const balancesSchema = z.object({ date: dateArg }).strict();

async function runBalances(args: z.infer<typeof balancesSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "books_balances";
  const book = await getBook(ctx.organizationId);
  if (!book) return refusal(name, "no_data", NO_BOOK);
  const day = asOf(book, args.date, ctx.now);
  if (typeof day !== "string") return refusal(name, "invalid", day.error);
  const [accounts, sums] = await Promise.all([reportAccounts(book), ledgerSums(book.id, { to: day })]);
  const rows: Array<Record<string, Cell>> = accounts
    .filter((a) => (sums.get(a.id) ?? 0n) !== 0n)
    .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))
    .map((a) => ({
      account: maskSensitive(a.name),
      group: TYPE_LABELS[a.type as AccountType]?.owner ?? a.type,
      balance: minorToMajor(book, naturalBalance(a.type, sums.get(a.id) ?? 0n)),
    }));
  const columns: Column[] = [
    { key: "account", label: "Account", kind: "text" },
    { key: "group", label: "Group", kind: "text" },
    { key: "balance", label: "Balance", kind: "money", currency: book.currency },
  ];
  return {
    tool: name,
    status: rows.length ? "ok" : "no_data",
    title: `Every account's balance in the books on ${formatDate(day)}`,
    columns,
    rows,
    meta: baseMeta(book, ["Balances read as an owner reads them: money in the bank positive, what you owe positive under \"What you owe\".", ...(rows.length ? [] : ["Nothing is in the books on that day yet"])]),
    link: { href: `/books/reports/balance-sheet?date=${day}`, label: "Open the balance sheet", exact: false },
  };
}

export const booksBalances: AskTool<typeof balancesSchema> = {
  name: "books_balances",
  description: "The organization's books: every account's balance on a day (bank and cash, what couriers owe, stock, what's owed to suppliers, tax to pay, owner's money, and the year's income and costs). For 'how much is in my bank according to my books' or 'what do I owe suppliers'.",
  schema: balancesSchema,
  sections: () => ["books"],
  gate: booksGate,
  run: runBalances,
};

// ── books_report ─────────────────────────────────────────────────────────────

const reportSchema = z
  .object({
    report: z.enum(["profit_and_loss", "balance_sheet", "cash_flow"]).describe("profit_and_loss and cash_flow cover from–to; balance_sheet is on `to`."),
    from: z.string().nullable().describe("First day, YYYY-MM-DD. Null for the start of this month. Ignored for balance_sheet."),
    to: z.string().nullable().describe("Last day (or the balance sheet's day), YYYY-MM-DD. Null for today."),
    basis: z.enum(["accrual", "cash"]).nullable().describe("Profit and loss only: accrual (when it happens, the default) or cash (when money moves)."),
  })
  .strict();

async function runReport(args: z.infer<typeof reportSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "books_report";
  const book = await getBook(ctx.organizationId);
  if (!book) return refusal(name, "no_data", NO_BOOK);
  const to = asOf(book, args.to, ctx.now);
  if (typeof to !== "string") return refusal(name, "invalid", to.error);
  const from = args.from ?? `${to.slice(0, 8)}01`;
  if (args.report !== "balance_sheet" && (!isIsoDate(from) || from > to)) return refusal(name, "invalid", "`from` must be a real day on or before `to`.");
  const today = todayIn(book.settings.timeZone, ctx.now);
  const m = (v: bigint) => minorToMajor(book, v);
  const rows: Array<Record<string, Cell>> = [];
  const section = (s: ReportSection) => {
    for (const r of s.rows) rows.push({ section: s.label, line: r.depth ? `  ${maskSensitive(r.name)}` : maskSensitive(r.name), amount: m(r.amount) });
    rows.push({ section: s.label, line: `Total ${s.label.toLowerCase()}`, amount: m(s.total) });
  };
  const total = (line: string, v: bigint) => rows.push({ section: null, line, amount: m(v) });
  let title: string;
  let link: string;
  if (args.report === "profit_and_loss") {
    const r = await buildReport(book, today, "profit-and-loss", new URLSearchParams({ range: "custom", from, to, ...(args.basis === "cash" ? { basis: "cash" } : {}) }));
    const pl = r.pl!;
    section(pl.sales);
    section(pl.costOfSales);
    total("Gross profit", pl.grossProfit);
    if (pl.otherIncome.rows.length) section(pl.otherIncome);
    section(pl.expenses);
    total(pl.netProfit < 0n ? "Loss" : "Profit", pl.netProfit);
    title = `Profit and loss${args.basis === "cash" ? " (cash basis)" : ""}, ${formatDate(from)} to ${formatDate(to)}`;
    link = `/books/reports/profit-and-loss?range=custom&from=${from}&to=${to}${args.basis === "cash" ? "&basis=cash" : ""}`;
  } else if (args.report === "balance_sheet") {
    const r = await buildReport(book, today, "balance-sheet", new URLSearchParams({ date: to }));
    const bs = r.bs!;
    section(bs.assets);
    section(bs.liabilities);
    total("What you have minus what you owe", bs.assets.total - bs.liabilities.total);
    section(bs.equity);
    title = `Balance sheet on ${formatDate(to)}`;
    link = `/books/reports/balance-sheet?date=${to}`;
  } else {
    const { cf } = await buildCashFlow(book, today, new URLSearchParams({ range: "custom", from, to }));
    total("Money at the start", cf.opening);
    section(cf.operating);
    section(cf.financing);
    total("Change in money", cf.netChange);
    total("Money at the end", cf.closing);
    title = `Cash flow, ${formatDate(from)} to ${formatDate(to)}`;
    link = `/books/reports/cash-flow?range=custom&from=${from}&to=${to}`;
  }
  return {
    tool: name,
    status: "ok",
    title,
    columns: [
      { key: "section", label: "Section", kind: "text" },
      { key: "line", label: "Line", kind: "text" },
      { key: "amount", label: "Amount", kind: "money", currency: book.currency },
    ],
    rows,
    meta: {
      ...baseMeta(book, book.lockedThrough ? [`The books are closed through ${formatDate(book.lockedThrough)}`] : ["No month is closed yet, so figures can still change"]),
      period: args.report === "balance_sheet" ? undefined : { from, to, days: Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1 },
    },
    link: { href: link, label: "Open in Books", exact: true },
  };
}

export const booksReport: AskTool<typeof reportSchema> = {
  name: "books_report",
  description: "The organization's books as statements: profit and loss (accrual or cash basis) or cash flow for a period, or the balance sheet on a day, line by line with totals. For 'what was my profit in the books last month' or 'show my balance sheet'. Books' profit differs from Finance's; say which one you are quoting.",
  schema: reportSchema,
  sections: () => ["books"],
  gate: booksGate,
  run: runReport,
};
