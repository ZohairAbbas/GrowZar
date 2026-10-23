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

/**
 * A posting's sums (book currency, ledger sign) with what a store in another
 * currency is owed kept in that currency (v1.1 V1b, D-99): each foreign
 * "owed" account gets one line, carrying its foreign amount for the engine.
 * Where the book amount and the foreign amount don't go the same way (a day
 * whose only change is a rate, or a refund at an older order's rate), the
 * foreign amount is valued at `rate` and the rest is an exchange difference,
 * posted to `gains`.
 *
 * `toBook(foreignMinor, accountId)` values a foreign amount in the book's
 * currency at the day's rate.
 */
export function foreignLines(
  sums: ReadonlyMap<string, bigint>,
  foreign: ReadonlyMap<string, bigint>,
  toBook: (foreignMinor: bigint, accountId: string) => bigint,
  gains: string,
): { sums: Map<string, bigint>; fx: Record<string, { amount: string }> } {
  const out = new Map(sums);
  const fx: Record<string, { amount: string }> = {};
  const add = (id: string, v: bigint) => {
    const n = (out.get(id) ?? 0n) + v;
    if (n === 0n) out.delete(id);
    else out.set(id, n);
  };
  const ids = new Set([...foreign.keys()].filter((id) => (foreign.get(id) ?? 0n) !== 0n || (sums.get(id) ?? 0n) !== 0n));
  for (const id of [...sums.keys()]) if (foreign.has(id)) ids.add(id);
  for (const id of ids) {
    const book = sums.get(id) ?? 0n;
    const f = foreign.get(id) ?? 0n;
    if (f !== 0n && book !== 0n && (f > 0n) === (book > 0n)) {
      fx[id] = { amount: (f < 0n ? -f : f).toString() };
      continue;
    }
    // Only a rate's worth, or the two disagree: value the foreign amount at the day's rate, the rest is exchange.
    out.delete(id);
    const valued = f === 0n ? 0n : toBook(f, id);
    if (valued !== 0n) {
      out.set(id, valued);
      fx[id] = { amount: (f < 0n ? -f : f).toString() };
    }
    if (book - valued !== 0n) add(gains, book - valued);
  }
  return { sums: out, fx };
}

/** Every month end from a book's start to the last one already over: the month ends to revalue (D-99). */
export function monthEndsDue(start: string, today: string): string[] {
  const end = (iso: string) => {
    const [y, m] = iso.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };
  const out: string[] = [];
  for (let d = end(start); d < today; d = end(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10))) out.push(d);
  return out;
}
