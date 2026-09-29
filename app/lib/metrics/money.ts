/**
 * Money for the metric layer (contract §4, rules #2 and #4).
 *
 * Amounts are decimal strings from the apps and stay exact here: they are
 * held as integer millionths in a bigint, so no sum ever passes through a
 * float. Financify's `/dashboard` does its sums in floats and reports
 * 87652.35999999999 for a day whose rows add to 87652.36 exactly; the layer
 * must never be the side with the rounding error.
 *
 * Two rules are enforced rather than documented:
 *  - **currencies never mix** (rule #4): adding PKR to AED throws. Converting
 *    is a separate, explicit step with a stated rate (G-GZR2-4);
 *  - **kinds never mix** (rule #2) is the caller's job, because an amount does
 *    not know whether it is placed, delivered or collected — which is why the
 *    order grain keeps them in separate fields rather than one list.
 */

export type Money = { amount: string; currency: string };

const SCALE = 1_000_000n;
const DECIMALS = 6;

/** Parse an app's decimal string. Anything that is not one is null, not zero. */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > DECIMALS) return null;
  const units = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(DECIMALS, "0"));
  return sign ? -units : units;
}

/** Format millionths back to a decimal string with at least two places. */
export function formatAmount(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  let fraction = (abs % SCALE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** An app's `{ amount, currency }`, or null if either part is missing or malformed. */
export function readMoney(value: unknown): Money | null {
  if (!value || typeof value !== "object") return null;
  const { amount, currency } = value as Record<string, unknown>;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  const units = parseAmount(amount);
  if (units === null) return null;
  return { amount: formatAmount(units), currency };
}

export function zero(currency: string): Money {
  return { amount: "0.00", currency };
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Refusing to add ${a} to ${b}: mixed currencies are never summed (rule #4)`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return {
    amount: formatAmount(parseAmount(a.amount)! + parseAmount(b.amount)!),
    currency: a.currency,
  };
}

export function isPositive(m: Money | null): boolean {
  return m !== null && parseAmount(m.amount)! > 0n;
}

/**
 * Sum money that may be in several currencies, one total per currency.
 * This is the only way the layer adds a list of amounts: a roll-up of a PKR
 * store with a handful of AED orders gets two totals, never one.
 */
export function sumByCurrency(values: ReadonlyArray<Money | null>): Money[] {
  const totals = new Map<string, bigint>();
  for (const value of values) {
    if (!value) continue;
    totals.set(value.currency, (totals.get(value.currency) ?? 0n) + parseAmount(value.amount)!);
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, units]) => ({ amount: formatAmount(units), currency }));
}
