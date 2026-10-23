/**
 * Converting into the book's currency (Books v1.1 V1, D-65, D-89 lifted),
 * pure. A rate is "units of the book's currency per one unit of the other"
 * (PKR per AED), as `fx_rates` keeps it. Amounts are decimal strings, kept
 * at 6 places so a converted order's parts still add up before Books rounds
 * each day's totals to its own minor units.
 */

const RATE_PLACES = 12;
const AMOUNT_PLACES = 6;

function scaled(value: string, places: number): bigint | null {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = (m[3] ?? "").slice(0, places).padEnd(places, "0");
  const v = BigInt(m[2]!) * 10n ** BigInt(places) + BigInt(frac || "0");
  return m[1] ? -v : v;
}

/** amount × rate, half away from zero, as a decimal string with 6 places. */
export function convertAmount(amount: string, rate: string): string | null {
  const a = scaled(amount, AMOUNT_PLACES);
  const r = scaled(rate, RATE_PLACES);
  if (a === null || r === null || r <= 0n) return null;
  const p = a * r;
  const s = 10n ** BigInt(RATE_PLACES);
  const q = p >= 0n ? (p + s / 2n) / s : (p - s / 2n) / s;
  const neg = q < 0n;
  const abs = neg ? -q : q;
  const unit = 10n ** BigInt(AMOUNT_PLACES);
  return `${neg ? "-" : ""}${abs / unit}.${(abs % unit).toString().padStart(AMOUNT_PLACES, "0")}`;
}

/**
 * Every `{ amount, currency: from }` inside `value`, converted to `to` at
 * `rate`; everything else as it was. Null when an amount can't be read.
 */
export function convertMoneyTree<T>(value: T, from: string, to: string, rate: string): T | null {
  let bad = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.amount === "string" && o.currency === from) {
      const amount = convertAmount(o.amount, rate);
      if (amount === null) bad = true;
      return { ...o, amount: amount ?? o.amount, currency: to };
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
  };
  const out = walk(value) as T;
  return bad ? null : out;
}

export type BookRate = { rate: string; day: string; source: string };

/** How far back a missing day's rate may come from: weekends and gaps in a provider's days. */
export const RATE_LOOKBACK_DAYS = 7;

/** The rate for a currency on a day: that day's, else the latest within RATE_LOOKBACK_DAYS before it. */
export function pickRate(rates: ReadonlyArray<{ currency: string; day: string; rate: string; source: string }>, currency: string, day: string): BookRate | null {
  const earliest = new Date(Date.parse(`${day}T00:00:00Z`) - RATE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  let best: BookRate | null = null;
  for (const r of rates) {
    if (r.currency !== currency || r.day > day || r.day < earliest) continue;
    if (!best || r.day > best.day) best = { rate: r.rate, day: r.day, source: r.source };
  }
  return best;
}
