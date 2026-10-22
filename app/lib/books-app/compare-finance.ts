/**
 * Books next to Finance's profit, line by line (B6, D-69). Pure: Finance's
 * profit parts (`profitAfterReturns`, in the store's currency) and Books'
 * movements come in; rows with both figures, the difference and why the two
 * differ come out. Ported from Financify's dashboard-compare.ts, with Growzar
 * Finance's lines in place of Financify's dashboard.
 *
 * Every Books income and expense account lands on exactly one row, so the
 * Books column always adds up to Books' own profit for the store.
 */

export type CompareKey = "sales" | "cogs" | "courier" | "ads" | "payment" | "taxes" | "other" | "unassigned";

export const COMPARE_ROWS: Array<{ key: CompareKey; label: string; why: string }> = [
  {
    key: "sales",
    label: "Sales after returns",
    why: "Finance counts the orders placed in these days that were delivered, at the order's total. Books counts a cash-on-delivery sale on the day it's delivered (or as your books are set), a prepaid sale when it's placed, and a return or refund on the day it's seen; a day already in the books never changes. Books also keeps sales tax out of sales: it's owed to the tax office.",
  },
  {
    key: "cogs",
    label: "Product cost",
    why: "Finance takes the cost of the delivered orders placed in these days. Books takes cost off Stock with each sale it counts, and puts it back when a parcel comes back.",
  },
  {
    key: "courier",
    label: "Courier charges",
    why: "Finance uses each parcel's booked fee (or Financify's shipping estimate where no fee is known), on the order's day. Books records what couriers actually kept when they pay you, so it lands on the payout's day, often weeks later.",
  },
  {
    key: "ads",
    label: "Ad spend (with platform fees)",
    why: "Both read the same ad spend. They differ when Books' ad spend connector is off for some of these days, its fee settings differ, or a platform revised a day after Books saved it (Books posts the change as a correction).",
  },
  {
    key: "payment",
    label: "Payment fees",
    why: "Finance takes Financify's estimate of gateway fees. Books records the fees when a gateway pays you, or when you enter them.",
  },
  {
    key: "taxes",
    label: "Taxes",
    why: "Finance takes tax collected on orders off profit. In Books, tax you collect is held for the tax office (a liability), so it isn't a cost.",
  },
  {
    key: "other",
    label: "Everything else",
    why: "Finance's custom costs from Financify, and in Books everything else you've recorded for this store: other income, packaging, bank charges and the like.",
  },
  {
    key: "unassigned",
    label: "Entries for the whole business",
    why: "Rent, salaries and anything else in Books not tied to one store. Finance works store by store and never sees them.",
  },
];

export interface CompareAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  systemKey: string | null;
}

export interface ClassifyConfig {
  /** The sales connector's income accounts (sales, shipping, discounts, returns, held). */
  salesAccounts: string[];
  cogs: string | null;
  adAccounts: string[];
  courierAccounts: string[];
}

/** Which row each Books income/expense account belongs to. */
export function classifyAccounts(accounts: CompareAccount[], cfg: ClassifyConfig): Map<string, CompareKey> {
  const byCode = (code: string) => accounts.find((a) => a.code === code)?.id;
  const out = new Map<string, CompareKey>();
  const set = (id: string | undefined | null, key: CompareKey) => {
    if (id && !out.has(id)) out.set(id, key);
  };
  for (const id of cfg.salesAccounts) set(id, "sales");
  for (const code of ["4000", "4010", "4020", "4030"]) set(byCode(code), "sales");
  set(cfg.cogs || accounts.find((a) => a.systemKey === "cogs")?.id, "cogs");
  for (const id of cfg.adAccounts) set(id, "ads");
  for (const id of cfg.courierAccounts) set(id, "courier");
  for (const code of ["5010", "5020"]) set(byCode(code), "courier");
  // Accounts the payout connector and the Couriers screen make the first time they need them.
  for (const a of accounts) if (/^(courier charges not explained|courier shortfalls)$/i.test(a.name)) set(a.id, "courier");
  set(byCode("5040"), "payment");
  for (const a of accounts) if (a.type === "income" || a.type === "expense") set(a.id, "other");
  // Only profit and loss accounts belong on the rows.
  for (const a of accounts) if (a.type !== "income" && a.type !== "expense") out.delete(a.id);
  return out;
}

const zero = () => Object.fromEntries(COMPARE_ROWS.map((r) => [r.key, 0n])) as Record<CompareKey, bigint>;

/**
 * Books' effect on profit per row (income positive, costs negative), minor
 * units: the store's own lines on their rows, and lines with no store on
 * "Entries for the whole business".
 */
export function booksRows(classes: Map<string, CompareKey>, storeMoves: Map<string, bigint>, unassignedMoves: Map<string, bigint>): Record<CompareKey, bigint> {
  const out = zero();
  for (const [id, key] of classes) {
    out[key] -= storeMoves.get(id) ?? 0n;
    out.unassigned -= unassignedMoves.get(id) ?? 0n;
  }
  return out;
}

/** Finance's profit parts, as `profitAfterReturns` makes them: decimal strings in the store's currency. */
export interface FinanceParts {
  deliveredRevenue: string;
  cogsDelivered: string;
  courierFees: string;
  adSpend: string | null;
  otherCosts: { payment: string; shipping: string; taxes: string; custom: string; total: string } | null;
}

/** Finance's lines folded onto the same rows, in minor units (costs negative). */
export function financeRows(parts: FinanceParts, toMinor: (s: string) => bigint): { rows: Record<CompareKey, bigint>; net: bigint } {
  const oc = parts.otherCosts;
  const rows = zero();
  rows.sales = toMinor(parts.deliveredRevenue);
  rows.cogs = -toMinor(parts.cogsDelivered);
  rows.courier = -(toMinor(parts.courierFees) + (oc ? toMinor(oc.shipping) : 0n));
  rows.ads = parts.adSpend === null ? 0n : -toMinor(parts.adSpend);
  rows.payment = oc ? -toMinor(oc.payment) : 0n;
  rows.taxes = oc ? -toMinor(oc.taxes) : 0n;
  rows.other = oc ? -toMinor(oc.custom) : 0n;
  return { rows, net: Object.values(rows).reduce((a, b) => a + b, 0n) };
}

export interface CompareRow {
  key: CompareKey;
  label: string;
  why: string;
  finance: bigint;
  books: bigint;
  difference: bigint;
}

export function compareRows(finance: Record<CompareKey, bigint>, books: Record<CompareKey, bigint>): CompareRow[] {
  return COMPARE_ROWS.map((r) => ({ ...r, finance: finance[r.key], books: books[r.key], difference: books[r.key] - finance[r.key] }));
}

/** Rounding between Finance's decimals and Books' whole minor units: differences this small are "the same". */
export function sameish(a: bigint, b: bigint, decimals: number): boolean {
  const d = a > b ? a - b : b - a;
  return d <= BigInt(10 ** decimals); // within one unit of currency
}
