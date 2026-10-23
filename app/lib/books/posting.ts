/**
 * The Books posting engine. Pure: a document's data in, journal lines out.
 *
 * Nothing here touches the database, the clock or the network, so every rule
 * is unit-tested directly (see __tests__/posting.test.ts). The service layer
 * loads the accounts, calls `buildPosting`, and writes what comes back inside
 * one transaction; a Postgres trigger re-checks the balance at commit.
 *
 * Amounts are signed minor units: + debit, − credit. Every posting sums to 0.
 */

import { z } from "zod";
import { isMoneySubtype, type AccountType, type SystemKey } from "./chart";
import { minorFromString } from "./money";
import { MAX_RATE_BP } from "./tax";

export const DOC_TYPES = ["expense", "money_in", "transfer", "owner_in", "owner_out", "opening", "manual", "sales_summary", "courier_payout", "bill", "bill_payment", "stock_adjustment", "ad_spend", "gateway_payout", "tax_payment", "invoice", "customer_payment", "credit_note", "supplier_credit", "fx_revaluation", "parcel_writeoff", "returns_allowance", "production"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export function isDocType(s: string): s is DocType {
  return (DOC_TYPES as readonly string[]).includes(s);
}

/** Number prefix per type; numbers are gapless per prefix (EXP-0001). */
export const DOC_PREFIX: Record<DocType, string> = {
  expense: "EXP",
  money_in: "MIN",
  transfer: "TRF",
  owner_in: "OIN",
  owner_out: "OUT",
  opening: "OPN",
  manual: "JNL",
  sales_summary: "SAL",
  courier_payout: "CPY",
  bill: "BIL",
  bill_payment: "PAY",
  stock_adjustment: "ADJ",
  ad_spend: "ADS",
  gateway_payout: "GPY",
  tax_payment: "TAX",
  invoice: "INV",
  customer_payment: "RCV",
  credit_note: "CRN",
  supplier_credit: "SCR",
  fx_revaluation: "FXR",
  parcel_writeoff: "PWO",
  returns_allowance: "RAL",
  production: "PRD",
};

/** What owners see. */
export const DOC_LABELS: Record<DocType, string> = {
  expense: "Expense",
  money_in: "Money in",
  transfer: "Money moved",
  owner_in: "Owner put money in",
  owner_out: "Owner took money out",
  opening: "Opening balances",
  manual: "Journal voucher",
  sales_summary: "Sales",
  courier_payout: "Courier paid me",
  bill: "Bill",
  bill_payment: "Bill payment",
  stock_adjustment: "Stock adjustment",
  ad_spend: "Ad spend",
  gateway_payout: "Gateway paid me",
  tax_payment: "Tax paid",
  invoice: "Invoice",
  customer_payment: "Customer payment",
  credit_note: "Credit note",
  supplier_credit: "Supplier credit",
  fx_revaluation: "Currency revaluation",
  parcel_writeoff: "Parcels written off",
  returns_allowance: "Expected returns",
  production: "Production",
};

export class BooksError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "BooksError";
  }
}

/** Biggest amount accepted: 10^15 minor units (10 trillion with 2 decimals). */
const MAX_AMOUNT = 10n ** 15n;

// ── Document data as stored in BkDocument.data (amounts are minor-unit strings) ──

const id = z.string().min(1);
const amountStr = z.string().regex(/^\d+$/, "Enter an amount");
const signedAmountStr = z.string().regex(/^-?\d+$/, "Enter an amount");
const desc = z.string().max(500).optional().nullable();

/**
 * Tax on a line, stored with the line (name, rate and account as they were
 * when it was entered) so changing a rate later never changes old entries.
 * The line's own amount is before tax.
 */
const lineTax = z
  .object({
    rateId: z.string().max(100).optional().nullable(),
    name: z.string().max(100).optional().nullable(),
    rateBp: z.number().int().min(0).max(MAX_RATE_BP).optional().nullable(),
    accountId: z.string().optional().nullable(),
    amount: amountStr,
  })
  .optional()
  .nullable();

/** Tax kept back from a payment and owed to the tax office on the supplier's behalf. */
const withheld = z
  .object({
    accountId: id,
    amount: amountStr,
    rateId: z.string().max(100).optional().nullable(),
    name: z.string().max(100).optional().nullable(),
    rateBp: z.number().int().min(0).max(MAX_RATE_BP).optional().nullable(),
  })
  .optional()
  .nullable();

const amountLine = z.object({ accountId: id, amount: amountStr, description: desc, tax: lineTax });

export const DOC_SCHEMAS = {
  expense: z.object({ paidFrom: id, lines: z.array(amountLine).min(1).max(100), withheld }),
  money_in: z.object({ receivedIn: id, lines: z.array(amountLine).min(1).max(100) }),
  transfer: z.object({ from: id, to: id, amount: amountStr }),
  owner_in: z.object({ to: id, amount: amountStr }),
  owner_out: z.object({ from: id, amount: amountStr }),
  opening: z.object({
    lines: z.array(z.object({ accountId: id, amount: signedAmountStr, description: desc })).min(1).max(500),
  }),
  manual: z.object({
    lines: z
      .array(
        z.object({
          accountId: id,
          debit: amountStr.optional().nullable(),
          credit: amountStr.optional().nullable(),
          description: desc,
          contactId: z.string().optional().nullable(),
        }),
      )
      .min(2)
      .max(500),
  }),
  /**
   * A day's (or any period's) sales. Credits: sales, shipping charged, tax
   * collected. Debits: discounts, returns, and what customers owe by how they
   * paid (couriers for COD, gateways for prepaid). Built by the Shopify
   * connector or typed in; either way debits must equal credits.
   */
  sales_summary: z.object({
    debits: z.array(z.object({ accountId: id, amount: amountStr, description: desc, contactId: z.string().optional().nullable() })).max(200),
    credits: z.array(z.object({ accountId: id, amount: amountStr, description: desc, contactId: z.string().optional().nullable() })).max(200),
  }),
  /** A day's ad spend on one platform, with its taxes and charges (built by the ad spend connector). */
  ad_spend: z.object({
    platform: z.string().max(40).optional().nullable(),
    debits: z.array(z.object({ accountId: id, amount: amountStr, description: desc, contactId: z.string().optional().nullable() })).max(200),
    credits: z.array(z.object({ accountId: id, amount: amountStr, description: desc, contactId: z.string().optional().nullable() })).max(200),
  }),
  /** A courier paid out COD money: what reached the bank plus what they kept. */
  courier_payout: z.object({
    receivable: id,
    receivedIn: id,
    // Signed: a courier invoice (charges only) arrives as money going out, and a
    // carry-forward can hand money back. Screens only ever send positive amounts.
    received: signedAmountStr,
    deductions: z.array(z.object({ accountId: id, amount: signedAmountStr, description: desc })).max(40),
    /** Money in this payout for parcels that aren't orders in these books (another store, before Books started). */
    others: z.object({ accountId: id, amount: signedAmountStr }).optional().nullable(),
  }),
  /** A payment gateway paid out prepaid orders: what reached the bank plus its fees and any tax kept. */
  gateway_payout: z.object({
    receivable: id,
    receivedIn: id,
    // Signed: a courier invoice (charges only) arrives as money going out, and a
    // carry-forward can hand money back. Screens only ever send positive amounts.
    received: signedAmountStr,
    deductions: z.array(z.object({ accountId: id, amount: signedAmountStr, description: desc })).max(40),
  }),
  /** What a supplier charged, to pay later. The supplier is the document's contact. */
  bill: z.object({
    payable: id,
    dueDate: z.string().optional().nullable(),
    reference: z.string().max(100).optional().nullable(),
    /** Brought forward from before Books: the line is the opening balance adjustment, not a cost or sale. */
    opening: z.boolean().optional().nullable(),
    lines: z.array(amountLine).min(1).max(100),
  }),
  /** Paying one or more bills of one supplier. Which bills, and how much, is checked against the books when saved. */
  bill_payment: z.object({
    payable: id,
    paidFrom: id,
    allocations: z.array(z.object({ billId: id, amount: amountStr })).min(1).max(200),
    withheld,
  }),
  /**
   * Selling on credit: what a customer owes you. The customer is the
   * document's contact. Lines are before tax; quantity and unit price are
   * kept for the printed invoice only.
   */
  invoice: z.object({
    receivable: id,
    dueDate: z.string().optional().nullable(),
    reference: z.string().max(100).optional().nullable(),
    /** Brought forward from before Books: the line is the opening balance adjustment, not a cost or sale. */
    opening: z.boolean().optional().nullable(),
    lines: z
      .array(
        amountLine.extend({
          quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/).optional().nullable(),
          unitPrice: amountStr.optional().nullable(),
        }),
      )
      .min(1)
      .max(100),
  }),
  /** A customer paying one or more invoices. Tax they withheld from you is claimable. */
  customer_payment: z.object({
    receivable: id,
    receivedIn: id,
    allocations: z.array(z.object({ billId: id, amount: amountStr })).min(1).max(200),
    withheld,
  }),
  /**
   * Money taken off what a customer owes (a return, a discount after the
   * fact). Can be set against their invoices now or later.
   */
  credit_note: z.object({
    receivable: id,
    reference: z.string().max(100).optional().nullable(),
    /** Brought forward from before Books: the line is the opening balance adjustment, not a cost or sale. */
    opening: z.boolean().optional().nullable(),
    lines: z.array(amountLine).min(1).max(100),
    allocations: z.array(z.object({ billId: id, amount: amountStr })).max(200).optional().nullable(),
  }),
  /**
   * Money a supplier takes off what you owe (goods sent back, a discount
   * after the bill). Set against their bills now or later.
   */
  supplier_credit: z.object({
    payable: id,
    reference: z.string().max(100).optional().nullable(),
    /** Brought forward from before Books: the line is the opening balance adjustment, not a cost or sale. */
    opening: z.boolean().optional().nullable(),
    lines: z.array(amountLine).min(1).max(100),
    allocations: z.array(z.object({ billId: id, amount: amountStr })).max(200).optional().nullable(),
  }),
  /**
   * Bring a foreign-currency account's value in the book's currency to a
   * rate on a date. Only the book value moves; the foreign balance doesn't.
   */
  fx_revaluation: z.object({
    account: id,
    gainsAccount: id,
    adjustment: signedAmountStr,
    rate: z.string().regex(/^\d{1,9}(\.\d{1,8})?$/).optional().nullable(),
    foreignBalance: signedAmountStr.optional().nullable(),
    bookBalanceBefore: signedAmountStr.optional().nullable(),
  }),
  /**
   * Paying tax to (or getting a refund from) the tax office. Each line settles
   * a tax account: tax owed (a liability) is paid off; claimable tax (an
   * asset) is set against it. The money moves by the difference.
   */
  tax_payment: z.object({
    paidFrom: id,
    lines: z.array(z.object({ accountId: id, amount: amountStr, description: desc })).min(1).max(20),
  }),
  /**
   * Bring the Stock account to a counted (or Shopify) value. `amount` is the
   * change to stock (+ more than the books, − less); the other side is the
   * cost of what you sold, stock losses, or (first count) opening balances.
   */
  stock_adjustment: z.object({
    stock: id,
    counter: id,
    amount: signedAmountStr,
    // Growzar (v1.1 V4): "inventorify", a check against Inventorify's stock.
    method: z.enum(["shopify", "count", "damaged", "inventorify"]).optional().nullable(),
    /** For a damaged return: the order it came back from. */
    orderName: z.string().max(100).optional().nullable(),
    countedValue: signedAmountStr.optional().nullable(),
    booksValue: signedAmountStr.optional().nullable(),
    pendingValue: signedAmountStr.optional().nullable(),
  }),
  /**
   * Cash-on-delivery parcels the courier will never pay for. Lost: the sale
   * didn't happen, so it comes off sales (and its tax) — the goods are gone,
   * so their cost stays. Paid short: the gap is a cost of its own.
   */
  parcel_writeoff: z.object({
    reason: z.enum(["lost", "short_paid"]),
    receivable: id,
    account: id,
    tax: z.object({ accountId: id, amount: amountStr }).optional().nullable(),
    parcels: z.array(z.object({ orderId: z.string().min(1).max(100), orderName: z.string().max(100), amount: amountStr })).min(1).max(500),
  }),
  /**
   * Month end: sales on parcels still out that are expected to come back
   * (and their stock). `amount`/`cost` are signed: the reversal on the 1st
   * of the next month is the same entry with both negated.
   */
  returns_allowance: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    returns: id,
    allowance: id,
    amount: signedAmountStr,
    stockBack: id.optional().nullable(),
    cogs: id.optional().nullable(),
    cost: signedAmountStr.optional().nullable(),
    reverses: z.string().max(64).optional().nullable(),
    basis: z.object({ known: amountStr, open: amountStr, rateBp: z.number().int().min(0).max(10000) }).optional().nullable(),
  }),
  /**
   * A step in a production batch (the batch's number is its tag):
   *  materials  raw materials used:          Dr work in progress / Cr the materials account
   *  cost       stitching, labour, freight…: Dr work in progress / Cr money paid, or owed to a supplier
   *  finish     units made:                  Dr finished stock    / Cr work in progress
   *  waste      spoiled, rejected:           Dr a cost            / Cr work in progress
   */
  production: z.object({
    batchId: z.string().min(1).max(64),
    step: z.enum(["materials", "cost", "finish", "waste"]),
    wip: id,
    other: id,
    amount: amountStr,
    units: z.number().int().min(0).max(100_000_000).optional().nullable(),
    final: z.boolean().optional().nullable(),
  }),
} satisfies Record<DocType, z.ZodTypeAny>;

export type DocData<T extends DocType> = z.infer<(typeof DOC_SCHEMAS)[T]>;

export interface AccountInfo {
  id: string;
  name: string;
  type: AccountType;
  subtype: string;
  systemKey: SystemKey | string | null;
  archived: boolean;
  /** A foreign-currency money account's currency. */
  currency?: string | null;
}

export interface PostingContext {
  accounts: Map<string, AccountInfo>;
  /** Id of a system account. Throws if the book lacks it (a setup bug). */
  system(key: SystemKey): string;
}

export interface PostingLine {
  accountId: string;
  amount: bigint;
  contactId: string | null;
  description: string | null;
  /** Lines on a foreign-currency account: the amount in its currency, same sign as `amount`. */
  fxAmount?: bigint | null;
}

export interface Posting {
  lines: PostingLine[];
  /** Sum of debits, for lists and the document header. */
  total: bigint;
}

/** Parse and validate stored data for a type. Throws BooksError with a plain message. */
export function parseDocData<T extends DocType>(type: T, data: unknown): DocData<T> {
  const res = DOC_SCHEMAS[type].safeParse(data);
  if (!res.success) {
    const issue = res.error.issues[0];
    // Growzar runs zod 4, which words a missing field "Invalid input: expected …, received undefined" (zod 3 said "Required").
    const missing = !issue?.message || issue.message === "Required" || (issue.code === "invalid_type" && /received undefined$/.test(issue.message));
    throw new BooksError(missing ? "Some details are missing" : issue.message, issue?.path.join("."));
  }
  return res.data as DocData<T>;
}

function amount(s: string, field: string): bigint {
  const v = minorFromString(s);
  if (v === null) throw new BooksError("Enter an amount", field);
  if (v < 0n) throw new BooksError("Amounts can't be negative", field);
  if (v >= MAX_AMOUNT) throw new BooksError("That amount is too large", field);
  return v;
}

/** A signed amount (courier invoices, carry-forwards). */
function signed(s: string, field: string): bigint {
  const v = minorFromString(s);
  if (v === null) throw new BooksError("Enter an amount", field);
  if (v >= MAX_AMOUNT || -v >= MAX_AMOUNT) throw new BooksError("That amount is too large", field);
  return v;
}

function account(ctx: PostingContext, accountId: string, field: string): AccountInfo {
  const a = ctx.accounts.get(accountId);
  if (!a) throw new BooksError("Choose an account", field);
  if (a.archived) throw new BooksError(`"${a.name}" is archived. Choose another account.`, field);
  return a;
}

function moneyAccount(ctx: PostingContext, accountId: string, field: string): AccountInfo {
  const a = account(ctx, accountId, field);
  if (!isMoneySubtype(a.subtype)) throw new BooksError(`"${a.name}" isn't a bank, cash or wallet account`, field);
  return a;
}

function line(accountId: string, amt: bigint, contactId: string | null, description?: string | null): PostingLine {
  return { accountId, amount: amt, contactId, description: description?.trim() || null };
}

function isTaxAccount(a: AccountInfo, type: "asset" | "liability"): boolean {
  return a.type === type && a.subtype === "tax";
}

/**
 * Lines for a cost (expense or bill line) with the tax paid on it: claimable
 * tax goes to its own "tax you can claim" line; tax you can't claim is added
 * to the cost. Returns the lines' total (cost + tax).
 */
function costWithTax(ctx: PostingContext, lines: PostingLine[], costAccount: string, net: bigint, tax: z.infer<typeof lineTax>, contactId: string | null, description: string | null | undefined, field: string, sign: 1n | -1n = 1n): bigint {
  const tv = tax ? amount(tax.amount, `${field}.tax.amount`) : 0n;
  if (tv > 0n && tax?.accountId) {
    const ta = account(ctx, tax.accountId, `${field}.tax.accountId`);
    if (!isTaxAccount(ta, "asset")) throw new BooksError(`"${ta.name}" isn't a tax account you can claim from`, `${field}.tax.accountId`);
    lines.push(line(costAccount, sign * net, contactId, description));
    lines.push(line(ta.id, sign * tv, contactId, tax.name || "Tax"));
  } else {
    lines.push(line(costAccount, sign * (net + tv), contactId, description));
  }
  return net + tv;
}

function receivableAccount(ctx: PostingContext, accountId: string): AccountInfo {
  const a = account(ctx, accountId, "receivable");
  if (!(a.type === "asset" && a.subtype === "receivable")) throw new BooksError(`"${a.name}" isn't an "owed to you" account`, "receivable");
  return a;
}

/** Income lines with the tax charged on them, signed by `sign` (−1 sells, +1 takes back). Returns net + tax. */
function salesLines(ctx: PostingContext, lines: PostingLine[], ls: Array<{ accountId: string; amount: string; description?: string | null; tax?: z.infer<typeof lineTax> }>, sign: 1n | -1n, contactId: string | null, what: string): bigint {
  let sum = 0n;
  ls.forEach((l, i) => {
    const a = account(ctx, l.accountId, `lines.${i}.accountId`);
    if (a.type !== "income") throw new BooksError(`"${a.name}" can't be used on ${what}`, `lines.${i}.accountId`);
    const v = amount(l.amount, `lines.${i}.amount`);
    sum += v;
    lines.push(line(a.id, sign * v, contactId, l.description));
    const tv = l.tax ? amount(l.tax.amount, `lines.${i}.tax.amount`) : 0n;
    if (tv > 0n) {
      if (!l.tax?.accountId) throw new BooksError("Choose where the tax you charged goes", `lines.${i}.tax.accountId`);
      const ta = account(ctx, l.tax.accountId, `lines.${i}.tax.accountId`);
      if (!isTaxAccount(ta, "liability")) throw new BooksError(`"${ta.name}" isn't a tax account you owe`, `lines.${i}.tax.accountId`);
      sum += tv;
      lines.push(line(ta.id, sign * tv, contactId, l.tax.name || "Tax"));
    }
  });
  return sum;
}

/**
 * An opening bill, invoice or credit: what was owed before Books, set against
 * the opening balance adjustment. No tax — it was booked before Books.
 */
function openingLines(ctx: PostingContext, lines: PostingLine[], ls: Array<{ accountId: string; amount: string; description?: string | null; tax?: unknown }>, sign: 1n | -1n, contactId: string | null): bigint {
  const balancing = ctx.system("opening_balance");
  let sum = 0n;
  ls.forEach((l, i) => {
    if (l.accountId !== balancing) throw new BooksError("An opening balance goes to the opening balance adjustment", `lines.${i}.accountId`);
    if (l.tax) throw new BooksError("An opening balance has no tax — enter what was owed, tax included", `lines.${i}.tax`);
    const v = amount(l.amount, `lines.${i}.amount`);
    sum += v;
    lines.push(line(balancing, sign * v, contactId, l.description));
  });
  return sum;
}

function allocationTotal(allocs: Array<{ billId: string; amount: string }>, what: string): bigint {
  const seen = new Set<string>();
  let sum = 0n;
  allocs.forEach((a, i) => {
    if (seen.has(a.billId)) throw new BooksError(`The same ${what} is listed twice`, `allocations.${i}.billId`);
    seen.add(a.billId);
    sum += amount(a.amount, `allocations.${i}.amount`);
  });
  return sum;
}

/** The withheld-tax line on a payment; returns what was withheld (0 when nothing). */
function withheldLine(ctx: PostingContext, lines: PostingLine[], w: z.infer<typeof withheld>, paid: bigint, contactId: string | null): bigint {
  if (!w) return 0n;
  const v = amount(w.amount, "withheld.amount");
  if (v === 0n) return 0n;
  const a = account(ctx, w.accountId, "withheld.accountId");
  if (!isTaxAccount(a, "liability")) throw new BooksError(`"${a.name}" isn't a tax account you owe`, "withheld.accountId");
  if (v > paid) throw new BooksError("You can't withhold more than the payment", "withheld.amount");
  lines.push(line(a.id, -v, contactId, w.name || "Tax withheld"));
  return v;
}

/**
 * Turn a document into balanced journal lines.
 *
 * `contactId` is the document's contact; it is copied onto the lines that
 * represent the dealing with that contact so a contact's statement can be
 * read straight from entry lines.
 */
export function buildPosting(type: DocType, rawData: unknown, ctx: PostingContext, contactId: string | null = null): Posting {
  const lines: PostingLine[] = [];

  switch (type) {
    case "expense": {
      const d = parseDocData("expense", rawData);
      const from = moneyAccount(ctx, d.paidFrom, "paidFrom");
      let sum = 0n;
      d.lines.forEach((l, i) => {
        const a = account(ctx, l.accountId, `lines.${i}.accountId`);
        if (a.id === from.id) throw new BooksError("An expense can't be paid to the account it's paid from", `lines.${i}.accountId`);
        if (!(a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype)))) {
          throw new BooksError(`"${a.name}" can't be used for an expense`, `lines.${i}.accountId`);
        }
        sum += costWithTax(ctx, lines, a.id, amount(l.amount, `lines.${i}.amount`), l.tax, contactId, l.description, `lines.${i}`);
      });
      const kept = withheldLine(ctx, lines, d.withheld, sum, contactId);
      lines.push(line(from.id, -(sum - kept), contactId, null));
      break;
    }

    case "money_in": {
      const d = parseDocData("money_in", rawData);
      const into = moneyAccount(ctx, d.receivedIn, "receivedIn");
      let sum = 0n;
      d.lines.forEach((l, i) => {
        const a = account(ctx, l.accountId, `lines.${i}.accountId`);
        if (a.id === into.id) throw new BooksError("Money can't come from the account it goes into", `lines.${i}.accountId`);
        if (a.type === "expense" || a.type === "equity" || isMoneySubtype(a.subtype)) {
          throw new BooksError(`"${a.name}" can't be used for money in`, `lines.${i}.accountId`);
        }
        const v = amount(l.amount, `lines.${i}.amount`);
        sum += v;
        lines.push(line(a.id, -v, contactId, l.description));
        const tv = l.tax ? amount(l.tax.amount, `lines.${i}.tax.amount`) : 0n;
        if (tv > 0n) {
          if (!l.tax?.accountId) throw new BooksError("Choose where the tax you charged goes", `lines.${i}.tax.accountId`);
          const ta = account(ctx, l.tax.accountId, `lines.${i}.tax.accountId`);
          if (!isTaxAccount(ta, "liability")) throw new BooksError(`"${ta.name}" isn't a tax account you owe`, `lines.${i}.tax.accountId`);
          sum += tv;
          lines.push(line(ta.id, -tv, contactId, l.tax.name || "Tax"));
        }
      });
      lines.unshift(line(into.id, sum, contactId, null));
      break;
    }

    case "transfer": {
      const d = parseDocData("transfer", rawData);
      const from = moneyAccount(ctx, d.from, "from");
      const to = moneyAccount(ctx, d.to, "to");
      if (from.id === to.id) throw new BooksError("Choose two different accounts", "to");
      const v = amount(d.amount, "amount");
      lines.push(line(to.id, v, null), line(from.id, -v, null));
      break;
    }

    case "owner_in": {
      const d = parseDocData("owner_in", rawData);
      const to = moneyAccount(ctx, d.to, "to");
      const v = amount(d.amount, "amount");
      lines.push(line(to.id, v, null), line(ctx.system("owner_capital"), -v, null));
      break;
    }

    case "owner_out": {
      const d = parseDocData("owner_out", rawData);
      const from = moneyAccount(ctx, d.from, "from");
      const v = amount(d.amount, "amount");
      lines.push(line(ctx.system("owner_drawings"), v, null), line(from.id, -v, null));
      break;
    }

    case "opening": {
      const d = parseDocData("opening", rawData);
      const balancing = ctx.system("opening_balance");
      const seen = new Set<string>();
      let sum = 0n;
      d.lines.forEach((l, i) => {
        const a = account(ctx, l.accountId, `lines.${i}.accountId`);
        if (a.id === balancing) throw new BooksError("The adjustment account is filled in for you", `lines.${i}.accountId`);
        if (a.type === "income" || a.type === "expense") {
          throw new BooksError(`"${a.name}" doesn't carry an opening balance`, `lines.${i}.accountId`);
        }
        if (seen.has(a.id)) throw new BooksError(`"${a.name}" is listed twice`, `lines.${i}.accountId`);
        seen.add(a.id);
        const natural = minorFromString(l.amount);
        if (natural === null) throw new BooksError("Enter an amount", `lines.${i}.amount`);
        if (natural >= MAX_AMOUNT || -natural >= MAX_AMOUNT) throw new BooksError("That amount is too large", `lines.${i}.amount`);
        const ledger = a.type === "asset" ? natural : -natural;
        sum += ledger;
        lines.push(line(a.id, ledger, null, l.description));
      });
      if (sum !== 0n) lines.push(line(balancing, -sum, null, null));
      break;
    }

    case "manual": {
      const d = parseDocData("manual", rawData);
      d.lines.forEach((l, i) => {
        const a = account(ctx, l.accountId, `lines.${i}.accountId`);
        const dr = l.debit ? amount(l.debit, `lines.${i}.debit`) : 0n;
        const cr = l.credit ? amount(l.credit, `lines.${i}.credit`) : 0n;
        if (dr > 0n && cr > 0n) throw new BooksError("A line can have a debit or a credit, not both", `lines.${i}.debit`);
        if (dr === 0n && cr === 0n) throw new BooksError("Each line needs a debit or a credit", `lines.${i}.debit`);
        lines.push(line(a.id, dr - cr, l.contactId || contactId, l.description));
      });
      const diff = lines.reduce((s, l) => s + l.amount, 0n);
      if (diff !== 0n) throw new BooksError("Debits and credits must be equal", "lines");
      break;
    }

    case "ad_spend":
    case "sales_summary": {
      const d = type === "ad_spend" ? parseDocData("ad_spend", rawData) : parseDocData("sales_summary", rawData);
      const side = (ls: typeof d.debits, sign: 1n | -1n, name: "debits" | "credits") =>
        ls.forEach((l, i) => {
          const a = account(ctx, l.accountId, `${name}.${i}.accountId`);
          if (a.type === "equity") throw new BooksError(`"${a.name}" can't be used in a sales summary`, `${name}.${i}.accountId`);
          lines.push(line(a.id, sign * amount(l.amount, `${name}.${i}.amount`), l.contactId || null, l.description));
        });
      side(d.debits, 1n, "debits");
      side(d.credits, -1n, "credits");
      const diff = lines.reduce((s, l) => s + l.amount, 0n);
      if (diff !== 0n) {
        throw new BooksError(type === "ad_spend" ? "This doesn't add up: what was charged must equal the spend plus its taxes and charges" : "This doesn't add up: what customers owe must equal sales + shipping + tax − discounts − returns", "lines");
      }
      break;
    }

    case "gateway_payout":
    case "courier_payout": {
      const d = type === "gateway_payout" ? parseDocData("gateway_payout", rawData) : parseDocData("courier_payout", rawData);
      const who = type === "gateway_payout" ? "gateway" : "courier";
      const rec = account(ctx, d.receivable, "receivable");
      if (!(rec.type === "asset" && rec.subtype === "receivable")) throw new BooksError(`"${rec.name}" isn't an "owed to you" account`, "receivable");
      const into = moneyAccount(ctx, d.receivedIn, "receivedIn");
      const received = signed(d.received, "received");
      let gross = received;
      if (received !== 0n) lines.push(line(into.id, received, contactId, null));
      d.deductions.forEach((l, i) => {
        const a = account(ctx, l.accountId, `deductions.${i}.accountId`);
        if (!(a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype) && a.id !== rec.id))) {
          throw new BooksError(`"${a.name}" can't be used for what the ${who} kept`, `deductions.${i}.accountId`);
        }
        const v = signed(l.amount, `deductions.${i}.amount`);
        gross += v;
        lines.push(line(a.id, v, contactId, l.description));
      });
      // Money in the payout that isn't for orders in these books is held apart, not taken off what's owed.
      const others = type === "courier_payout" ? (d as DocData<"courier_payout">).others : null;
      if (others && others.amount !== "0") {
        const a = account(ctx, others.accountId, "others.accountId");
        if (isMoneySubtype(a.subtype) || a.id === rec.id || a.type === "income" || a.type === "expense") throw new BooksError(`"${a.name}" can't hold money for other orders`, "others.accountId");
        const v = signed(others.amount, "others.amount");
        lines.push(line(a.id, -v, contactId, null));
        gross -= v;
      }
      // The receivable line carries no contact: COD sales aren't split by courier yet,
      // so a per-courier balance would show payouts without the sales behind them.
      if (gross !== 0n) lines.push(line(rec.id, -gross, null, null));
      break;
    }

    case "production": {
      const d = parseDocData("production", rawData);
      const wip = account(ctx, d.wip, "wip");
      if (!(wip.type === "asset" && wip.subtype === "stock")) throw new BooksError(`"${wip.name}" isn't a stock account`, "wip");
      const other = account(ctx, d.other, "other");
      if (other.id === wip.id) throw new BooksError("Choose a different account from work in progress", "other");
      const stockLike = other.type === "asset" && other.subtype === "stock";
      const ok =
        d.step === "materials" || d.step === "finish"
          ? stockLike
          : d.step === "cost"
            ? isMoneySubtype(other.subtype) || (other.type === "liability" && other.subtype === "payable")
            : other.type === "expense";
      if (!ok) {
        const what = { materials: "materials come from", finish: "finished stock goes to", cost: "the cost was paid from", waste: "waste goes to" }[d.step];
        throw new BooksError(`"${other.name}" can't be where ${what}`, "other");
      }
      const v = amount(d.amount, "amount");
      // Into work in progress (materials, costs), or out of it (finished, waste).
      if (d.step === "materials" || d.step === "cost") lines.push(line(wip.id, v, contactId, null), line(other.id, -v, contactId, null));
      else lines.push(line(other.id, v, contactId, null), line(wip.id, -v, contactId, null));
      break;
    }

    case "returns_allowance": {
      const d = parseDocData("returns_allowance", rawData);
      const ret = account(ctx, d.returns, "returns");
      if (ret.type !== "income") throw new BooksError(`"${ret.name}" isn't a sales account`, "returns");
      const al = account(ctx, d.allowance, "allowance");
      if (al.type !== "liability" || isMoneySubtype(al.subtype)) throw new BooksError(`"${al.name}" can't hold expected returns`, "allowance");
      const v = signed(d.amount, "amount");
      lines.push(line(ret.id, v, null, null), line(al.id, -v, null, null));
      if (d.cost && d.cost !== "0") {
        if (!d.stockBack || !d.cogs) throw new BooksError("Choose where the expected stock goes", "stockBack");
        const sb = account(ctx, d.stockBack, "stockBack");
        if (!(sb.type === "asset" && !isMoneySubtype(sb.subtype) && sb.subtype !== "receivable")) throw new BooksError(`"${sb.name}" can't hold stock expected back`, "stockBack");
        const cg = account(ctx, d.cogs, "cogs");
        if (cg.type !== "expense") throw new BooksError(`"${cg.name}" isn't a cost account`, "cogs");
        const c = signed(d.cost, "cost");
        lines.push(line(sb.id, c, null, null), line(cg.id, -c, null, null));
      }
      break;
    }

    case "parcel_writeoff": {
      const d = parseDocData("parcel_writeoff", rawData);
      const rec = account(ctx, d.receivable, "receivable");
      if (!(rec.type === "asset" && rec.subtype === "receivable")) throw new BooksError(`"${rec.name}" isn't an "owed to you" account`, "receivable");
      const to = account(ctx, d.account, "account");
      if (d.reason === "lost" ? to.type !== "income" : to.type !== "expense") throw new BooksError(`"${to.name}" can't take ${d.reason === "lost" ? "lost parcels" : "a short payment"}`, "account");
      const seen = new Set<string>();
      let sum = 0n;
      d.parcels.forEach((p, i) => {
        if (seen.has(p.orderId)) throw new BooksError(`${p.orderName} is listed twice`, `parcels.${i}`);
        seen.add(p.orderId);
        sum += amount(p.amount, `parcels.${i}.amount`);
      });
      let tax = 0n;
      if (d.tax && d.reason === "lost") {
        const t = account(ctx, d.tax.accountId, "tax.accountId");
        if (!isTaxAccount(t, "liability")) throw new BooksError(`"${t.name}" isn't a tax account`, "tax.accountId");
        tax = BigInt(d.tax.amount);
        if (tax < 0n || tax > sum) throw new BooksError("The tax can't be more than the parcels", "tax.amount");
        if (tax > 0n) lines.push(line(t.id, tax, contactId, null));
      }
      lines.push(line(to.id, sum - tax, contactId, null), line(rec.id, -sum, null, null));
      break;
    }

    case "bill": {
      const d = parseDocData("bill", rawData);
      if (!contactId) throw new BooksError("Choose the supplier", "contactId");
      const pay = account(ctx, d.payable, "payable");
      if (!(pay.type === "liability" && pay.subtype === "payable")) throw new BooksError(`"${pay.name}" isn't a "you owe" account`, "payable");
      if (d.dueDate && !isIsoDate(d.dueDate)) throw new BooksError("Choose a due date", "dueDate");
      let sum = 0n;
      if (d.opening) sum = openingLines(ctx, lines, d.lines, 1n, contactId);
      else
        d.lines.forEach((l, i) => {
          const a = account(ctx, l.accountId, `lines.${i}.accountId`);
          if (!(a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype) && a.subtype !== "receivable"))) {
            throw new BooksError(`"${a.name}" can't be used on a bill`, `lines.${i}.accountId`);
          }
          sum += costWithTax(ctx, lines, a.id, amount(l.amount, `lines.${i}.amount`), l.tax, contactId, l.description, `lines.${i}`);
        });
      lines.push(line(pay.id, -sum, contactId, d.reference ? `Bill ${d.reference}` : null));
      break;
    }

    case "bill_payment": {
      const d = parseDocData("bill_payment", rawData);
      if (!contactId) throw new BooksError("Choose the supplier", "contactId");
      const pay = account(ctx, d.payable, "payable");
      if (!(pay.type === "liability" && pay.subtype === "payable")) throw new BooksError(`"${pay.name}" isn't a "you owe" account`, "payable");
      const from = moneyAccount(ctx, d.paidFrom, "paidFrom");
      const seen = new Set<string>();
      let sum = 0n;
      d.allocations.forEach((a, i) => {
        if (seen.has(a.billId)) throw new BooksError("The same bill is listed twice", `allocations.${i}.billId`);
        seen.add(a.billId);
        sum += amount(a.amount, `allocations.${i}.amount`);
      });
      lines.push(line(pay.id, sum, contactId, null));
      const kept = withheldLine(ctx, lines, d.withheld, sum, contactId);
      lines.push(line(from.id, -(sum - kept), contactId, null));
      break;
    }

    case "invoice": {
      const d = parseDocData("invoice", rawData);
      if (!contactId) throw new BooksError("Choose the customer", "contactId");
      const rec = receivableAccount(ctx, d.receivable);
      if (d.dueDate && !isIsoDate(d.dueDate)) throw new BooksError("Choose a due date", "dueDate");
      const sum = d.opening ? openingLines(ctx, lines, d.lines, -1n, contactId) : salesLines(ctx, lines, d.lines, -1n, contactId, "an invoice");
      lines.unshift(line(rec.id, sum, contactId, d.reference ? `Invoice ${d.reference}` : null));
      break;
    }

    case "customer_payment": {
      const d = parseDocData("customer_payment", rawData);
      if (!contactId) throw new BooksError("Choose the customer", "contactId");
      const rec = receivableAccount(ctx, d.receivable);
      const into = moneyAccount(ctx, d.receivedIn, "receivedIn");
      const sum = allocationTotal(d.allocations, "invoice");
      // Tax the customer withheld from you is claimable (an advance on your own tax).
      let kept = 0n;
      if (d.withheld) {
        kept = amount(d.withheld.amount, "withheld.amount");
        if (kept > 0n) {
          const a = account(ctx, d.withheld.accountId, "withheld.accountId");
          if (!isTaxAccount(a, "asset")) throw new BooksError(`"${a.name}" isn't a tax account you can claim from`, "withheld.accountId");
          if (kept > sum) throw new BooksError("They can't withhold more than the payment", "withheld.amount");
        }
      }
      lines.push(line(into.id, sum - kept, contactId, null));
      if (kept > 0n) lines.push(line(d.withheld!.accountId, kept, contactId, d.withheld!.name || "Tax withheld by customer"));
      lines.push(line(rec.id, -sum, contactId, null));
      break;
    }

    case "credit_note": {
      const d = parseDocData("credit_note", rawData);
      if (!contactId) throw new BooksError("Choose the customer", "contactId");
      const rec = receivableAccount(ctx, d.receivable);
      const sum = d.opening ? openingLines(ctx, lines, d.lines, 1n, contactId) : salesLines(ctx, lines, d.lines, 1n, contactId, "a credit note");
      if (allocationTotal(d.allocations ?? [], "invoice") > sum) throw new BooksError("You can't set more against invoices than the credit note is for", "allocations");
      lines.push(line(rec.id, -sum, contactId, d.reference ? `Credit note ${d.reference}` : null));
      break;
    }

    case "supplier_credit": {
      const d = parseDocData("supplier_credit", rawData);
      if (!contactId) throw new BooksError("Choose the supplier", "contactId");
      const pay = account(ctx, d.payable, "payable");
      if (!(pay.type === "liability" && pay.subtype === "payable")) throw new BooksError(`"${pay.name}" isn't a "you owe" account`, "payable");
      let sum = 0n;
      if (d.opening) sum = openingLines(ctx, lines, d.lines, -1n, contactId);
      else
        d.lines.forEach((l, i) => {
          const a = account(ctx, l.accountId, `lines.${i}.accountId`);
          if (!(a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype) && a.subtype !== "receivable"))) {
            throw new BooksError(`"${a.name}" can't be used on a supplier credit`, `lines.${i}.accountId`);
          }
          sum += costWithTax(ctx, lines, a.id, amount(l.amount, `lines.${i}.amount`), l.tax, contactId, l.description, `lines.${i}`, -1n);
        });
      if (allocationTotal(d.allocations ?? [], "bill") > sum) throw new BooksError("You can't set more against bills than the credit is for", "allocations");
      lines.unshift(line(pay.id, sum, contactId, d.reference ? `Credit ${d.reference}` : null));
      break;
    }

    case "fx_revaluation": {
      const d = parseDocData("fx_revaluation", rawData);
      const a = account(ctx, d.account, "account");
      if (!a.currency) throw new BooksError(`"${a.name}" is kept in the book's own currency`, "account");
      const g = account(ctx, d.gainsAccount, "gainsAccount");
      if (!(g.type === "income" || g.type === "expense")) throw new BooksError(`"${g.name}" can't take exchange gains or losses`, "gainsAccount");
      const v = signed(d.adjustment, "adjustment");
      if (v === 0n) throw new BooksError("The value already matches this rate — there's nothing to revalue", "adjustment");
      lines.push({ ...line(a.id, v, null, "Revalued"), fxAmount: 0n }, line(g.id, -v, null, null));
      break;
    }

    case "tax_payment": {
      const d = parseDocData("tax_payment", rawData);
      const from = moneyAccount(ctx, d.paidFrom, "paidFrom");
      const seen = new Set<string>();
      let net = 0n;
      d.lines.forEach((l, i) => {
        const a = account(ctx, l.accountId, `lines.${i}.accountId`);
        if (!(isTaxAccount(a, "liability") || isTaxAccount(a, "asset"))) throw new BooksError(`"${a.name}" isn't a tax account`, `lines.${i}.accountId`);
        if (seen.has(a.id)) throw new BooksError(`"${a.name}" is listed twice`, `lines.${i}.accountId`);
        seen.add(a.id);
        const v = amount(l.amount, `lines.${i}.amount`);
        // Tax owed is paid off (debit); claimable tax is used up against it (credit).
        const signedV = a.type === "liability" ? v : -v;
        net += signedV;
        lines.push(line(a.id, signedV, contactId, l.description));
      });
      // Positive: money paid to the tax office. Negative: a refund coming in.
      lines.push(line(from.id, -net, contactId, null));
      break;
    }

    case "stock_adjustment": {
      const d = parseDocData("stock_adjustment", rawData);
      const stock = account(ctx, d.stock, "stock");
      if (!(stock.type === "asset" && !isMoneySubtype(stock.subtype))) throw new BooksError(`"${stock.name}" isn't a stock account`, "stock");
      const other = account(ctx, d.counter, "counter");
      if (!(other.type === "expense" || other.systemKey === "opening_balance")) throw new BooksError(`"${other.name}" can't take a stock adjustment`, "counter");
      const v = signed(d.amount, "amount");
      if (v === 0n) throw new BooksError("Stock already matches — there's nothing to adjust", "amount");
      lines.push(line(stock.id, v, null, null), line(other.id, -v, null, null));
      break;
    }

    default: {
      const never: never = type;
      throw new BooksError(`Unknown document type ${String(never)}`);
    }
  }

  const kept = lines.filter((l) => l.amount !== 0n);
  if (kept.length < 2) throw new BooksError("Enter an amount", "amount");
  applyForeignAmounts(type, rawData, kept, ctx);
  const sum = kept.reduce((s, l) => s + l.amount, 0n);
  if (sum !== 0n) throw new Error(`Books engine produced an unbalanced posting for ${type} (off by ${sum})`);
  const total = kept.reduce((s, l) => (l.amount > 0n ? s + l.amount : s), 0n);
  return { lines: kept, total };
}

/** The lines of a cancel: the original, mirrored (foreign amounts too). */
export function mirrorLines(lines: Array<Pick<PostingLine, "accountId" | "amount" | "contactId" | "description"> & { fxAmount?: bigint | null }>): PostingLine[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    amount: -l.amount,
    contactId: l.contactId ?? null,
    description: l.description ?? null,
    fxAmount: l.fxAmount == null ? null : -l.fxAmount,
  }));
}

/**
 * Lines on a foreign-currency account carry the amount in that currency,
 * from the document's `fx` ({ [accountId]: { amount } }, a positive amount
 * in the account's own minor units). Each foreign account may appear on one
 * line of a document, so the foreign amount is never split by guesswork.
 */
function applyForeignAmounts(type: DocType, rawData: unknown, lines: PostingLine[], ctx: PostingContext) {
  if (type === "fx_revaluation") return; // only the book value moves
  const fx = ((rawData ?? {}) as { fx?: Record<string, { amount?: unknown }> }).fx ?? {};
  const seen = new Set<string>();
  for (const l of lines) {
    const a = ctx.accounts.get(l.accountId);
    if (!a?.currency) continue;
    if (seen.has(a.id)) throw new BooksError(`"${a.name}" is in ${a.currency}: put it on one line only`, "fx");
    seen.add(a.id);
    const raw = fx[a.id]?.amount;
    const v = typeof raw === "string" ? minorFromString(raw) : null;
    if (v === null || v <= 0n) throw new BooksError(`Enter the amount in ${a.currency} for "${a.name}"`, `fx.${a.id}`);
    if (v >= MAX_AMOUNT) throw new BooksError("That amount is too large", `fx.${a.id}`);
    l.fxAmount = l.amount < 0n ? -v : v;
  }
}

/**
 * Growzar (v1.1 V1b, D-99): a line that pays down part of a foreign balance
 * (a USD card paid off, an AED receivable collected) leaves that account at
 * its own carried value, the book's value per foreign unit before this
 * entry; the difference from the entry's own figure is the realised exchange
 * gain or loss, posted in the same entry. Lines that add to a foreign balance
 * stay as they are: the month-end revaluation takes care of what's unrealised.
 *
 * `balances`: per foreign account, its book value and foreign balance up to
 * the entry's date, before it. Amounts are ledger-signed (+ debit).
 */
export function realiseExchange(lines: PostingLine[], balances: ReadonlyMap<string, { book: bigint; foreign: bigint }>, gainsAccountId: string): PostingLine[] {
  const out: PostingLine[] = [];
  let realised = 0n;
  for (const l of lines) {
    const b = balances.get(l.accountId);
    if (!l.fxAmount || !b || b.foreign === 0n || (l.fxAmount > 0n) === (b.foreign > 0n)) {
      out.push(l);
      continue;
    }
    // Only up to what was there is settled; anything beyond starts the other way, at the entry's rate.
    const abs = (v: bigint) => (v < 0n ? -v : v);
    const settled = abs(l.fxAmount) > abs(b.foreign) ? -b.foreign : l.fxAmount;
    const carried = divRound(settled * b.book, b.foreign);
    const atEntry = divRound(settled * l.amount, l.fxAmount);
    const diff = atEntry - carried;
    if (diff === 0n) {
      out.push(l);
      continue;
    }
    out.push({ ...l, amount: l.amount - diff });
    realised += diff;
  }
  if (realised !== 0n) out.push({ accountId: gainsAccountId, amount: realised, contactId: null, description: "Exchange difference (realised)" });
  return out;
}

/** a / b, rounded half away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  const neg = (a < 0n) !== (b < 0n);
  const [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  const q = (2n * x + y) / (2n * y);
  return neg ? -q : q;
}

// ── Dates (YYYY-MM-DD strings; the books have no time of day) ─────────────────

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Can something be posted on `date` when the books are closed through `lockedThrough`? */
export function isOpenDate(date: string, lockedThrough: string | null): boolean {
  return !lockedThrough || date > lockedThrough;
}

/** A cancel is dated with the original when that day is open, else the first open day. */
export function cancelDateFor(docDate: string, lockedThrough: string | null): string {
  return isOpenDate(docDate, lockedThrough) ? docDate : addDays(lockedThrough!, 1);
}

/** First day of the fiscal year containing `date`. */
export function fiscalYearStart(date: string, startMonth: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}
