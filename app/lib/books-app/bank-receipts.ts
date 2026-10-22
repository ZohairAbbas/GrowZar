import { formatAmount } from "../books/money";

/** One courier payout and whether it reached the bank (bank-receipts.server.ts). */
export type PayoutLine = { day: string; net: bigint; inBankOn: string | null; courier: string | null };

export type BankSummary = {
  /** Courier payouts dated in the period, and how many the bank shows. */
  payouts: number;
  inBank: number;
  /** As Growzar's money: decimal strings in the book's currency. */
  received: { amount: string; currency: string };
  notYet: { amount: string; currency: string };
  /** The latest day the bank shows a courier payout. */
  lastInBankOn: string | null;
};

/** "Received in bank" for a period (rule #17's second stage): payouts dated in it, by what the bank shows. */
export function bankSummary(payouts: readonly PayoutLine[], currency: string, decimals: number): BankSummary {
  let received = 0n;
  let notYet = 0n;
  let last: string | null = null;
  for (const p of payouts) {
    if (p.inBankOn) {
      received += p.net;
      if (!last || p.inBankOn > last) last = p.inBankOn;
    } else notYet += p.net;
  }
  const money = (v: bigint) => ({ amount: formatAmount(v, decimals, { trimZeroFraction: false }).replace(/,/g, "").replace("−", "-"), currency });
  return { payouts: payouts.length, inBank: payouts.filter((p) => p.inBankOn).length, received: money(received), notYet: money(notYet), lastInBankOn: last };
}

/** Each courier's latest payout the bank shows, for the cash-held card (D-93). */
export function lastInBankByCourier(payouts: readonly PayoutLine[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of payouts) {
    if (!p.courier || !p.inBankOn) continue;
    const k = p.courier.toLowerCase();
    if (!out.has(k) || p.inBankOn > out.get(k)!) out.set(k, p.inBankOn);
  }
  return out;
}
