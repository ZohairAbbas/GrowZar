/**
 * Currency conversion for multi-currency totals (rule #4, O-2, G-GZR2-4).
 *
 * Rule #4: each store keeps its own currency; totals across currencies
 * convert to the organization's base currency at the **historical daily
 * rate**, and the rate is shown. Mixed currencies are never added.
 *
 * **No rate source is connected yet.** O-2 names Financify's converter, but
 * Financify exposes no rate endpoint and its converter has only ever held
 * live rates (its Phase 1 report). The human's decision (2026-09-30):
 * totals are shown per currency now, and conversion switches on when
 * Financify serves daily rates. Until then `NO_FX_SOURCE` answers "unknown"
 * for every pair, and every foreign amount is reported as unconverted —
 * listed beside the converted total, never dropped and never added at 1.
 *
 * Amounts are converted per day, because an AED order in July and one in
 * September are worth different amounts of PKR. A rate is used only for its
 * own day; there is no "nearest day" fallback, which is how a wrong rate
 * gets used quietly.
 */
import { formatAmount, parseAmount, type Money } from "./money";

export type FxRate = {
  from: string;
  to: string;
  /** The day the rate is for (`YYYY-MM-DD`). */
  day: string;
  /** Units of `to` per one `from`, as a decimal string. */
  rate: string;
  /** Where it came from, shown beside every converted figure. */
  source: string;
};

export interface FxSource {
  readonly name: string;
  rateFor(from: string, to: string, day: string): FxRate | null;
}

/** The only source today: knows nothing, so converts nothing. */
export const NO_FX_SOURCE: FxSource = {
  name: "none (awaiting Financify daily rates)",
  rateFor: () => null,
};

/** An amount on a day, which is what a historical rate converts. */
export type DatedMoney = { day: string; money: Money };

export type Conversion = {
  base: string;
  /** Sum of everything that could be expressed in `base`: amounts already in it plus converted ones. */
  total: Money;
  /** True only when nothing was left unconverted. */
  complete: boolean;
  /** Per currency, what could not be converted, with the days lacking a rate. */
  unconverted: Array<{ money: Money; days: string[] }>;
  /** Every rate used, one per currency and day, to show beside the total. */
  ratesUsed: FxRate[];
  source: string;
};

const RATE_SCALE = 1_000_000n; // rates carried to six decimals

function parseRate(rate: string): bigint | null {
  const units = parseAmount(rate); // millionths, same scale as money
  return units !== null && units > 0n ? units : null;
}

/**
 * Convert dated amounts into `base`. Amounts already in `base` pass through;
 * the rest convert at their own day's rate or are listed as unconverted.
 */
export function convertDated(values: readonly DatedMoney[], base: string, source: FxSource): Conversion {
  let total = 0n;
  const unconverted = new Map<string, { units: bigint; days: Set<string> }>();
  const ratesUsed = new Map<string, FxRate>();

  for (const { day, money } of values) {
    const units = parseAmount(money.amount);
    if (units === null) continue;
    if (money.currency === base) {
      total += units;
      continue;
    }
    const rate = source.rateFor(money.currency, base, day);
    const r = rate ? parseRate(rate.rate) : null;
    if (!rate || r === null) {
      const entry = unconverted.get(money.currency) ?? { units: 0n, days: new Set<string>() };
      entry.units += units;
      entry.days.add(day);
      unconverted.set(money.currency, entry);
      continue;
    }
    // money (millionths) × rate (millionths) ÷ 10^6, rounded half away from zero.
    const product = units * r;
    const half = RATE_SCALE / 2n;
    total += product >= 0n ? (product + half) / RATE_SCALE : (product - half) / RATE_SCALE;
    ratesUsed.set(`${money.currency}|${day}`, rate);
  }

  return {
    base,
    total: { amount: formatAmount(total), currency: base },
    complete: unconverted.size === 0,
    unconverted: [...unconverted]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, e]) => ({
        money: { amount: formatAmount(e.units), currency },
        days: [...e.days].sort(),
      })),
    ratesUsed: [...ratesUsed.values()].sort((a, b) => a.day.localeCompare(b.day) || a.from.localeCompare(b.from)),
    source: source.name,
  };
}

/** A source over a fixed list of rates — for tests, and for the day Financify serves them. */
export function tableSource(name: string, rates: readonly FxRate[]): FxSource {
  const byKey = new Map(rates.map((r) => [`${r.from}|${r.to}|${r.day}`, r]));
  return { name, rateFor: (from, to, day) => byKey.get(`${from}|${to}|${day}`) ?? null };
}
