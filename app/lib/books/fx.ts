/**
 * Foreign-currency arithmetic, pure and browser-safe. Rates are "units of
 * the book's currency per one unit of the foreign currency" (USD→PKR 279.5),
 * up to 8 decimals, held as integers scaled by 10^8.
 */

import { currencyDecimals } from "./money";

const RATE_SCALE = 100_000_000n;

/** "279.5" → 27950000000n; null when it isn't a positive rate. */
export function parseFxRate(input: string): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d{1,9}(\.\d{1,8})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const v = BigInt(w!) * RATE_SCALE + BigInt((f + "00000000").slice(0, 8));
  return v > 0n ? v : null;
}

export function formatFxRate(scaled: bigint): string {
  const w = scaled / RATE_SCALE;
  const f = (scaled % RATE_SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : `${w}`;
}

/** Divide rounding half away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  const neg = a < 0n !== b < 0n;
  const [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  const q = (x * 2n + y) / (2n * y);
  return neg ? -q : q;
}

/** A foreign amount (its own minor units) in the book's minor units at a rate. */
export function toBookAmount(foreignMinor: bigint, foreignCurrency: string, bookDecimals: number, rateScaled: bigint): bigint {
  const fd = BigInt(currencyDecimals(foreignCurrency));
  return divRound(foreignMinor * rateScaled * 10n ** BigInt(bookDecimals), RATE_SCALE * 10n ** fd);
}

/** The rate a book amount and a foreign amount imply (for showing what was used). */
export function impliedRate(bookMinor: bigint, bookDecimals: number, foreignMinor: bigint, foreignCurrency: string): bigint | null {
  if (foreignMinor === 0n) return null;
  const fd = BigInt(currencyDecimals(foreignCurrency));
  return divRound(bookMinor * RATE_SCALE * 10n ** fd, foreignMinor * 10n ** BigInt(bookDecimals));
}
