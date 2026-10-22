/**
 * Tax in Books: rates, the arithmetic, and suggested rates per currency.
 * Pure and browser-safe: forms, the posting engine and reports share it.
 *
 * Rates are whole basis points (1800 = 18%, 25 = 0.25%). Amounts are minor
 * units. Tax is rounded half up to the minor unit.
 *
 * Kinds:
 *   sales        charged to customers; owed to the tax office (a "Tax" liability)
 *   purchase     paid to suppliers; claimable (a "Tax" asset) or, with no
 *                account, part of the cost
 *   withholding  kept back from a supplier's payment and paid to the tax
 *                office for them (a "Tax" liability)
 */

export const TAX_KINDS = ["sales", "purchase", "withholding"] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export const TAX_KIND_LABELS: Record<TaxKind, { label: string; help: string }> = {
  sales: { label: "Tax you charge", help: "Added to what customers pay, and owed to the tax office" },
  purchase: { label: "Tax you pay", help: "Charged by suppliers. Claim it back, or count it as part of the cost" },
  withholding: { label: "Tax you withhold", help: "Kept back from a supplier's payment and paid to the tax office for them" },
};

export interface TaxRateView {
  id: string;
  name: string;
  kind: TaxKind;
  rateBp: number;
  /** Where the tax goes. Null only for purchase tax you can't claim (it joins the cost). */
  accountId: string | null;
  archived: boolean;
}

/** What a document line stores about its tax, so later rate changes never alter it. */
export interface LineTax {
  rateId?: string | null;
  name?: string | null;
  rateBp?: number | null;
  accountId?: string | null;
  amount: string;
}

export const MAX_RATE_BP = 100_000; // 1000%, a sanity cap

/** "18%", "4.5%", "0.25%". */
export function formatRate(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

/** "18" / "4.5" / "0.25" → basis points; null when it isn't a rate. */
export function parseRate(input: string): number | null {
  const s = input.trim().replace(/%$/, "").trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const bp = Number(w) * 100 + Number(f.padEnd(2, "0"));
  return bp <= MAX_RATE_BP ? bp : null;
}

/** Tax on an amount before tax. */
export function taxOn(net: bigint, bp: number): bigint {
  if (net <= 0n || bp <= 0) return 0n;
  return (net * BigInt(bp) + 5000n) / 10000n;
}

/** Split an amount that includes tax into before-tax and tax; the two always add back up. */
export function splitInclusive(gross: bigint, bp: number): { net: bigint; tax: bigint } {
  if (gross <= 0n || bp <= 0) return { net: gross, tax: 0n };
  const d = 10000n + BigInt(bp);
  const tax = (gross * BigInt(bp) + d / 2n) / d;
  return { net: gross - tax, tax };
}

/** Rates people commonly start with, per book currency. They only pre-fill the form. */
export function suggestedRates(currency: string): Array<{ name: string; kind: TaxKind; rateBp: number }> {
  switch (currency.toUpperCase()) {
    case "PKR":
      return [
        { name: "Sales tax 18%", kind: "sales", rateBp: 1800 },
        { name: "Sales tax 18% (claimable)", kind: "purchase", rateBp: 1800 },
        { name: "WHT on goods 4.5%", kind: "withholding", rateBp: 450 },
        { name: "WHT on services 10%", kind: "withholding", rateBp: 1000 },
      ];
    case "AED":
      return [
        { name: "VAT 5%", kind: "sales", rateBp: 500 },
        { name: "VAT 5% (claimable)", kind: "purchase", rateBp: 500 },
      ];
    case "SAR":
      return [
        { name: "VAT 15%", kind: "sales", rateBp: 1500 },
        { name: "VAT 15% (claimable)", kind: "purchase", rateBp: 1500 },
      ];
    case "INR":
      return [
        { name: "GST 18%", kind: "sales", rateBp: 1800 },
        { name: "GST 12%", kind: "sales", rateBp: 1200 },
        { name: "GST 5%", kind: "sales", rateBp: 500 },
        { name: "GST 18% (input credit)", kind: "purchase", rateBp: 1800 },
        { name: "TDS 1%", kind: "withholding", rateBp: 100 },
      ];
    default:
      return [];
  }
}

/**
 * A line's before-tax amount and tax from what was typed: the amount (with or
 * without tax) and, optionally, a tax amount typed over the worked-out one
 * (receipts round differently). No rate: no tax.
 */
export function lineFigures(entered: bigint, rateBp: number | null | undefined, inclusive: boolean, override: bigint | null = null): { net: bigint; tax: bigint } {
  if (rateBp == null) return { net: entered, tax: 0n };
  if (override !== null) return inclusive ? { net: entered - override, tax: override } : { net: entered, tax: override };
  return inclusive ? splitInclusive(entered, rateBp) : { net: entered, tax: taxOn(entered, rateBp) };
}

/**
 * Back from a saved line (before-tax amount + tax) to what the form shows,
 * with tax included: the total, and an override only when the saved tax
 * isn't what the rate works out to.
 */
export function lineToInput(net: bigint, tax: { rateBp?: number | null; amount: string } | null | undefined): { entered: bigint; override: bigint | null } {
  if (!tax || !/^\d+$/.test(tax.amount)) return { entered: net, override: null };
  const t = BigInt(tax.amount);
  const entered = net + t;
  const worked = tax.rateBp != null ? splitInclusive(entered, tax.rateBp).tax : null;
  return { entered, override: worked === t ? null : t };
}
