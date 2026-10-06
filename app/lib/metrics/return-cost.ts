/**
 * What a return costs in courier charges, measured (2026-10-06). Pure.
 *
 * Courierify G-CFY3-2 says, per returned parcel, how its courier charge is
 * known: "combined" (deliveryFee is the forward and return charge together:
 * Orio, Leopards, TCS, BlueEx statements), "separate" (deliveryFee forward +
 * reversalFee return: PostEx, NextStep), or null (no charge known). Either
 * way the total is exact; nothing is estimated or split.
 *
 * The cost of a return used on cards is the median of those totals, in the
 * store's currency. It is only the courier's charge: goods that cannot be
 * sold again are recorded by no app and are not in it, and a card says so.
 */
import { formatAmount, parseAmount, readMoney, type Money } from "./money";

/** Priced returns needed before a median is used. */
export const MIN_PRICED_RETURNS = 30;

export type ReturnParcel = {
  status: string;
  deliveryFee: unknown;
  reversalFee: unknown;
  returnChargeBasis: unknown;
};

export type ReturnCost = {
  /** Median courier charge on a returned parcel. */
  perReturn: Money;
  /** Returned parcels whose charge is known. */
  priced: number;
  /** Returned parcels in all. */
  returns: number;
};

/** The total courier charge on one returned parcel, or null when not known. */
export function chargeOnReturn(p: ReturnParcel, currency: string): bigint | null {
  if (p.status !== "returned") return null;
  const fwd = readMoney(p.deliveryFee);
  if (!fwd || fwd.currency !== currency) return null;
  if (p.returnChargeBasis === "combined") return parseAmount(fwd.amount);
  if (p.returnChargeBasis === "separate") {
    const back = readMoney(p.reversalFee);
    if (!back || back.currency !== currency) return null;
    return parseAmount(fwd.amount)! + parseAmount(back.amount)!;
  }
  return null;
}

/** Median of the known charges; null below MIN_PRICED_RETURNS. */
export function returnCostOf(parcels: readonly ReturnParcel[], currency: string): ReturnCost | null {
  const returned = parcels.filter((p) => p.status === "returned");
  const charges = returned
    .map((p) => chargeOnReturn(p, currency))
    .filter((c): c is bigint => c !== null && c > 0n)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (charges.length < MIN_PRICED_RETURNS) return null;
  const mid = Math.floor(charges.length / 2);
  const median = charges.length % 2 ? charges[mid]! : (charges[mid - 1]! + charges[mid]!) / 2n;
  return { perReturn: { amount: formatAmount(median), currency }, priced: charges.length, returns: returned.length };
}

/** n × a money amount, exactly. */
export function times(m: Money, n: number): Money {
  return { amount: formatAmount(parseAmount(m.amount)! * BigInt(n)), currency: m.currency };
}
