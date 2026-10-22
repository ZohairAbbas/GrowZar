import { describe, expect, it } from "vitest";
import { activityText, actorLabel } from "../activity";
import type { AccountType } from "../chart";
import { addMonths, compareColumns, monthColumns, previousPeriod, previousYear } from "../dates";
import { ageBucket, ageing, cashFlow, profitAndLoss, profitAndLossColumns, type ReportAccount } from "../reports";

const acc = (id: string, code: string, type: AccountType, subtype: string, systemKey: string | null = null): ReportAccount => ({ id, code, name: id, type, subtype, systemKey, archived: false });

const accounts = [
  acc("bank", "1000", "asset", "bank"),
  acc("wallet", "1070", "asset", "ad_wallet"),
  acc("courier", "1100", "asset", "receivable"),
  acc("stock", "1200", "asset", "stock"),
  acc("card", "2050", "liability", "card"),
  acc("suppliers", "2010", "liability", "payable", "payables"),
  acc("loan", "2200", "liability", "loan"),
  acc("capital", "3000", "equity", "equity", "owner_capital"),
  acc("drawings", "3100", "equity", "equity", "owner_drawings"),
  acc("retained", "3900", "equity", "equity", "retained_earnings"),
  acc("sales", "4000", "income", "sales"),
  acc("other", "4900", "income", "other"),
  acc("cogs", "5000", "expense", "cost_of_sales"),
  acc("ads", "6000", "expense", "operating"),
];
const m = (o: Record<string, bigint>) => new Map(Object.entries(o));
const sum = (x: Map<string, bigint>) => [...x.values()].reduce((s, v) => s + v, 0n);

describe("date columns", () => {
  it("addMonths keeps month-ends and clamps", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-02-29", -12)).toBe("2023-02-28");
    expect(addMonths("2023-02-28", 12)).toBe("2024-02-29"); // a month-end stays a month-end
    expect(addMonths("2026-01-15", -13)).toBe("2024-12-15");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
  });

  it("months in a range, with part-months labelled", () => {
    const c = monthColumns("2026-07-10", "2026-09-05")!;
    expect(c.map((x) => [x.from, x.to])).toEqual([
      ["2026-07-10", "2026-07-31"],
      ["2026-08-01", "2026-08-31"],
      ["2026-09-01", "2026-09-05"],
    ]);
    expect(c[0]!.label).toBe("Jul 2026 (10–31)");
    expect(c[1]!.label).toBe("Aug 2026");
    expect(monthColumns("2026-01-01", "2026-12-31")!.length).toBe(12);
    expect(monthColumns("2024-01-01", "2026-01-31")).toBeNull(); // 25 months
    expect(monthColumns("2026-10-13", "2026-10-13")!.length).toBe(1);
  });

  it("the period before: months for periods starting on the 1st, otherwise days", () => {
    expect(previousPeriod("2026-10-01", "2026-10-31")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(previousPeriod("2026-03-01", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousPeriod("2026-10-01", "2026-10-13")).toEqual({ from: "2026-09-01", to: "2026-09-13" });
    expect(previousPeriod("2026-03-01", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    // 1–30 March against February: February has no 29th/30th, so it stops at its last day.
    expect(previousPeriod("2026-03-01", "2026-03-30")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousPeriod("2026-07-01", "2027-06-30")).toEqual({ from: "2025-07-01", to: "2026-06-30" });
    expect(previousPeriod("2026-10-05", "2026-10-11")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(previousYear("2024-02-01", "2024-02-29")).toEqual({ from: "2023-02-01", to: "2023-02-28" });
  });

  it("compareColumns", () => {
    expect(compareColumns("2026-10-01", "2026-10-31", "")).toHaveLength(1);
    expect(compareColumns("2026-10-01", "2026-10-31", "previous_year")![1]).toMatchObject({ from: "2025-10-01", to: "2025-10-31" });
    expect(compareColumns("2026-01-01", "2026-03-31", "months")).toHaveLength(3);
  });
});

describe("P&L in columns", () => {
  it("each column matches its own P&L; accounts missing from a column are zero", () => {
    const a = m({ sales: -1000n, cogs: 600n, bank: 400n });
    const b = m({ sales: -500n, ads: 100n, other: -20n, bank: 420n });
    const cols = profitAndLossColumns(accounts, [a, b]);
    expect(cols.netProfit).toEqual([profitAndLoss(accounts, a).netProfit, profitAndLoss(accounts, b).netProfit]);
    expect(cols.grossProfit).toEqual([400n, 500n]);
    expect(cols.costOfSales.rows).toEqual([{ accountId: "cogs", code: "5000", name: "cogs", amounts: [600n, 0n] }]);
    expect(cols.expenses.rows[0]!.amounts).toEqual([0n, 100n]);
    expect(cols.otherIncome.totals).toEqual([0n, 20n]);
  });
});

describe("cash flow", () => {
  it("adds up to the change in money; profit, working capital and financing land in the right sections", () => {
    // Period: sold 1000 on COD (courier owes 1000), cost 600 out of stock; courier paid 700;
    // bought stock 500 on credit; ads 100 on the card; owner took 50; borrowed 300.
    const moves = m({
      sales: -1000n, courier: 1000n - 700n, cogs: 600n, stock: -600n + 500n, bank: 700n - 50n + 300n,
      suppliers: -500n, ads: 100n, card: -100n, drawings: 50n, loan: -300n,
    });
    expect(sum(moves)).toBe(0n);
    const opening = m({ bank: 5000n, wallet: 200n, capital: -5200n });
    const cf = cashFlow(accounts, moves, opening);
    expect(cf.difference).toBe(0n);
    expect(cf.opening).toBe(5200n);
    expect(cf.netChange).toBe(950n);
    expect(cf.closing).toBe(6150n);
    const op = Object.fromEntries(cf.operating.rows.map((r) => [r.name, r.amount]));
    expect(op).toEqual({ Profit: 300n, courier: -300n, suppliers: 500n, stock: 100n, card: 100n });
    const fin = Object.fromEntries(cf.financing.rows.map((r) => [r.name, r.amount]));
    expect(fin).toEqual({ loan: 300n, drawings: -50n });
    expect(cf.operating.total + cf.financing.total).toBe(cf.netChange);
  });

  it("a period with only opening balances shows them as financing", () => {
    const cf = cashFlow(accounts, m({ bank: 1000n, capital: -1000n }), new Map());
    expect(cf.financing.rows).toEqual([{ accountId: "capital", code: "3000", name: "capital", amount: 1000n }]);
    expect(cf.operating.rows).toEqual([{ accountId: "", code: "", name: "Profit", amount: 0n }]);
    expect(cf.difference).toBe(0n);
  });
});

describe("ageing", () => {
  it("buckets by days late", () => {
    expect(ageBucket("2026-10-13", "2026-10-13")).toBe(0);
    expect(ageBucket("2026-10-20", "2026-10-13")).toBe(0);
    expect(ageBucket("2026-10-12", "2026-10-13")).toBe(1);
    expect(ageBucket("2026-09-13", "2026-10-13")).toBe(1); // 30 days
    expect(ageBucket("2026-09-12", "2026-10-13")).toBe(2); // 31
    expect(ageBucket("2026-07-15", "2026-10-13")).toBe(3); // 90
    expect(ageBucket("2026-07-14", "2026-10-13")).toBe(4); // 91
    expect(ageBucket("2026-03-01", "2026-03-31")).toBe(1); // across February
  });

  it("groups per supplier, biggest first, ignoring settled bills", () => {
    const r = ageing(
      [
        { contactId: "a", contactName: "Alpha", due: "2026-10-20", open: 100n },
        { contactId: "a", contactName: "Alpha", due: "2026-06-01", open: 50n },
        { contactId: "b", contactName: "Beta", due: "2026-10-01", open: 500n },
        { contactId: "c", contactName: "Gamma", due: "2026-10-01", open: 0n },
        { contactId: null, contactName: null, due: "2026-10-01", open: 5n },
      ],
      "2026-10-13",
    );
    expect(r.rows.map((x) => x.name)).toEqual(["Beta", "Alpha", "No supplier named"]);
    expect(r.rows[1]!.buckets).toEqual([100n, 0n, 0n, 0n, 50n]);
    expect(r.totals).toEqual([100n, 505n, 0n, 0n, 50n]);
    expect(r.total).toBe(655n);
  });
});

describe("activity", () => {
  const names = {
    account: (id: unknown) => (id === "acc1" ? "Packaging" : null),
    contact: (id: unknown) => (id === "c1" ? "TCS" : null),
    document: (id: unknown) => (id === "d1" ? "EXP-0004 · Expense" : null),
  };
  it("describes events in plain words with a link", () => {
    expect(activityText({ action: "document.posted", detail: { number: "EXP-0004" }, documentId: "d1" }, names)).toEqual({ text: "Saved to the books: EXP-0004 · Expense", link: "/books/entries/d1" });
    expect(activityText({ action: "document.cancelled", detail: { reason: "dup", date: "2026-08-01" }, documentId: "d1" }, names).text).toBe("Cancelled EXP-0004 · Expense — “dup”, reversed on 2026-08-01");
    expect(activityText({ action: "document.draft_created", detail: { type: "sales_summary", source: "shopify_sales" }, documentId: "d1" }, names).text).toBe("Started a draft: EXP-0004 · Expense (from Shopify sales)");
    expect(activityText({ action: "document.draft_discarded", detail: { documentId: "gone", type: "bill_payment" }, documentId: null }, names)).toEqual({ text: "Discarded a draft (bill payment)", link: null });
    expect(activityText({ action: "account.renamed", detail: { accountId: "acc1", from: "Boxes", to: "Packaging" }, documentId: null }, names)).toEqual({ text: "Renamed the account “Boxes” to “Packaging”", link: "/books/accounts" });
    expect(activityText({ action: "account.created", detail: { accountId: "zz", name: "Fuel" }, documentId: null }, names).text).toBe("Added the account Fuel");
    expect(activityText({ action: "contact.updated", detail: { contactId: "c1", before: { name: "T.C.S" }, after: { name: "TCS" } }, documentId: null }, names).text).toBe("Renamed the contact “T.C.S” to “TCS”");
    expect(activityText({ action: "book.reopened", detail: { from: "2026-08-31", to: null, reason: "late bill" }, documentId: null }, names).text).toBe("Reopened every date — “late bill”");
    expect(activityText({ action: "connector.saved", detail: { key: "ad_spend", enabled: false }, documentId: null }, names).text).toBe("Switched off Ad spend");
    expect(activityText({ action: "something.new", detail: {}, documentId: null }, names).text).toBe("something new");
  });

  it("who did it", () => {
    expect(actorLabel(null, "1")).toBe("Automatic");
    expect(actorLabel("94393991398", "94393991398")).toBe("You");
    expect(actorLabel("92163997798", "94393991398")).toBe("Staff member ···7798");
  });
});

describe("bank matching", async () => {
  const { reconcileFigures, ruleFor, ruleWordsFrom, suggestMatches } = await import("../bank");
  it("pairs equal amounts within a week, closest first, one-to-one", () => {
    const m = suggestMatches(
      [
        { id: "s1", date: "2026-10-05", amount: -500n },
        { id: "s2", date: "2026-10-06", amount: -500n },
        { id: "s3", date: "2026-10-20", amount: -500n },
        { id: "s4", date: "2026-10-05", amount: 900n },
      ],
      [
        { id: "1", date: "2026-10-06", amount: -500n },
        { id: "2", date: "2026-10-03", amount: -500n },
        { id: "3", date: "2026-10-05", amount: 901n },
      ],
    );
    expect(Object.fromEntries(m)).toEqual({ s2: "1", s1: "2" });
  });
  it("rules: words in the description, direction, the longest wins", () => {
    const rules = [
      { id: "a", contains: "FACEBK", direction: "out" as const, accountId: "ads", contactId: null },
      { id: "b", contains: "facebk ads ireland", direction: "out" as const, accountId: "ads2", contactId: "meta" },
      { id: "c", contains: "facebk", direction: "in" as const, accountId: "refunds", contactId: null },
    ];
    expect(ruleFor(rules, "POS FACEBK ADS IRELAND 1234", -100n)?.id).toBe("b");
    expect(ruleFor(rules, "FACEBK *XYZ", -100n)?.id).toBe("a");
    expect(ruleFor(rules, "FACEBK refund", 100n)?.id).toBe("c");
    expect(ruleFor(rules, "Rent", -100n)).toBeNull();
  });
  it("rule words drop numbers and references", () => {
    expect(ruleWordsFrom("IBFT 0123456789 TO ALI TRADERS 12/10/2026")).toBe("IBFT TO ALI TRADERS");
    expect(ruleWordsFrom("POS-4411 K-ELECTRIC BILL")).toBe("POS K ELECTRIC BILL");
    expect(ruleWordsFrom("123 456")).toBe("");
  });
  it("reconcile figures", () => {
    expect(reconcileFigures(1000n, 200n, [300n, 500n])).toEqual({ cleared: 1000n, difference: 0n });
    expect(reconcileFigures(1000n, 0n, [-50n])).toEqual({ cleared: -50n, difference: 1050n });
  });
});

describe("bank rules match words, not characters", async () => {
  const { ruleFor } = await import("../bank");
  const rules = [{ id: "a", contains: "IBFT ALI TRADERS", direction: "out" as const, accountId: "x", contactId: null }];
  it("references in between don't stop a match; partial words don't match", () => {
    expect(ruleFor(rules, "IBFT 0042 ALI TRADERS 12/12", -1n)?.id).toBe("a");
    expect(ruleFor(rules, "ibft-ali-traders", -1n)?.id).toBe("a");
    expect(ruleFor([{ ...rules[0]!, contains: "ALI" }], "KHALID STORES", -1n)).toBeNull();
    expect(ruleFor([{ ...rules[0]!, contains: "ALI" }], "PAID ALI", -1n)?.id).toBe("a");
  });
});
