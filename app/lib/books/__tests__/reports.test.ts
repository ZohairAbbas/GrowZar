import { describe, expect, it } from "vitest";
import type { AccountType } from "../chart";
import { balanceSheet, homeTiles, profitAndLoss, trialBalance, type ReportAccount } from "../reports";

const acc = (id: string, code: string, type: AccountType, subtype: string, systemKey: string | null = null): ReportAccount => ({
  id, code, name: id, type, subtype, systemKey, archived: false,
});

const accounts = [
  acc("bank", "1000", "asset", "bank"),
  acc("courier", "1100", "asset", "receivable"),
  acc("stock", "1200", "asset", "stock"),
  acc("card", "2050", "liability", "card"),
  acc("capital", "3000", "equity", "equity", "owner_capital"),
  acc("drawings", "3100", "equity", "equity", "owner_drawings"),
  acc("opening", "3200", "equity", "equity", "opening_balance"),
  acc("retained", "3900", "equity", "equity", "retained_earnings"),
  acc("sales", "4000", "income", "sales"),
  acc("discounts", "4020", "income", "sales"),
  acc("other", "4900", "income", "other"),
  acc("cogs", "5000", "expense", "cost_of_sales"),
  acc("ads", "6000", "expense", "operating"),
];

// A small, balanced ledger: profit 300 before this year, 150 this year.
const lastYear = new Map<string, bigint>([
  ["sales", -1000n], ["cogs", 700n],
]);
const toDate = new Map<string, bigint>([
  ["bank", 3950n], ["courier", 800n], ["stock", 400n], ["card", -200n],
  ["capital", -5000n], ["drawings", 500n],
  ["sales", -3000n], ["discounts", 100n], ["other", -50n], ["cogs", 2000n], ["ads", 500n],
]);

describe("reports", () => {
  it("the fixture ledger balances", () => {
    expect([...toDate.values()].reduce((s, x) => s + x, 0n)).toBe(0n);
  });

  it("trial balance: debits equal credits, zero rows hidden", () => {
    const tb = trialBalance(accounts, toDate);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.rows.find((r) => r.accountId === "opening")).toBeUndefined();
    expect(tb.rows.find((r) => r.accountId === "card")).toMatchObject({ debit: 0n, credit: 200n });
  });

  it("profit and loss: discounts reduce sales, gross and net profit", () => {
    const pl = profitAndLoss(accounts, new Map([["sales", -2000n], ["discounts", 100n], ["other", -50n], ["cogs", 1300n], ["ads", 500n]]));
    expect(pl.sales.total).toBe(1900n);
    expect(pl.sales.rows.find((r) => r.accountId === "discounts")?.amount).toBe(-100n);
    expect(pl.grossProfit).toBe(600n);
    expect(pl.otherIncome.total).toBe(50n);
    expect(pl.netProfit).toBe(150n);
  });

  it("balance sheet balances, splitting prior years' profit from this year's", () => {
    const bs = balanceSheet(accounts, toDate, lastYear);
    expect(bs.difference).toBe(0n);
    expect(bs.assets.total).toBe(5150n);
    expect(bs.liabilities.total).toBe(200n);
    const eq = Object.fromEntries(bs.equity.rows.map((r) => [r.name, r.amount]));
    expect(eq).toEqual({ capital: 5000n, drawings: -500n, retained: 300n, "Profit this year": 150n });
    expect(bs.equity.total).toBe(4950n);
  });

  it("home tiles group money, owed to you, you owe and stock", () => {
    expect(homeTiles(accounts, toDate)).toEqual({ money: 3950n, owedToYou: 800n, youOwe: 200n, stock: 400n });
  });
});

describe("sub-accounts in reports", async () => {
  const { profitAndLoss, profitAndLossColumns, balanceSheet, balanceSheetColumns } = await import("../reports");
  const accs = [
    ...accounts,
    { id: "fb", code: "6001", name: "Facebook ads", type: "expense" as const, subtype: "operating", systemKey: null, archived: false, parentId: "ads" },
    { id: "tt", code: "6002", name: "TikTok ads", type: "expense" as const, subtype: "operating", systemKey: null, archived: false, parentId: "ads" },
  ];
  it("a parent becomes a heading with its total; its own amount shows as (other); totals don't double count", () => {
    const moves = new Map<string, bigint>([["sales", -1000n], ["ads", 50n], ["fb", 200n], ["tt", 0n]]);
    const pl = profitAndLoss(accs, moves);
    expect(pl.expenses.rows.map((r) => [r.name, r.amount, r.header ?? false, r.depth ?? 0])).toEqual([
      ["ads", 250n, true, 0],
      ["ads (other)", 50n, false, 1],
      ["Facebook ads", 200n, false, 1],
    ]);
    expect(pl.expenses.total).toBe(250n);
    expect(pl.netProfit).toBe(750n);
  });
  it("columns keep the same headings in every column", () => {
    const a = new Map<string, bigint>([["sales", -100n], ["fb", 10n]]);
    const b = new Map<string, bigint>([["sales", -100n], ["tt", 20n]]);
    const cols = profitAndLossColumns(accs, [a, b]);
    expect(cols.expenses.rows.map((r) => [r.name, r.amounts])).toEqual([
      ["ads", [10n, 20n]],
      ["Facebook ads", [10n, 0n]],
      ["TikTok ads", [0n, 20n]],
    ]);
    expect(cols.expenses.totals).toEqual([10n, 20n]);
  });
  it("balance sheet on two dates", () => {
    const now = balanceSheet(accounts, toDate, lastYear);
    const before = balanceSheet(accounts, new Map([["bank", 100n], ["capital", -100n]]), new Map());
    const c = balanceSheetColumns([now, before]);
    expect(c.assets.totals).toEqual([5150n, 100n]);
    expect(c.assets.rows.find((r) => r.accountId === "bank")!.amounts).toEqual([3950n, 100n]);
    expect(c.assets.rows.find((r) => r.accountId === "courier")!.amounts).toEqual([800n, 0n]);
    expect(c.net).toEqual([4950n, 100n]);
  });
});
