/**
 * Books reports, built from account balances. Pure: the service sums entry
 * lines per account (one indexed query) and hands the totals here.
 *
 * Ledger amounts are + debit / − credit. Reports show "natural" amounts: what
 * an owner would expect to read (sales positive, money in the bank positive,
 * a supplier debt positive under "You owe").
 */

import { naturalBalance, type AccountType } from "./chart";

/** The statements shown by the reports.$report screen. */
export const REPORT_TITLES: Record<string, string> = {
  "profit-and-loss": "Profit and loss",
  "balance-sheet": "Balance sheet",
  "trial-balance": "Trial balance",
};

/** Every report that can be downloaded (statements plus the ones with their own screens). */
export const EXPORT_TITLES: Record<string, string> = {
  ...REPORT_TITLES,
  "cash-flow": "Cash flow",
  "general-ledger": "General ledger",
  journal: "Journal",
  "aged-payables": "Owed to suppliers by age",
  "aged-receivables": "Owed by customers by age",
  "spending-by-supplier": "Spending by supplier",
  "stock-items": "Stock items",
  "tax-summary": "Tax summary",
};

export interface ReportAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  systemKey: string | null;
  archived: boolean;
  /** A sub-account's parent (one level). */
  parentId?: string | null;
  /** A foreign-currency money account's currency. */
  currency?: string | null;
}

export interface ReportRow {
  accountId: string;
  code: string;
  name: string;
  amount: bigint;
  /** 1 for a sub-account shown under its parent. */
  depth?: number;
  /** A parent's heading: its amount is the total of the rows under it, and it isn't counted again in the section total. */
  header?: boolean;
}

export interface ReportSection {
  key: string;
  label: string;
  rows: ReportRow[];
  total: bigint;
}

const byCode = (x: { code: string }, y: { code: string }) => x.code.localeCompare(y.code, undefined, { numeric: true });

/**
 * Rows for the accounts a section picks, with sub-accounts under their
 * parent: the parent becomes a heading carrying the total, its sub-accounts
 * follow indented, and anything posted to the parent itself shows as
 * "<parent> (other)". Accounts with nothing to show are left out.
 */
function rowsFor(accounts: ReportAccount[], balances: Map<string, bigint>, pick: (a: ReportAccount) => boolean): ReportRow[] {
  const picked = accounts.filter(pick);
  const ids = new Set(picked.map((a) => a.id));
  const own = (a: ReportAccount) => naturalBalance(a.type, balances.get(a.id) ?? 0n);
  const kidsOf = new Map<string, ReportAccount[]>();
  for (const a of picked) if (a.parentId && ids.has(a.parentId)) kidsOf.set(a.parentId, [...(kidsOf.get(a.parentId) ?? []), a]);
  const rows: ReportRow[] = [];
  for (const a of picked.filter((x) => !(x.parentId && ids.has(x.parentId))).sort(byCode)) {
    const kids = (kidsOf.get(a.id) ?? []).sort(byCode).filter((k) => own(k) !== 0n);
    if (kids.length === 0) {
      if (own(a) !== 0n) rows.push({ accountId: a.id, code: a.code, name: a.name, amount: own(a) });
      continue;
    }
    const total = own(a) + kids.reduce((s, k) => s + own(k), 0n);
    rows.push({ accountId: a.id, code: a.code, name: a.name, amount: total, header: true });
    if (own(a) !== 0n) rows.push({ accountId: a.id, code: a.code, name: `${a.name} (other)`, amount: own(a), depth: 1 });
    for (const k of kids) rows.push({ accountId: k.id, code: k.code, name: k.name, amount: own(k), depth: 1 });
  }
  return rows;
}

function section(key: string, label: string, rows: ReportRow[]): ReportSection {
  return { key, label, rows, total: rows.reduce((s, r) => (r.header ? s : s + r.amount), 0n) };
}

// ── Trial balance ────────────────────────────────────────────────────────────

export interface TrialBalance {
  rows: Array<ReportRow & { type: AccountType; debit: bigint; credit: bigint }>;
  totalDebit: bigint;
  totalCredit: bigint;
}

export function trialBalance(accounts: ReportAccount[], balances: Map<string, bigint>): TrialBalance {
  const rows = accounts
    .map((a) => {
      const b = balances.get(a.id) ?? 0n;
      return { accountId: a.id, code: a.code, name: a.name, type: a.type, amount: b, debit: b > 0n ? b : 0n, credit: b < 0n ? -b : 0n };
    })
    .filter((r) => r.amount !== 0n)
    .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
  return {
    rows,
    totalDebit: rows.reduce((s, r) => s + r.debit, 0n),
    totalCredit: rows.reduce((s, r) => s + r.credit, 0n),
  };
}

// ── Profit and loss ──────────────────────────────────────────────────────────

export interface ProfitAndLoss {
  sales: ReportSection;
  costOfSales: ReportSection;
  grossProfit: bigint;
  otherIncome: ReportSection;
  expenses: ReportSection;
  netProfit: bigint;
}

/** `movements` = ledger movement per account inside the period. */
export function profitAndLoss(accounts: ReportAccount[], movements: Map<string, bigint>): ProfitAndLoss {
  const sales = section("sales", "Sales", rowsFor(accounts, movements, (a) => a.type === "income" && a.subtype === "sales"));
  const otherIncome = section("other_income", "Other income", rowsFor(accounts, movements, (a) => a.type === "income" && a.subtype !== "sales"));
  const costOfSales = section("cost_of_sales", "Cost of sales", rowsFor(accounts, movements, (a) => a.type === "expense" && a.subtype === "cost_of_sales"));
  const expenses = section("expenses", "Running costs", rowsFor(accounts, movements, (a) => a.type === "expense" && a.subtype !== "cost_of_sales"));
  const grossProfit = sales.total - costOfSales.total;
  return { sales, costOfSales, grossProfit, otherIncome, expenses, netProfit: grossProfit + otherIncome.total - expenses.total };
}

// ── Balance sheet ────────────────────────────────────────────────────────────

export interface BalanceSheet {
  assets: ReportSection;
  liabilities: ReportSection;
  equity: ReportSection;
  /** assets − (liabilities + equity); always 0 for a sound ledger. */
  difference: bigint;
}

/**
 * Profit is not closed into retained earnings with entries; it is calculated.
 * Profit up to the end of the previous fiscal year joins the Retained earnings
 * row, and this year's profit shows as its own line.
 *
 * `balancesAsOf` = ledger balance per account at the report date.
 * `pnlBeforeYear` = ledger balance per income/expense account the day before the fiscal year began.
 */
export function balanceSheet(
  accounts: ReportAccount[],
  balancesAsOf: Map<string, bigint>,
  pnlBeforeYear: Map<string, bigint>,
): BalanceSheet {
  const assets = section("assets", "What you have", rowsFor(accounts, balancesAsOf, (a) => a.type === "asset"));
  const liabilities = section("liabilities", "What you owe", rowsFor(accounts, balancesAsOf, (a) => a.type === "liability"));

  const isPnl = (a: ReportAccount) => a.type === "income" || a.type === "expense";
  const profitOf = (m: Map<string, bigint>) => -accounts.filter(isPnl).reduce((s, a) => s + (m.get(a.id) ?? 0n), 0n);
  const profitToDate = profitOf(balancesAsOf);
  const priorProfit = profitOf(pnlBeforeYear);
  const thisYear = profitToDate - priorProfit;

  const equityRows = rowsFor(accounts, balancesAsOf, (a) => a.type === "equity" && a.systemKey !== "retained_earnings");
  const retainedAcc = accounts.find((a) => a.systemKey === "retained_earnings");
  const retained = (retainedAcc ? naturalBalance("equity", balancesAsOf.get(retainedAcc.id) ?? 0n) : 0n) + priorProfit;
  if (retained !== 0n && retainedAcc) {
    equityRows.push({ accountId: retainedAcc.id, code: retainedAcc.code, name: retainedAcc.name, amount: retained });
  }
  if (thisYear !== 0n) equityRows.push({ accountId: "", code: "", name: "Profit this year", amount: thisYear });
  const equity = section("equity", "Owner's money", equityRows);

  return { assets, liabilities, equity, difference: assets.total - liabilities.total - equity.total };
}

// ── Home tiles ───────────────────────────────────────────────────────────────

export interface HomeTiles {
  money: bigint;
  owedToYou: bigint;
  youOwe: bigint;
  stock: bigint;
}

const MONEY_ASSETS = new Set(["bank", "cash", "mobile_wallet", "ad_wallet"]);

export function homeTiles(accounts: ReportAccount[], balances: Map<string, bigint>): HomeTiles {
  let money = 0n, owedToYou = 0n, youOwe = 0n, stock = 0n;
  for (const a of accounts) {
    const n = naturalBalance(a.type, balances.get(a.id) ?? 0n);
    if (a.type === "asset" && MONEY_ASSETS.has(a.subtype)) money += n;
    else if (a.type === "asset" && a.subtype === "receivable") owedToYou += n;
    else if (a.type === "asset" && a.subtype === "stock") stock += n;
    else if (a.type === "liability") youOwe += n;
  }
  return { money, owedToYou, youOwe, stock };
}

// ── Profit and loss in columns (months, or this period against another) ──────

export interface ColumnRow {
  accountId: string;
  code: string;
  name: string;
  amounts: bigint[];
  depth?: number;
  header?: boolean;
}

export interface ColumnSection {
  key: string;
  label: string;
  rows: ColumnRow[];
  totals: bigint[];
}

export interface ProfitAndLossColumns {
  sales: ColumnSection;
  costOfSales: ColumnSection;
  grossProfit: bigint[];
  otherIncome: ColumnSection;
  expenses: ColumnSection;
  netProfit: bigint[];
}

/** One P&L per column, merged so each account is one row with an amount per column. */
export function profitAndLossColumns(accounts: ReportAccount[], movementsPerColumn: Array<Map<string, bigint>>): ProfitAndLossColumns {
  const pls = movementsPerColumn.map((m) => profitAndLoss(accounts, m));
  const merge = (pick: (p: ProfitAndLoss) => ReportSection): ColumnSection => {
    const first = pick(profitAndLoss(accounts, new Map()));
    // Every column's movements together decide which rows (and headings) appear,
    // so the same layout holds across columns.
    const all = new Map<string, bigint>();
    for (const m of movementsPerColumn) for (const [k, v] of m) all.set(k, (all.get(k) ?? 0n) + (v === 0n ? 0n : 1n));
    const layout = pick(profitAndLoss(accounts, all)).rows;
    const key = (r: ReportRow) => `${r.accountId}|${r.header ? "h" : ""}|${r.name}`;
    const rows: ColumnRow[] = layout.map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, depth: r.depth, header: r.header, amounts: pls.map(() => 0n) }));
    const at = new Map(rows.map((r, i) => [key({ ...r, amount: 0n }), i]));
    pls.forEach((p, i) => {
      for (const r of pick(p).rows) {
        const idx = at.get(key(r));
        if (idx !== undefined) rows[idx]!.amounts[i] = r.amount;
      }
    });
    // A heading's amount in each column is the sum of the rows under it.
    rows.forEach((r, idx) => {
      if (!r.header) return;
      r.amounts = r.amounts.map((_, i) => {
        let s = 0n;
        for (let j = idx + 1; j < rows.length && rows[j]!.depth === 1; j++) s += rows[j]!.amounts[i]!;
        return s;
      });
    });
    return { key: first.key, label: first.label, rows, totals: pls.map((p) => pick(p).total) };
  };
  return {
    sales: merge((p) => p.sales),
    costOfSales: merge((p) => p.costOfSales),
    grossProfit: pls.map((p) => p.grossProfit),
    otherIncome: merge((p) => p.otherIncome),
    expenses: merge((p) => p.expenses),
    netProfit: pls.map((p) => p.netProfit),
  };
}

// ── Cash flow ────────────────────────────────────────────────────────────────

/** Accounts that are money in hand for the cash flow (credit cards are a debt, shown under running the business). */
export function isCashAccount(a: Pick<ReportAccount, "type" | "subtype">): boolean {
  return a.type === "asset" && MONEY_ASSETS.has(a.subtype);
}

export interface CashFlow {
  /** Money in hand the day before the period. */
  opening: bigint;
  /** Profit, then what tied money up or freed it (more owed to you, more stock, more owed to suppliers…). */
  operating: ReportSection;
  /** Owner's money in and out, loans, opening balances entered. */
  financing: ReportSection;
  netChange: bigint;
  closing: bigint;
  /** opening + netChange − closing; always 0 for a sound ledger. */
  difference: bigint;
}

/**
 * Cash flow by the indirect method, from ledger balances: every account that
 * isn't money or profit/loss explains part of the change in money. Because
 * the ledger balances, the sections always add up to the change in money.
 *
 * `movements` = ledger movement per account inside the period;
 * `openingBalances` = ledger balance per account the day before it starts.
 */
export function cashFlow(accounts: ReportAccount[], movements: Map<string, bigint>, openingBalances: Map<string, bigint>): CashFlow {
  const sum = (m: Map<string, bigint>, pick: (a: ReportAccount) => boolean) => accounts.filter(pick).reduce((s, a) => s + (m.get(a.id) ?? 0n), 0n);
  const isPnl = (a: ReportAccount) => a.type === "income" || a.type === "expense";
  const profit = -sum(movements, isPnl);
  const effect = (a: ReportAccount): ReportRow => ({ accountId: a.id, code: a.code, name: a.name, amount: -(movements.get(a.id) ?? 0n) });
  const sorted = (rows: ReportRow[]) => rows.filter((r) => r.amount !== 0n).sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
  const isFinancing = (a: ReportAccount) => a.type === "equity" || (a.type === "liability" && a.subtype === "loan");

  const operatingRows = [
    { accountId: "", code: "", name: "Profit", amount: profit },
    ...sorted(accounts.filter((a) => !isCashAccount(a) && !isPnl(a) && !isFinancing(a)).map(effect)),
  ];
  const financingRows = sorted(accounts.filter((a) => !isCashAccount(a) && isFinancing(a)).map(effect));
  const operating = section("operating", "From running the business", operatingRows);
  const financing = section("financing", "Owner and loans", financingRows);
  const opening = sum(openingBalances, isCashAccount);
  const netChange = sum(movements, isCashAccount);
  const closing = opening + netChange;
  return { opening, operating, financing, netChange, closing, difference: operating.total + financing.total - netChange };
}

// ── Ageing (what you owe suppliers, by how overdue) ──────────────────────────

export const AGE_BUCKETS = ["Not yet due", "1–30 days late", "31–60 days late", "61–90 days late", "Over 90 days late"] as const;

export interface AgeingInput {
  contactId: string | null;
  contactName: string | null;
  /** Due date, or the bill date when there is none. */
  due: string;
  open: bigint;
}

export interface AgeingRow {
  contactId: string | null;
  name: string;
  buckets: bigint[];
  total: bigint;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86400000);
}

export function ageBucket(due: string, asOf: string): number {
  const late = daysBetween(due, asOf);
  if (late <= 0) return 0;
  if (late <= 30) return 1;
  if (late <= 60) return 2;
  if (late <= 90) return 3;
  return 4;
}

export function ageing(items: AgeingInput[], asOf: string): { rows: AgeingRow[]; totals: bigint[]; total: bigint } {
  const byContact = new Map<string, AgeingRow>();
  for (const it of items) {
    if (it.open === 0n) continue;
    const key = it.contactId ?? "";
    const row = byContact.get(key) ?? { contactId: it.contactId, name: it.contactName ?? "No supplier named", buckets: AGE_BUCKETS.map(() => 0n), total: 0n };
    row.buckets[ageBucket(it.due, asOf)]! += it.open;
    row.total += it.open;
    byContact.set(key, row);
  }
  const rows = [...byContact.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.name.localeCompare(b.name)));
  const totals = AGE_BUCKETS.map((_, i) => rows.reduce((s, r) => s + r.buckets[i]!, 0n));
  return { rows, totals, total: totals.reduce((s, x) => s + x, 0n) };
}

// ── Balance sheet in columns ─────────────────────────────────────────────────

export interface BalanceSheetColumns {
  assets: ColumnSection;
  liabilities: ColumnSection;
  equity: ColumnSection;
  net: bigint[];
}

/** Several balance sheets side by side; rows keyed by account (and "Profit this year"). */
export function balanceSheetColumns(sheets: BalanceSheet[]): BalanceSheetColumns {
  const merge = (pick: (b: BalanceSheet) => ReportSection): ColumnSection => {
    const rows: ColumnRow[] = [];
    const at = new Map<string, number>();
    const key = (r: ReportRow) => `${r.accountId}|${r.header ? "h" : ""}|${r.name}`;
    // Layout: every row that appears in any column, in the first column's order, then new ones.
    sheets.forEach((b) => {
      for (const r of pick(b).rows) {
        if (at.has(key(r))) continue;
        at.set(key(r), rows.length);
        rows.push({ accountId: r.accountId, code: r.code, name: r.name, depth: r.depth, header: r.header, amounts: sheets.map(() => 0n) });
      }
    });
    sheets.forEach((b, i) => {
      for (const r of pick(b).rows) rows[at.get(key(r))!]!.amounts[i] = r.amount;
    });
    const first = pick(sheets[0]!);
    return { key: first.key, label: first.label, rows, totals: sheets.map((b) => pick(b).total) };
  };
  return { assets: merge((b) => b.assets), liabilities: merge((b) => b.liabilities), equity: merge((b) => b.equity), net: sheets.map((b) => b.assets.total - b.liabilities.total) };
}
