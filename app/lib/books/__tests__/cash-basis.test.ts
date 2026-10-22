import { describe, expect, it } from "vitest";
import { CASH_ROWS, cashMovements, distribute, type CashAccount, type CashEntry } from "../cash-basis";

const A: Record<string, CashAccount> = {
  bank: { type: "asset", subtype: "bank", systemKey: null },
  card: { type: "liability", subtype: "card", systemKey: null },
  wallet: { type: "asset", subtype: "ad_wallet", systemKey: null },
  couriers: { type: "asset", subtype: "receivable", systemKey: null },
  customers: { type: "asset", subtype: "receivable", systemKey: "receivables" },
  suppliers: { type: "liability", subtype: "payable", systemKey: "payables" },
  stock: { type: "asset", subtype: "stock", systemKey: "stock" },
  taxIn: { type: "asset", subtype: "tax", systemKey: null },
  taxOut: { type: "liability", subtype: "tax", systemKey: null },
  loan: { type: "liability", subtype: "loan", systemKey: null },
  owner: { type: "equity", subtype: "equity", systemKey: null },
  sales: { type: "income", subtype: "sales", systemKey: null },
  ship: { type: "income", subtype: "sales", systemKey: null },
  cogs: { type: "expense", subtype: "cost_of_sales", systemKey: "cogs" },
  delivery: { type: "expense", subtype: "cost_of_sales", systemKey: null },
  ads: { type: "expense", subtype: "operating", systemKey: null },
  rent: { type: "expense", subtype: "operating", systemKey: null },
};
const accounts = new Map(Object.entries(A));
const e = (documentId: string, docType: string, lines: Record<string, bigint>): CashEntry => ({ documentId, docType, lines: Object.entries(lines).map(([accountId, amount]) => ({ accountId, amount })) });
const run = (entries: CashEntry[], allocations: Record<string, Array<{ targetId: string; amount: bigint }>> = {}, targets: Record<string, Record<string, bigint>> = {}) =>
  Object.fromEntries(
    cashMovements({
      entries,
      accounts,
      allocations: new Map(Object.entries(allocations)),
      targets: new Map(Object.entries(targets).map(([k, v]) => [k, Object.entries(v).map(([accountId, amount]) => ({ accountId, amount }))])),
    }),
  );
const total = (m: Record<string, bigint>) => Object.values(m).reduce((a, b) => a + b, 0n);

describe("distribute", () => {
  it("splits exactly, the rest to the largest", () => {
    expect(distribute(20000000n, [20000000n, 3600000n])).toEqual([16949153n, 3050847n]);
    expect(distribute(-6000000n, [-10000000n, -1800000n])).toEqual([-5084746n, -915254n]);
    expect(distribute(100n, [0n, 0n])).toEqual([0n, 0n]);
    expect(distribute(10n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n)).toBe(10n);
  });
});

describe("cash basis", () => {
  it("an expense paid from the bank or a card counts; one with tax keeps only the cost", () => {
    expect(run([e("d1", "expense", { rent: 1000n, bank: -1000n }), e("d2", "expense", { ads: 500n, taxIn: 90n, card: -590n })])).toEqual({ rent: 1000n, ads: 500n });
  });

  it("sales owed by couriers don't count until the courier pays; the payout counts gross with its fees", () => {
    const sale = e("s1", "sales_summary", { couriers: 1180n, cogs: 400n, sales: -1000n, taxOut: -180n, stock: -400n });
    const payout = e("p1", "courier_payout", { bank: 1100n, delivery: 80n, couriers: -1180n });
    expect(run([sale])).toEqual({});
    expect(run([sale, payout])).toEqual({ [CASH_ROWS.collected.id]: -1180n, delivery: 80n });
  });

  it("prepaid sales straight into the bank count on the day (with COD in the same day netted)", () => {
    const m = run([e("s2", "sales_summary", { bank: 500n, couriers: 700n, sales: -1200n })]);
    expect(m).toEqual({ sales: -1200n, [CASH_ROWS.collected.id]: 700n });
    expect(total(m)).toBe(-500n); // = the money that arrived
  });

  it("a bill payment counts the bill's costs in proportion; tax on the bill stays out; stock is 'stock paid for'", () => {
    const bill = { stock: 800n, rent: 200n, taxIn: 180n, suppliers: -1180n };
    const pay = e("bp", "bill_payment", { suppliers: 590n, bank: -590n });
    expect(run([pay], { bp: [{ targetId: "bill", amount: 590n }] }, { bill })).toEqual({ [CASH_ROWS.stock.id]: 400n, rent: 100n });
  });

  it("an invoice payment counts its income, not its tax; unmatched money from customers has its own row", () => {
    const inv = { customers: 1180n, sales: -1000n, taxOut: -180n };
    const pay = e("cp", "customer_payment", { bank: 1300n, customers: -1300n });
    expect(run([pay], { cp: [{ targetId: "inv", amount: 1180n }] }, { inv })).toEqual({ sales: -1000n, [CASH_ROWS.customers.id]: -120n });
  });

  it("withholding on a customer payment isn't income or cost", () => {
    const inv = { customers: 1000n, sales: -1000n };
    expect(run([e("cp", "customer_payment", { bank: 960n, taxIn: 40n, customers: -1000n })], { cp: [{ targetId: "inv", amount: 1000n }] }, { inv })).toEqual({ sales: -1000n });
  });

  it("paying a supplier without a bill, or a refund from one", () => {
    expect(run([e("x", "money_out", { suppliers: 300n, bank: -300n }), e("y", "money_in", { bank: 50n, suppliers: -50n })])).toEqual({ [CASH_ROWS.suppliers.id]: 250n });
  });

  it("transfers, card payments, wallet top-ups, loans, owner money, tax payments and opening balances don't count", () => {
    expect(
      run([
        e("t", "transfer", { bank: -100n, wallet: 100n }),
        e("c", "transfer", { bank: -100n, card: 100n }),
        e("l", "money_in", { bank: 1000n, loan: -1000n }),
        e("o", "owner_out", { bank: -10n, owner: 10n }),
        e("tx", "tax_payment", { taxOut: 300n, taxIn: -100n, bank: -200n }),
        e("op", "opening", { bank: 5000n, rent: 1n, owner: -5001n }),
      ]),
    ).toEqual({});
  });

  it("ad spend from a prepaid ad wallet counts when spent", () => {
    expect(run([e("a", "expense", { ads: 700n, wallet: -700n })])).toEqual({ ads: 700n });
  });

  it("entries with no money (bills, invoices, stock counts) don't count", () => {
    expect(run([e("b", "bill", { rent: 100n, suppliers: -100n }), e("k", "stock_adjustment", { cogs: 5n, stock: -5n })])).toEqual({});
  });

  it("a cancelled payment's reversal nets to nothing on every row", () => {
    const bill = { rent: 1000n, suppliers: -1000n };
    const m = run([e("bp", "bill_payment", { suppliers: 600n, bank: -600n }), e("bp", "bill_payment", { suppliers: -600n, bank: 600n })], { bp: [{ targetId: "bill", amount: 600n }] }, { bill });
    expect(Object.values(m).every((v) => v === 0n)).toBe(true);
  });

  it("a payment for a cancelled bill is unmatched; one allocation spread over two bills", () => {
    expect(run([e("bp", "bill_payment", { suppliers: 100n, bank: -100n })], { bp: [{ targetId: "gone", amount: 100n }] }, {})).toEqual({ [CASH_ROWS.suppliers.id]: 100n });
    const m = run([e("bp", "bill_payment", { suppliers: 300n, bank: -300n })], { bp: [{ targetId: "b1", amount: 100n }, { targetId: "b2", amount: 200n }] }, { b1: { rent: 100n, suppliers: -100n }, b2: { ads: 400n, suppliers: -400n } });
    expect(m).toEqual({ rent: 100n, ads: 200n });
  });

  it("cash profit = money in − money out for the profit lines", () => {
    const entries = [
      e("p1", "courier_payout", { bank: 1100n, delivery: 80n, couriers: -1180n }),
      e("d1", "expense", { rent: 1000n, bank: -1000n }),
    ];
    // −(movements) = income − costs = 1180 − 80 − 1000 = 100 = the bank's change.
    expect(-total(run(entries))).toBe(100n);
  });
});
