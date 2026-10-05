/**
 * Currency conversion for multi-currency totals (rule #4, O-2, G-GZR2-4).
 *
 * Rule #4: each store keeps its own currency; totals across currencies
 * convert to the organization's base currency at the **historical daily
 * rate**, and the rate is shown. Mixed currencies are never added.
 *
 * **The source is Financify's daily rates** (G-FIN2-1, `GET /api/v1/fx`),
 * stored by the worker in `fx_rates` (fx.server.ts). Financify keeps rates
 * from 2026-10-05 only (its provider has no history), so an earlier amount
 * has no rate and is reported as unconverted: listed beside the converted
 * total, never dropped and never added at 1 (human, 2026-10-05: keep it
 * separate and labelled rather than approximate it).
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
  name: "none",
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

/** Rates carry 12 decimals: 1 IDR is 0.0173 PKR, and six would round that away. */
const RATE_DECIMALS = 12;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);

function parseRate(rate: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!m || (m[2] ?? "").length > RATE_DECIMALS) return null;
  const units = BigInt(m[1]!) * RATE_SCALE + BigInt((m[2] ?? "").padEnd(RATE_DECIMALS, "0"));
  return units > 0n ? units : null;
}

/** money (millionths) × rate, rounded half away from zero, still in millionths. */
function applyRate(units: bigint, rate: bigint): bigint {
  const product = units * rate;
  const half = RATE_SCALE / 2n;
  return product >= 0n ? (product + half) / RATE_SCALE : (product - half) / RATE_SCALE;
}

/**
 * One amount in `base` at its own day's rate: the same amount when already
 * in `base`, null when there is no rate for that currency and day.
 */
export function convertOne(money: Money, base: string, day: string | null, source: FxSource): { money: Money; rate: FxRate | null } | null {
  if (money.currency === base) return { money, rate: null };
  if (!day) return null;
  const units = parseAmount(money.amount);
  const rate = source.rateFor(money.currency, base, day);
  const r = rate ? parseRate(rate.rate) : null;
  if (units === null || !rate || r === null) return null;
  return { money: { amount: formatAmount(toCents(applyRate(units, r))), currency: base }, rate };
}

/**
 * A converted amount rounded to the cent (paisa), half away from zero: each
 * order's converted money is an amount in its own right, and screens show
 * two decimals, so carrying fractions of a paisa would only make totals
 * disagree with the orders behind them.
 */
function toCents(units: bigint): bigint {
  const cent = 10_000n; // millionths per cent
  const half = cent / 2n;
  return units >= 0n ? ((units + half) / cent) * cent : ((units - half) / cent) * cent;
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
    total += applyRate(units, r);
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
