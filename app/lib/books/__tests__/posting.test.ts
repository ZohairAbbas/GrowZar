import { describe, expect, it } from "vitest";
import { CHART_TEMPLATE, type SystemKey } from "../chart";
import {
  BooksError,
  buildPosting,
  cancelDateFor,
  fiscalYearStart,
  isIsoDate,
  mirrorLines,
  type AccountInfo,
  type DocType,
  type PostingContext,
} from "../posting";

function makeCtx(): PostingContext & { byName: (n: string) => string } {
  const accounts = new Map<string, AccountInfo>();
  const add = (a: Omit<AccountInfo, "archived"> & { archived?: boolean }) =>
    accounts.set(a.id, { archived: false, ...a });
  for (const t of CHART_TEMPLATE) {
    add({ id: `acc_${t.code}`, name: t.name, type: t.type, subtype: t.subtype, systemKey: t.systemKey ?? null });
  }
  add({ id: "bank", name: "Main bank account", type: "asset", subtype: "bank", systemKey: null });
  add({ id: "cash", name: "Cash in hand", type: "asset", subtype: "cash", systemKey: null });
  add({ id: "card", name: "Business card", type: "liability", subtype: "card", systemKey: null });
  add({ id: "old", name: "Old bank", type: "asset", subtype: "bank", systemKey: null, archived: true });
  add({ id: "usdcard", name: "USD card", type: "liability", subtype: "card", systemKey: null, currency: "USD" });
  add({ id: "usdbank", name: "Payoneer", type: "asset", subtype: "bank", systemKey: null, currency: "USD" });
  return {
    accounts,
    system(key: SystemKey) {
      for (const a of accounts.values()) if (a.systemKey === key) return a.id;
      throw new Error(`no ${key}`);
    },
    byName(n: string) {
      for (const a of accounts.values()) if (a.name === n) return a.id;
      throw new Error(`no ${n}`);
    },
  };
}

const ctx = makeCtx();
const A = (n: string) => ctx.byName(n);
const sum = (ls: { amount: bigint }[]) => ls.reduce((s, l) => s + l.amount, 0n);
const byAcc = (ls: { accountId: string; amount: bigint }[]) =>
  Object.fromEntries(ls.map((l) => [l.accountId, l.amount]));

describe("buildPosting — one rule per document type", () => {
  it("expense: Dr expense / Cr the account it was paid from", () => {
    const p = buildPosting("expense", { paidFrom: "bank", lines: [{ accountId: A("Packaging"), amount: "1250000" }] }, ctx, "c1");
    expect(byAcc(p.lines)).toEqual({ [A("Packaging")]: 1250000n, bank: -1250000n });
    expect(p.total).toBe(1250000n);
    expect(p.lines.every((l) => l.contactId === "c1")).toBe(true);
  });

  it("expense split over two accounts, paid by credit card", () => {
    const p = buildPosting(
      "expense",
      { paidFrom: "card", lines: [{ accountId: A("Advertising"), amount: "700" }, { accountId: A("Software and apps"), amount: "300" }] },
      ctx,
    );
    expect(byAcc(p.lines)).toEqual({ [A("Advertising")]: 700n, [A("Software and apps")]: 300n, card: -1000n });
  });

  it("money in: Dr bank / Cr income", () => {
    const p = buildPosting("money_in", { receivedIn: "bank", lines: [{ accountId: A("Other income"), amount: "5000" }] }, ctx);
    expect(byAcc(p.lines)).toEqual({ bank: 5000n, [A("Other income")]: -5000n });
  });

  it("transfer: Dr to / Cr from", () => {
    const p = buildPosting("transfer", { from: "bank", to: "cash", amount: "900" }, ctx);
    expect(byAcc(p.lines)).toEqual({ cash: 900n, bank: -900n });
  });

  it("owner put in: Dr bank / Cr owner's capital", () => {
    const p = buildPosting("owner_in", { to: "bank", amount: "100" }, ctx);
    expect(byAcc(p.lines)).toEqual({ bank: 100n, [ctx.system("owner_capital")]: -100n });
  });

  it("owner took out: Dr drawings / Cr cash", () => {
    const p = buildPosting("owner_out", { from: "cash", amount: "100" }, ctx);
    expect(byAcc(p.lines)).toEqual({ [ctx.system("owner_drawings")]: 100n, cash: -100n });
  });

  it("opening balances: natural amounts, balanced by the adjustment account", () => {
    const p = buildPosting(
      "opening",
      {
        lines: [
          { accountId: "bank", amount: "10000" },
          { accountId: "card", amount: "2500" },
          { accountId: A("Stock"), amount: "4000" },
          { accountId: "cash", amount: "-300" }, // overdrawn / negative cash is allowed as typed
        ],
      },
      ctx,
    );
    expect(byAcc(p.lines)).toEqual({
      bank: 10000n,
      card: -2500n,
      [A("Stock")]: 4000n,
      cash: -300n,
      [ctx.system("opening_balance")]: -11200n,
    });
  });

  it("opening balances that already balance add no adjustment line", () => {
    const p = buildPosting("opening", { lines: [{ accountId: "bank", amount: "500" }, { accountId: "card", amount: "500" }] }, ctx);
    expect(p.lines).toHaveLength(2);
  });

  it("manual entry: debits and credits as entered", () => {
    const p = buildPosting(
      "manual",
      { lines: [{ accountId: A("Rent"), debit: "800" }, { accountId: A("Owed to suppliers"), credit: "800", contactId: "s1" }] },
      ctx,
    );
    expect(byAcc(p.lines)).toEqual({ [A("Rent")]: 800n, [A("Owed to suppliers")]: -800n });
    expect(p.lines[1]!.contactId).toBe("s1");
  });
});

describe("buildPosting — sales and courier payouts", () => {
  it("sales summary: COD and prepaid owed, discounts, sales, shipping, tax", () => {
    const p = buildPosting(
      "sales_summary",
      {
        debits: [
          { accountId: A("Owed by couriers"), amount: "90000" },
          { accountId: A("Owed by payment gateways"), amount: "20000" },
          { accountId: A("Discounts given"), amount: "5000" },
        ],
        credits: [
          { accountId: A("Sales"), amount: "100000" },
          { accountId: A("Shipping charged"), amount: "10000" },
          { accountId: A("Sales tax to pay"), amount: "5000" },
        ],
      },
      ctx,
    );
    expect(byAcc(p.lines)).toEqual({
      [A("Owed by couriers")]: 90000n,
      [A("Owed by payment gateways")]: 20000n,
      [A("Discounts given")]: 5000n,
      [A("Sales")]: -100000n,
      [A("Shipping charged")]: -10000n,
      [A("Sales tax to pay")]: -5000n,
    });
    expect(p.total).toBe(115000n);
  });

  it("sales summary that doesn't add up is refused", () => {
    expect(() =>
      buildPosting("sales_summary", { debits: [{ accountId: A("Owed by couriers"), amount: "99" }], credits: [{ accountId: A("Sales"), amount: "100" }] }, ctx),
    ).toThrow(/doesn't add up/);
  });

  it("a day with only returns credits what customers owe", () => {
    const p = buildPosting("sales_summary", { debits: [{ accountId: A("Returns"), amount: "300" }], credits: [{ accountId: A("Owed by couriers"), amount: "300" }] }, ctx);
    expect(byAcc(p.lines)).toEqual({ [A("Returns")]: 300n, [A("Owed by couriers")]: -300n });
  });

  it("courier paid me: bank + what they kept clears the receivable", () => {
    const p = buildPosting(
      "courier_payout",
      {
        receivable: A("Owed by couriers"),
        receivedIn: "bank",
        received: "85000",
        deductions: [
          { accountId: A("Delivery charges"), amount: "12000" },
          { accountId: A("Return charges"), amount: "2000" },
          { accountId: A("Tax withheld by others"), amount: "1000" },
        ],
      },
      ctx,
      "tcs",
    );
    expect(byAcc(p.lines)).toEqual({
      bank: 85000n,
      [A("Delivery charges")]: 12000n,
      [A("Return charges")]: 2000n,
      [A("Tax withheld by others")]: 1000n,
      [A("Owed by couriers")]: -100000n,
    });
    expect(p.lines.find((l) => l.accountId === A("Owed by couriers"))!.contactId).toBeNull();
    expect(p.lines.find((l) => l.accountId === "bank")!.contactId).toBe("tcs");
  });

  it("courier payout where the courier kept everything (nothing reached the bank)", () => {
    const p = buildPosting("courier_payout", { receivable: A("Owed by couriers"), receivedIn: "bank", received: "0", deductions: [{ accountId: A("Return charges"), amount: "500" }] }, ctx);
    expect(byAcc(p.lines)).toEqual({ [A("Return charges")]: 500n, [A("Owed by couriers")]: -500n });
  });

  it("courier payout refuses a non-receivable 'owed by' and an empty payout", () => {
    expect(() => buildPosting("courier_payout", { receivable: "bank", receivedIn: "cash", received: "5", deductions: [] }, ctx)).toThrow(/isn't an "owed to you"/);
    expect(() => buildPosting("courier_payout", { receivable: A("Owed by couriers"), receivedIn: "bank", received: "0", deductions: [] }, ctx)).toThrow(/Enter an amount/);
    expect(() =>
      buildPosting("courier_payout", { receivable: A("Owed by couriers"), receivedIn: "bank", received: "5", deductions: [{ accountId: A("Sales"), amount: "1" }] }, ctx),
    ).toThrow(/can't be used for what the courier kept/);
  });
});

describe("buildPosting — bills and payments", () => {
  it("bill: Dr each cost / Cr owed to suppliers, all tagged with the supplier", () => {
    const p = buildPosting(
      "bill",
      { payable: A("Owed to suppliers"), dueDate: "2026-11-07", reference: "INV-77", lines: [{ accountId: A("Packaging"), amount: "30000" }, { accountId: A("Stock"), amount: "70000" }] },
      ctx,
      "sup",
    );
    expect(byAcc(p.lines)).toEqual({ [A("Packaging")]: 30000n, [A("Stock")]: 70000n, [A("Owed to suppliers")]: -100000n });
    expect(p.lines.every((l) => l.contactId === "sup")).toBe(true);
    expect(p.lines.find((l) => l.amount < 0n)!.description).toBe("Bill INV-77");
  });
  it("bill needs a supplier, a 'you owe' account, a valid due date and cost accounts", () => {
    const base = { payable: A("Owed to suppliers"), lines: [{ accountId: A("Rent"), amount: "5" }] };
    expect(() => buildPosting("bill", base, ctx)).toThrow(/Choose the supplier/);
    expect(() => buildPosting("bill", { ...base, payable: A("Sales tax to pay") }, ctx, "s")).toThrow(/isn't a "you owe"/);
    expect(() => buildPosting("bill", { ...base, dueDate: "2026-02-30" }, ctx, "s")).toThrow(/due date/);
    expect(() => buildPosting("bill", { ...base, lines: [{ accountId: A("Sales"), amount: "5" }] }, ctx, "s")).toThrow(/can't be used on a bill/);
    expect(() => buildPosting("bill", { ...base, lines: [{ accountId: "bank", amount: "5" }] }, ctx, "s")).toThrow(/can't be used on a bill/);
  });
  it("bill payment: Dr owed to suppliers / Cr bank for the total of the bills paid", () => {
    const p = buildPosting("bill_payment", { payable: A("Owed to suppliers"), paidFrom: "bank", allocations: [{ billId: "b1", amount: "600" }, { billId: "b2", amount: "400" }] }, ctx, "sup");
    expect(byAcc(p.lines)).toEqual({ [A("Owed to suppliers")]: 1000n, bank: -1000n });
  });
  it("bill payment refuses the same bill twice and a non-money 'paid from'", () => {
    expect(() => buildPosting("bill_payment", { payable: A("Owed to suppliers"), paidFrom: "bank", allocations: [{ billId: "b1", amount: "1" }, { billId: "b1", amount: "1" }] }, ctx, "s")).toThrow(/listed twice/);
    expect(() => buildPosting("bill_payment", { payable: A("Owed to suppliers"), paidFrom: A("Rent"), allocations: [{ billId: "b1", amount: "1" }] }, ctx, "s")).toThrow(/isn't a bank/);
  });
  it("courier invoice (charges only): money goes out, nothing owed is cleared", () => {
    const p = buildPosting("courier_payout", { receivable: A("Owed by couriers"), receivedIn: "bank", received: "-500", deductions: [{ accountId: A("Delivery charges"), amount: "500" }] }, ctx);
    expect(byAcc(p.lines)).toEqual({ bank: -500n, [A("Delivery charges")]: 500n });
  });
  it("courier carry-forward (a negative deduction) still balances", () => {
    const p = buildPosting("courier_payout", { receivable: A("Owed by couriers"), receivedIn: "bank", received: "1000", deductions: [{ accountId: A("Delivery charges"), amount: "200" }, { accountId: A("Delivery charges"), amount: "-50" }] }, ctx);
    expect(sum(p.lines)).toBe(0n);
    expect(byAcc(p.lines)[A("Owed by couriers")]).toBe(-1150n);
  });
});

describe("buildPosting — gateway payouts", () => {
  it("bank + fees + tax kept clears what the gateway owes", () => {
    const p = buildPosting("gateway_payout", { receivable: A("Owed by payment gateways"), receivedIn: "bank", received: "97000", deductions: [{ accountId: A("Payment gateway fees"), amount: "2500" }, { accountId: A("Tax withheld by others"), amount: "500" }] }, ctx, "payfast");
    expect(byAcc(p.lines)).toEqual({ bank: 97000n, [A("Payment gateway fees")]: 2500n, [A("Tax withheld by others")]: 500n, [A("Owed by payment gateways")]: -100000n });
    expect(() => buildPosting("gateway_payout", { receivable: A("Owed by payment gateways"), receivedIn: "bank", received: "1", deductions: [{ accountId: A("Sales"), amount: "1" }] }, ctx)).toThrow(/what the gateway kept/);
  });
});

describe("buildPosting — ad spend", () => {
  it("ads + claimable tax charged to a card balances; one that doesn't add up is refused", () => {
    const p = buildPosting("ad_spend", { platform: "facebook", debits: [{ accountId: A("Advertising"), amount: "10000" }, { accountId: A("Tax you can claim back"), amount: "500" }], credits: [{ accountId: "card", amount: "10500" }] }, ctx);
    expect(byAcc(p.lines)).toEqual({ [A("Advertising")]: 10000n, [A("Tax you can claim back")]: 500n, card: -10500n });
    expect(() => buildPosting("ad_spend", { debits: [{ accountId: A("Advertising"), amount: "10" }], credits: [{ accountId: "card", amount: "9" }] }, ctx)).toThrow(/taxes and charges/);
  });
});

describe("buildPosting — stock adjustments", () => {
  it("counted below the books: stock down, cost of what you sold up", () => {
    const p = buildPosting("stock_adjustment", { stock: A("Stock"), counter: A("Cost of what you sold"), amount: "-5000" }, ctx);
    expect(byAcc(p.lines)).toEqual({ [A("Stock")]: -5000n, [A("Cost of what you sold")]: 5000n });
  });
  it("counted above the books: stock up; first count can go to opening balances", () => {
    const p = buildPosting("stock_adjustment", { stock: A("Stock"), counter: ctx.system("opening_balance"), amount: "7000" }, ctx);
    expect(byAcc(p.lines)).toEqual({ [A("Stock")]: 7000n, [ctx.system("opening_balance")]: -7000n });
  });
  it("refuses a zero change, a non-stock account and a wrong other side", () => {
    expect(() => buildPosting("stock_adjustment", { stock: A("Stock"), counter: A("Cost of what you sold"), amount: "0" }, ctx)).toThrow(/already matches/);
    expect(() => buildPosting("stock_adjustment", { stock: "bank", counter: A("Cost of what you sold"), amount: "5" }, ctx)).toThrow(/isn't a stock account/);
    expect(() => buildPosting("stock_adjustment", { stock: A("Stock"), counter: A("Sales"), amount: "5" }, ctx)).toThrow(/can't take a stock adjustment/);
  });
});

describe("buildPosting — mistakes are refused with a plain message", () => {
  const cases: Array<[string, DocType, unknown, RegExp]> = [
    ["unbalanced manual entry", "manual", { lines: [{ accountId: A("Rent"), debit: "800" }, { accountId: "bank", credit: "700" }] }, /must be equal/],
    ["manual line with both sides", "manual", { lines: [{ accountId: A("Rent"), debit: "8", credit: "8" }, { accountId: "bank", credit: "0" }] }, /not both/],
    ["manual line with neither side", "manual", { lines: [{ accountId: A("Rent") }, { accountId: "bank", credit: "5" }] }, /debit or a credit/],
    ["expense paid from a non-money account", "expense", { paidFrom: A("Rent"), lines: [{ accountId: A("Packaging"), amount: "5" }] }, /isn't a bank/],
    ["expense to an income account", "expense", { paidFrom: "bank", lines: [{ accountId: A("Sales"), amount: "5" }] }, /can't be used for an expense/],
    ["archived account", "transfer", { from: "old", to: "bank", amount: "5" }, /archived/],
    ["same account twice", "transfer", { from: "bank", to: "bank", amount: "5" }, /two different/],
    ["zero amount", "transfer", { from: "bank", to: "cash", amount: "0" }, /Enter an amount/],
    ["negative amount", "owner_in", { to: "bank", amount: "-5" }, /Enter an amount/],
    ["huge amount", "owner_in", { to: "bank", amount: "1000000000000000" }, /too large/],
    ["unknown account", "owner_in", { to: "nope", amount: "5" }, /Choose an account/],
    ["opening on an expense account", "opening", { lines: [{ accountId: A("Rent"), amount: "5" }] }, /doesn't carry/],
    ["opening listing an account twice", "opening", { lines: [{ accountId: "bank", amount: "5" }, { accountId: "bank", amount: "5" }] }, /twice/],
    ["missing fields", "expense", { paidFrom: "bank" }, /missing/],
  ];
  it.each(cases)("%s", (_name, type, data, msg) => {
    expect(() => buildPosting(type, data, ctx)).toThrow(BooksError);
    expect(() => buildPosting(type, data, ctx)).toThrow(msg);
  });
});

/** Small deterministic PRNG so the randomized test is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("buildPosting — randomized invariants", () => {
  const rand = rng(20261008);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const amt = () => String(1 + Math.floor(rand() * 10_000_000));
  const money = ["bank", "cash", "card"];
  const expenses = CHART_TEMPLATE.filter((t) => t.type === "expense").map((t) => `acc_${t.code}`);
  const incomes = CHART_TEMPLATE.filter((t) => t.type === "income").map((t) => `acc_${t.code}`);
  const bsAccounts = [...money, ...CHART_TEMPLATE.filter((t) => ["asset", "liability", "equity"].includes(t.type) && t.systemKey !== "opening_balance").map((t) => `acc_${t.code}`)];
  // Foreign-currency accounts need a foreign amount; they have their own tests.
  const all = [...ctx.accounts.values()].filter((a) => !a.archived && !a.currency).map((a) => a.id);

  const purchaseTax = () => (rand() < 0.4 ? { accountId: rand() < 0.5 ? A("Tax you can claim back") : null, amount: amt(), name: "GST", rateBp: 1800 } : null);

  function randomDoc(): [DocType, unknown] {
    const type = pick<DocType>(["expense", "money_in", "transfer", "owner_in", "owner_out", "opening", "manual", "sales_summary", "courier_payout", "bill", "bill_payment", "stock_adjustment", "ad_spend", "gateway_payout", "tax_payment", "invoice", "customer_payment", "credit_note", "supplier_credit", "fx_revaluation", "parcel_writeoff", "returns_allowance", "production"]);
    const n = 1 + Math.floor(rand() * 4);
    switch (type) {
      case "expense": {
        const ls = Array.from({ length: n }, () => ({ accountId: pick(expenses), amount: amt(), tax: purchaseTax() }));
        return [type, { paidFrom: pick(money), lines: ls, withheld: rand() < 0.3 ? { accountId: A("Withholding tax to pay"), amount: "1" } : null }];
      }
      case "money_in":
        return [type, { receivedIn: pick(["bank", "cash"]), lines: Array.from({ length: n }, () => ({ accountId: pick(incomes), amount: amt(), tax: rand() < 0.4 ? { accountId: A("Sales tax to pay"), amount: amt(), name: "GST" } : null })) }];
      case "invoice":
        return [type, { receivable: A("Owed by customers"), lines: Array.from({ length: n }, () => ({ accountId: pick(incomes), amount: amt(), tax: rand() < 0.4 ? { accountId: A("Sales tax to pay"), amount: amt() } : null })) }];
      case "customer_payment":
        return [type, { receivable: A("Owed by customers"), receivedIn: pick(["bank", "cash"]), allocations: [{ billId: "i1", amount: amt() }], withheld: rand() < 0.3 ? { accountId: A("Tax you can claim back"), amount: "1" } : null }];
      case "credit_note":
        return [type, { receivable: A("Owed by customers"), lines: [{ accountId: pick(incomes), amount: amt() }], allocations: [] }];
      case "fx_revaluation":
        return [type, { account: "usdbank", gainsAccount: A("Other income"), adjustment: (rand() < 0.5 ? "-" : "") + amt() }];
      case "supplier_credit":
        return [type, { payable: A("Owed to suppliers"), lines: [{ accountId: pick(expenses), amount: amt(), tax: purchaseTax() }] }];
      case "tax_payment":
        return [type, { paidFrom: "bank", lines: [{ accountId: A("Sales tax to pay"), amount: amt() }, ...(rand() < 0.5 ? [{ accountId: A("Tax you can claim back"), amount: amt() }] : [])] }];
      case "transfer":
        return [type, { from: "bank", to: pick(["cash", "card"]), amount: amt() }];
      case "owner_in":
        return [type, { to: pick(money), amount: amt() }];
      case "owner_out":
        return [type, { from: pick(money), amount: amt() }];
      case "opening": {
        const accs = [...new Set(Array.from({ length: n }, () => pick(bsAccounts)))];
        return [type, { lines: accs.map((accountId) => ({ accountId, amount: (rand() < 0.2 ? "-" : "") + amt() })) }];
      }
      case "sales_summary": {
        const sales = BigInt(amt()), ship = BigInt(amt()), disc = sales / 10n;
        const cod = (sales + ship - disc) / 2n;
        return [type, { debits: [{ accountId: A("Owed by couriers"), amount: String(cod) }, { accountId: A("Owed by payment gateways"), amount: String(sales + ship - disc - cod) }, { accountId: A("Discounts given"), amount: String(disc) }], credits: [{ accountId: A("Sales"), amount: String(sales) }, { accountId: A("Shipping charged"), amount: String(ship) }] }];
      }
      case "courier_payout":
        return [type, { receivable: A("Owed by couriers"), receivedIn: pick(["bank", "cash"]), received: amt(), deductions: [{ accountId: A("Delivery charges"), amount: amt() }], others: rand() < 0.3 ? { accountId: A("Withholding tax to pay"), amount: amt() } : null }];
      case "production": {
        // (materials and finish need two stock accounts: the production DB test covers them)
        const step = pick(["cost", "waste"] as const);
        return [type, { batchId: "b1", step, wip: A("Stock"), other: step === "cost" ? pick(money) : pick(expenses), amount: amt() }];
      }
      case "returns_allowance":
        return [type, { month: "2026-09", returns: A("Returns"), allowance: A("Withholding tax to pay"), amount: (rand() < 0.5 ? "-" : "") + amt(), stockBack: A("Stock"), cogs: A("Cost of what you sold"), cost: rand() < 0.5 ? amt() : null }];
      case "parcel_writeoff": {
        const lost = rand() < 0.5;
        const parcels = Array.from({ length: n }, (_, i) => ({ orderId: `o${i}`, orderName: `#${i}`, amount: amt() }));
        return [type, { reason: lost ? "lost" : "short_paid", receivable: A("Owed by couriers"), account: lost ? A("Returns") : A("Delivery charges"), tax: lost && rand() < 0.5 ? { accountId: A("Sales tax to pay"), amount: "1" } : null, parcels }];
      }
      case "bill":
        return [type, { payable: A("Owed to suppliers"), lines: Array.from({ length: n }, () => ({ accountId: pick(expenses), amount: amt(), tax: purchaseTax() })) }];
      case "bill_payment":
        return [type, { payable: A("Owed to suppliers"), paidFrom: pick(money), allocations: [{ billId: "b1", amount: amt() }], withheld: rand() < 0.3 ? { accountId: A("Withholding tax to pay"), amount: "1" } : null }];
      case "gateway_payout":
        return [type, { receivable: A("Owed by payment gateways"), receivedIn: "bank", received: amt(), deductions: [{ accountId: A("Payment gateway fees"), amount: amt() }] }];
      case "ad_spend": {
        const spend = BigInt(amt()), fee = spend / 20n;
        return [type, { platform: "facebook", debits: [{ accountId: A("Advertising"), amount: String(spend) }, { accountId: A("Tax you can claim back"), amount: String(fee) }], credits: [{ accountId: "card", amount: String(spend + fee) }] }];
      }
      case "stock_adjustment":
        return [type, { stock: A("Stock"), counter: pick([A("Cost of what you sold"), A("Stock lost or damaged")]), amount: (rand() < 0.5 ? "-" : "") + amt() }];
      case "manual": {
        const debits = Array.from({ length: n }, () => BigInt(amt()));
        const total = debits.reduce((s, x) => s + x, 0n);
        return [type, { lines: [...debits.map((d) => ({ accountId: pick(all), debit: String(d) })), { accountId: pick(all), credit: String(total) }] }];
      }
    }
  }

  it("every posting of 2,000 random documents balances, and cancelling restores every balance", () => {
    const balances = new Map<string, bigint>();
    const apply = (ls: { accountId: string; amount: bigint }[]) =>
      ls.forEach((l) => balances.set(l.accountId, (balances.get(l.accountId) ?? 0n) + l.amount));
    const posted: { lines: { accountId: string; amount: bigint; contactId: string | null; description: string | null }[] }[] = [];

    for (let i = 0; i < 2000; i++) {
      const [type, data] = randomDoc();
      const p = buildPosting(type, data, ctx, "supplier-1");
      expect(sum(p.lines)).toBe(0n);
      expect(p.lines.length).toBeGreaterThanOrEqual(2);
      expect(p.total).toBe(p.lines.filter((l) => l.amount > 0n).reduce((s, l) => s + l.amount, 0n));
      apply(p.lines);
      posted.push(p);
    }
    expect([...balances.values()].reduce((s, x) => s + x, 0n)).toBe(0n);

    for (const p of posted) apply(mirrorLines(p.lines));
    expect([...balances.values()].every((v) => v === 0n)).toBe(true);
  });
});

describe("dates", () => {
  it("validates ISO dates", () => {
    expect(isIsoDate("2026-10-08")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("08/10/2026")).toBe(false);
  });

  it("dates a cancel with the original unless that day is closed", () => {
    expect(cancelDateFor("2026-10-05", null)).toBe("2026-10-05");
    expect(cancelDateFor("2026-10-05", "2026-09-30")).toBe("2026-10-05");
    expect(cancelDateFor("2026-09-15", "2026-09-30")).toBe("2026-10-01");
  });

  it("finds the fiscal year start (July)", () => {
    expect(fiscalYearStart("2026-10-08", 7)).toBe("2026-07-01");
    expect(fiscalYearStart("2026-03-01", 7)).toBe("2025-07-01");
    expect(fiscalYearStart("2026-07-01", 7)).toBe("2026-07-01");
    expect(fiscalYearStart("2026-03-01", 1)).toBe("2026-01-01");
  });
});

describe("tax", () => {
  const bank = "bank";
  it("claimable purchase tax gets its own line; tax you can't claim joins the cost", () => {
    const claim = buildPosting("expense", { paidFrom: bank, lines: [{ accountId: A("Packaging"), amount: "10000", tax: { accountId: A("Tax you can claim back"), amount: "1800", name: "GST 18%", rateBp: 1800 } }] }, ctx);
    expect(claim.lines.map((l) => [l.accountId, l.amount, l.description])).toEqual([
      [A("Packaging"), 10000n, null],
      [A("Tax you can claim back"), 1800n, "GST 18%"],
      [bank, -11800n, null],
    ]);
    const cost = buildPosting("bill", { payable: A("Owed to suppliers"), lines: [{ accountId: A("Packaging"), amount: "10000", tax: { accountId: null, amount: "1800" } }] }, ctx, "s1");
    expect(cost.lines.map((l) => [l.accountId, l.amount])).toEqual([
      [A("Packaging"), 11800n],
      [A("Owed to suppliers"), -11800n],
    ]);
    expect(cost.total).toBe(11800n);
    expect(() => buildPosting("expense", { paidFrom: bank, lines: [{ accountId: A("Packaging"), amount: "1", tax: { accountId: A("Sales tax to pay"), amount: "1" } }] }, ctx)).toThrow(/isn't a tax account you can claim from/);
  });

  it("tax charged on money in goes to tax you owe", () => {
    const p = buildPosting("money_in", { receivedIn: bank, lines: [{ accountId: A("Other income"), amount: "5000", tax: { accountId: A("Sales tax to pay"), amount: "900", name: "GST" } }] }, ctx);
    expect(p.lines.map((l) => [l.accountId, l.amount])).toEqual([
      [bank, 5900n],
      [A("Other income"), -5000n],
      [A("Sales tax to pay"), -900n],
    ]);
    expect(() => buildPosting("money_in", { receivedIn: bank, lines: [{ accountId: A("Other income"), amount: "5000", tax: { accountId: null, amount: "900" } }] }, ctx)).toThrow(/where the tax you charged goes/);
    expect(() => buildPosting("money_in", { receivedIn: bank, lines: [{ accountId: A("Other income"), amount: "5000", tax: { accountId: A("Tax you can claim back"), amount: "900" } }] }, ctx)).toThrow(/isn't a tax account you owe/);
  });

  it("withholding: the supplier's debt clears in full, the bank pays less, the rest is owed to the tax office", () => {
    const p = buildPosting("bill_payment", { payable: A("Owed to suppliers"), paidFrom: bank, allocations: [{ billId: "b1", amount: "100000" }], withheld: { accountId: A("Withholding tax to pay"), amount: "4500", name: "WHT 4.5%" } }, ctx, "s1");
    expect(p.lines.map((l) => [l.accountId, l.amount])).toEqual([
      [A("Owed to suppliers"), 100000n],
      [A("Withholding tax to pay"), -4500n],
      [bank, -95500n],
    ]);
    const e = buildPosting("expense", { paidFrom: bank, lines: [{ accountId: A("Rent"), amount: "50000" }], withheld: { accountId: A("Withholding tax to pay"), amount: "5000" } }, ctx);
    expect(e.lines.find((l) => l.accountId === bank)!.amount).toBe(-45000n);
    expect(() => buildPosting("expense", { paidFrom: bank, lines: [{ accountId: A("Rent"), amount: "100" }], withheld: { accountId: A("Withholding tax to pay"), amount: "101" } }, ctx)).toThrow(/more than the payment/);
    expect(() => buildPosting("expense", { paidFrom: bank, lines: [{ accountId: A("Rent"), amount: "100" }], withheld: { accountId: A("Tax you can claim back"), amount: "1" } }, ctx)).toThrow(/tax account you owe/);
    // Nothing withheld is the same as no withholding.
    expect(buildPosting("expense", { paidFrom: bank, lines: [{ accountId: A("Rent"), amount: "100" }], withheld: { accountId: A("Withholding tax to pay"), amount: "0" } }, ctx).lines).toHaveLength(2);
  });

  it("tax paid: settles what's owed, uses up what's claimable, and handles refunds", () => {
    const p = buildPosting("tax_payment", { paidFrom: bank, lines: [{ accountId: A("Sales tax to pay"), amount: "18000" }, { accountId: A("Tax you can claim back"), amount: "5000" }] }, ctx);
    expect(p.lines.map((l) => [l.accountId, l.amount])).toEqual([
      [A("Sales tax to pay"), 18000n],
      [A("Tax you can claim back"), -5000n],
      [bank, -13000n],
    ]);
    const refund = buildPosting("tax_payment", { paidFrom: bank, lines: [{ accountId: A("Sales tax to pay"), amount: "1000" }, { accountId: A("Tax you can claim back"), amount: "4000" }] }, ctx);
    expect(refund.lines.find((l) => l.accountId === bank)!.amount).toBe(3000n);
    // Claimable tax exactly used up against tax owed: no money moves, still a valid entry.
    expect(buildPosting("tax_payment", { paidFrom: bank, lines: [{ accountId: A("Sales tax to pay"), amount: "1000" }, { accountId: A("Tax you can claim back"), amount: "1000" }] }, ctx).lines).toHaveLength(2);
    expect(() => buildPosting("tax_payment", { paidFrom: bank, lines: [{ accountId: A("Rent"), amount: "1" }] }, ctx)).toThrow(/isn't a tax account/);
    expect(() => buildPosting("tax_payment", { paidFrom: bank, lines: [{ accountId: A("Sales tax to pay"), amount: "1" }, { accountId: A("Sales tax to pay"), amount: "1" }] }, ctx)).toThrow(/listed twice/);
  });

  it("documents saved before tax existed post exactly as before", () => {
    const old = buildPosting("bill", { payable: A("Owed to suppliers"), lines: [{ accountId: A("Packaging"), amount: "700" }] }, ctx, "s1");
    expect(old.lines.map((l) => l.amount)).toEqual([700n, -700n]);
  });
});

describe("selling on credit", () => {
  const rec = A("Owed by customers");
  it("an invoice: the customer owes sales plus tax", () => {
    const p = buildPosting("invoice", { receivable: rec, dueDate: "2026-11-30", lines: [{ accountId: A("Sales"), amount: "10000", quantity: "2", unitPrice: "5000", tax: { accountId: A("Sales tax to pay"), amount: "1800", name: "GST" } }] }, ctx, "c1");
    expect(p.lines.map((l) => [l.accountId, l.amount, l.contactId])).toEqual([
      [rec, 11800n, "c1"],
      [A("Sales"), -10000n, "c1"],
      [A("Sales tax to pay"), -1800n, "c1"],
    ]);
    expect(() => buildPosting("invoice", { receivable: rec, lines: [{ accountId: A("Sales"), amount: "1" }] }, ctx)).toThrow(/Choose the customer/);
    expect(() => buildPosting("invoice", { receivable: A("Owed to suppliers"), lines: [{ accountId: A("Sales"), amount: "1" }] }, ctx, "c1")).toThrow(/isn't an "owed to you" account/);
    expect(() => buildPosting("invoice", { receivable: rec, lines: [{ accountId: A("Rent"), amount: "1" }] }, ctx, "c1")).toThrow(/can't be used on an invoice/);
    expect(() => buildPosting("invoice", { receivable: rec, lines: [{ accountId: A("Sales"), amount: "1", quantity: "1.2345" }] }, ctx, "c1")).toThrow();
  });
  it("a customer payment, with tax they withheld becoming claimable", () => {
    const p = buildPosting("customer_payment", { receivable: rec, receivedIn: "bank", allocations: [{ billId: "i1", amount: "11800" }], withheld: { accountId: A("Tax you can claim back"), amount: "531" } }, ctx, "c1");
    expect(p.lines.map((l) => [l.accountId, l.amount])).toEqual([
      ["bank", 11269n],
      [A("Tax you can claim back"), 531n],
      [rec, -11800n],
    ]);
    expect(() => buildPosting("customer_payment", { receivable: rec, receivedIn: "bank", allocations: [{ billId: "i1", amount: "1" }, { billId: "i1", amount: "1" }] }, ctx, "c1")).toThrow(/listed twice/);
    expect(() => buildPosting("customer_payment", { receivable: rec, receivedIn: "bank", allocations: [{ billId: "i1", amount: "10" }], withheld: { accountId: A("Withholding tax to pay"), amount: "1" } }, ctx, "c1")).toThrow(/claim from/);
  });
  it("a credit note takes sales and tax back off what the customer owes", () => {
    const p = buildPosting("credit_note", { receivable: rec, lines: [{ accountId: A("Returns"), amount: "1000", tax: { accountId: A("Sales tax to pay"), amount: "180" } }], allocations: [{ billId: "i1", amount: "1180" }] }, ctx, "c1");
    expect(p.lines.map((l) => [l.accountId, l.amount])).toEqual([
      [A("Returns"), 1000n],
      [A("Sales tax to pay"), 180n],
      [rec, -1180n],
    ]);
    expect(() => buildPosting("credit_note", { receivable: rec, lines: [{ accountId: A("Returns"), amount: "1000" }], allocations: [{ billId: "i1", amount: "1001" }] }, ctx, "c1")).toThrow(/more against invoices/);
  });
});

describe("supplier credit", () => {
  it("takes the cost (and claimable tax) back off what you owe", () => {
    const p = buildPosting("supplier_credit", { payable: A("Owed to suppliers"), lines: [{ accountId: A("Packaging"), amount: "1000", tax: { accountId: A("Tax you can claim back"), amount: "180" } }], allocations: [{ billId: "b1", amount: "1180" }] }, ctx, "s1");
    expect(p.lines.map((l) => [l.accountId, l.amount])).toEqual([
      [A("Owed to suppliers"), 1180n],
      [A("Packaging"), -1000n],
      [A("Tax you can claim back"), -180n],
    ]);
    expect(() => buildPosting("supplier_credit", { payable: A("Owed to suppliers"), lines: [{ accountId: A("Packaging"), amount: "10" }], allocations: [{ billId: "b1", amount: "11" }] }, ctx, "s1")).toThrow(/more against bills/);
    expect(() => buildPosting("supplier_credit", { payable: A("Owed to suppliers"), lines: [{ accountId: A("Packaging"), amount: "10" }] }, ctx)).toThrow(/Choose the supplier/);
  });
});

describe("foreign currency", () => {
  it("lines on a foreign account carry its amount, with the line's sign", () => {
    const p = buildPosting("expense", { paidFrom: "usdcard", lines: [{ accountId: A("Advertising"), amount: "28000" }], fx: { usdcard: { amount: "10000" } } }, ctx);
    expect(p.lines.map((l) => [l.accountId, l.amount, l.fxAmount ?? null])).toEqual([
      [A("Advertising"), 28000n, null],
      ["usdcard", -28000n, -10000n],
    ]);
    // Mirrored on cancel.
    expect(mirrorLines(p.lines)[1]).toMatchObject({ amount: 28000n, fxAmount: 10000n });
  });
  it("a foreign amount is required, and a foreign account appears once", () => {
    expect(() => buildPosting("expense", { paidFrom: "usdcard", lines: [{ accountId: A("Advertising"), amount: "1" }] }, ctx)).toThrow(/amount in USD/);
    expect(() => buildPosting("expense", { paidFrom: "usdcard", lines: [{ accountId: A("Advertising"), amount: "1" }], fx: { usdcard: { amount: "0" } } }, ctx)).toThrow(/amount in USD/);
    expect(() =>
      buildPosting("manual", { lines: [{ accountId: "usdbank", debit: "5" }, { accountId: "usdbank", debit: "5" }, { accountId: "bank", credit: "10" }], fx: { usdbank: { amount: "1" } } }, ctx),
    ).toThrow(/one line only/);
  });
  it("a transfer between currencies keeps both sides' own amounts", () => {
    expect(() => buildPosting("transfer", { from: "bank", to: "usdbank", amount: "280000" }, ctx)).toThrow(/amount in USD/);
    const q = buildPosting("transfer", { from: "bank", to: "usdbank", amount: "280000", fx: { usdbank: { amount: "1000" } } }, ctx);
    expect(q.lines.find((l) => l.accountId === "usdbank")).toMatchObject({ amount: 280000n, fxAmount: 1000n });
    expect(q.lines.find((l) => l.accountId === "bank")!.fxAmount ?? null).toBeNull();
  });
  it("revaluation moves only the book value, against exchange gains or losses", () => {
    const p = buildPosting("fx_revaluation", { account: "usdbank", gainsAccount: A("Other income"), adjustment: "-500", rate: "279.5" }, ctx);
    expect(p.lines.map((l) => [l.accountId, l.amount, l.fxAmount ?? null])).toEqual([
      ["usdbank", -500n, 0n],
      [A("Other income"), 500n, null],
    ]);
    expect(() => buildPosting("fx_revaluation", { account: "bank", gainsAccount: A("Other income"), adjustment: "1" }, ctx)).toThrow(/book's own currency/);
    expect(() => buildPosting("fx_revaluation", { account: "usdbank", gainsAccount: A("Other income"), adjustment: "0" }, ctx)).toThrow(/nothing to revalue/);
  });
});
