/**
 * Setting up an organization's book (B2), as pure rules. The setup screen and
 * its action both use these, so what the form proposes is what the server
 * accepts.
 *
 * - One book per organization, in its base currency (D-65). A store in
 *   another currency goes in too, its amounts converted at each day's rate
 *   (v1.1 V1, D-98; D-89 lifted). Only a store whose currency Growzar doesn't
 *   know yet is left out, with the reason.
 * - The time zone is the stores' shared one; when they differ, the person
 *   chooses (D-90).
 * - The book starts on a date the merchant picks, by default the first day of
 *   the current fiscal year, July in Pakistan (D-75).
 * - COD sales count at delivery by default; "when paid", order and dispatch
 *   are the options (D-69, D-83).
 */
import { MONEY_KINDS } from "../books/chart";
import { addMonths } from "../books/dates";
import { currencyDecimals, parseAmount } from "../books/money";
import { isIsoDate } from "../books/posting";
import { MAX_RATE_BP, TAX_KINDS, type TaxKind } from "../books/tax";

export const COD_BASES = [
  { value: "delivery", label: "When it's delivered", help: "The default. Books' sales agree with Finance." },
  { value: "money", label: "When the courier pays for it", help: "Counted when the courier's payout for the order is on record." },
  { value: "order", label: "When it's ordered", help: "Every order counts the day it's placed; returns come off later." },
  { value: "dispatch", label: "When it's handed to the courier", help: "Counted the day the parcel leaves." },
] as const;

export type CodBasis = (typeof COD_BASES)[number]["value"];

export type SetupStore = { id: string; name: string; currency: string | null; timezone: string | null };

export type StorePlan = {
  included: SetupStore[];
  excluded: Array<SetupStore & { reason: string }>;
};

/** Which stores the book can hold: any whose currency is known (D-65, v1.1 V1). */
export function planStores(stores: SetupStore[], _currency: string): StorePlan {
  const included: SetupStore[] = [];
  const excluded: StorePlan["excluded"] = [];
  for (const s of stores) {
    if (!s.currency) excluded.push({ ...s, reason: "Growzar doesn't know this store's currency yet." });
    else included.push(s);
  }
  return { included, excluded };
}

/** The stores' shared time zone, or null when they differ or none is known. */
export function sharedTimeZone(stores: SetupStore[]): string | null {
  const zones = [...new Set(stores.map((s) => s.timezone).filter((z): z is string => !!z))];
  return zones.length === 1 ? zones[0]! : null;
}

/** The first day of the fiscal year that `today` falls in. */
export function fiscalYearStartOn(today: string, fiscalYearStartMonth: number): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const year = m >= fiscalYearStartMonth ? y : y - 1;
  return `${year}-${String(fiscalYearStartMonth).padStart(2, "0")}-01`;
}

export type SetupInput = {
  startDate: string;
  fiscalYearStartMonth: number;
  timeZone: string;
  codBasis: string;
  storeIds: string[];
  moneyAccounts: Array<{ subtype: string; name: string; opening: string }>;
  taxRates: Array<{ name: string; kind: string; rate: string }>;
};

export type SetupPlan = {
  currency: string;
  startDate: string;
  fiscalYearStartMonth: number;
  timeZone: string;
  codBasis: CodBasis;
  storeIds: string[];
  moneyAccounts: Array<{ subtype: string; name: string; opening: bigint }>;
  taxRates: Array<{ name: string; kind: TaxKind; rateBp: number }>;
};

export type SetupError = { error: string; field: string };

/** A rate typed as a percentage ("18", "4.5") in basis points, or null. */
export function rateToBp(rate: string): number | null {
  const t = rate.trim().replace(/%$/, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".") as [string, string?];
  const bp = Number(whole) * 100 + Number((frac ?? "").padEnd(2, "0"));
  return bp <= MAX_RATE_BP ? bp : null;
}

/**
 * Check a submitted setup against what the organization has. Every message
 * names the field and the fix, as Financify's do.
 */
export function checkSetup(input: SetupInput, ctx: { currency: string; today: string; stores: SetupStore[]; timeZones: readonly string[] }): SetupPlan | SetupError {
  const { included } = planStores(ctx.stores, ctx.currency);
  if (!isIsoDate(input.startDate)) return { error: "Choose the day your books start", field: "startDate" };
  if (input.startDate > ctx.today) return { error: "The start can't be in the future. Choose today or an earlier day.", field: "startDate" };
  if (input.startDate < addMonths(ctx.today, -24)) return { error: "Start within the last two years.", field: "startDate" };
  if (!(Number.isInteger(input.fiscalYearStartMonth) && input.fiscalYearStartMonth >= 1 && input.fiscalYearStartMonth <= 12)) {
    return { error: "Choose the month your financial year starts", field: "fiscalYearStartMonth" };
  }
  if (!ctx.timeZones.includes(input.timeZone)) return { error: "Choose your time zone", field: "timeZone" };
  const basis = COD_BASES.find((b) => b.value === input.codBasis);
  if (!basis) return { error: "Choose when cash-on-delivery sales count", field: "codBasis" };

  const allowed = new Set(included.map((s) => s.id));
  const storeIds = [...new Set(input.storeIds)];
  if (storeIds.length === 0) return { error: "Choose at least one store for these books", field: "storeIds" };
  const bad = storeIds.find((id) => !allowed.has(id));
  if (bad) return { error: "One of the stores can't go in these books", field: "storeIds" };

  const decimals = currencyDecimals(ctx.currency);
  const money: SetupPlan["moneyAccounts"] = [];
  for (const [i, m] of input.moneyAccounts.entries()) {
    if (!m.name.trim() && !m.opening.trim()) continue;
    if (!MONEY_KINDS.some((k) => k.subtype === m.subtype)) return { error: "Choose what kind of account this is", field: `moneyAccounts.${i}.subtype` };
    if (!m.name.trim()) return { error: "Give this account a name", field: `moneyAccounts.${i}.name` };
    const raw = m.opening.trim().replace(/,/g, "");
    const neg = /^[-−]/.test(raw);
    const v = raw === "" ? 0n : parseAmount(neg ? raw.slice(1) : raw, decimals);
    if (v === null) return { error: "Enter the balance as an amount, like 25000 or 25000.50", field: `moneyAccounts.${i}.opening` };
    money.push({ subtype: m.subtype, name: m.name.trim(), opening: neg ? -v : v });
  }
  if (money.length === 0) return { error: "Add at least one place where you keep money", field: "moneyAccounts" };

  const rates: SetupPlan["taxRates"] = [];
  for (const [i, r] of input.taxRates.entries()) {
    if (!r.name.trim()) continue;
    if (!(TAX_KINDS as readonly string[]).includes(r.kind)) return { error: "Choose what kind of tax this is", field: `taxRates.${i}.kind` };
    const bp = rateToBp(r.rate);
    if (bp === null) return { error: "Enter the rate as a percentage, like 18 or 4.5", field: `taxRates.${i}.rate` };
    if (rates.some((x) => x.name.toLowerCase() === r.name.trim().toLowerCase())) return { error: "Two rates have the same name", field: `taxRates.${i}.name` };
    rates.push({ name: r.name.trim(), kind: r.kind as TaxKind, rateBp: bp });
  }

  return {
    currency: ctx.currency.toUpperCase(),
    startDate: input.startDate,
    fiscalYearStartMonth: input.fiscalYearStartMonth,
    timeZone: input.timeZone,
    codBasis: basis.value,
    storeIds,
    moneyAccounts: money,
    taxRates: rates,
  };
}

/** The template tax account each kind of rate posts to. */
export const TAX_ACCOUNT_FOR_KIND: Record<TaxKind, string> = {
  sales: "Sales tax to pay",
  purchase: "Tax you can claim back",
  withholding: "Withholding tax to pay",
};
