/**
 * Books money: integers in minor units (paisa, cents), never floats.
 *
 * Amounts travel as `bigint` inside the server and as decimal-integer strings
 * in JSON and form data ("1250000" = PKR 12,500.00 with 2 decimals), because
 * JSON has no bigint and a float would round.
 *
 * Parsing is strict on purpose: "12.555" with 2 decimals is rejected rather
 * than silently rounded, so what the merchant typed is exactly what is posted.
 */

export type MinorUnits = bigint;

const SUFFIX: Record<string, number> = { k: 3, m: 6 };

/**
 * Parse what a person types into an amount field.
 *
 * Accepts `12500`, `12,500`, `12,500.50`, `12.5k`, `1.2m`, with or without
 * spaces. Rejects negatives, empty input, letters and more decimals than the
 * currency has. Returns null when the input is not an amount.
 */
export function parseAmount(input: string, decimals: number): MinorUnits | null {
  const raw = String(input ?? "").trim().toLowerCase().replace(/[\s,]/g, "");
  // A trailing dot ("1000.") is accepted: people type it on the way to the decimals.
  const match = /^(\d*)(?:\.(\d*))?([km])?$/.exec(raw);
  if (!match || (!match[1] && !match[2])) return null;
  const whole = match[1] || "0";
  const frac = match[2] ?? "";
  const shift = match[3] ? SUFFIX[match[3]] : 0;

  // Move the decimal point right by `shift` (12.5k → 12500), then require the
  // remaining fraction to fit the currency's decimals.
  let digits = whole + frac;
  let point = whole.length + shift!;
  if (point > digits.length) digits = digits.padEnd(point, "0");
  const intPart = digits.slice(0, point);
  const fracPart = digits.slice(point).replace(/0+$/, "");
  if (fracPart.length > decimals) return null;
  const minor = BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt((fracPart.padEnd(decimals, "0")) || "0");
  return minor;
}

/** "1250000" → 1250000n; anything else → null. For amounts coming back from JSON. */
export function minorFromString(s: unknown): MinorUnits | null {
  if (typeof s === "bigint") return s;
  if (typeof s === "number" && Number.isSafeInteger(s)) return BigInt(s);
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) return null;
  return BigInt(s);
}

function group(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface FormatOptions {
  /** How a negative shows: "−1,000" for owners, "(1,000)" in Accountant view. */
  negative?: "minus" | "brackets";
  /** Prefix with the currency code: "PKR 1,000". */
  currency?: string;
  /** Hide ".00" when the amount is whole. Default true. */
  trimZeroFraction?: boolean;
}

/** 1250050n with 2 decimals → "12,500.50". Uses a true minus sign (U+2212). */
export function formatAmount(minor: MinorUnits, decimals: number, opts: FormatOptions = {}): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const base = 10n ** BigInt(decimals);
  const intDigits = (abs / base).toString();
  let frac = decimals > 0 ? (abs % base).toString().padStart(decimals, "0") : "";
  if ((opts.trimZeroFraction ?? true) && /^0*$/.test(frac)) frac = "";
  let body = group(intDigits) + (frac ? `.${frac}` : "");
  if (opts.currency) body = `${opts.currency} ${body}`;
  if (!neg) return body;
  return opts.negative === "brackets" ? `(${body})` : `−${body}`;
}

/** The plain editable form of an amount: 1250050n → "12500.5". */
export function toInputString(minor: MinorUnits, decimals: number): string {
  return formatAmount(minor, decimals, { trimZeroFraction: true }).replace(/,/g, "").replace("−", "-");
}

/** Decimal places for a currency. Covers the zero- and three-decimal ISO codes. */
export function currencyDecimals(code: string): number {
  const zero = ["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "PYG", "RWF", "KMF", "GNF", "DJF", "VUV", "XPF", "BIF"];
  const three = ["BHD", "KWD", "OMR", "JOD", "TND", "LYD", "IQD"];
  const c = code.toUpperCase();
  if (zero.includes(c)) return 0;
  if (three.includes(c)) return 3;
  return 2;
}
