/**
 * Past days' exchange rates (D-98), pure: fawazahmed0's currency-api gives,
 * for one base, how many units of every other currency one unit of the base
 * buys. `fx_rates` keeps the opposite: units of the base per one unit of the
 * other currency (PKR per AED, 75.44), so each rate is inverted.
 */

export const FX_HISTORY_SOURCE = "fawazahmed0 currency-api (jsDelivr)";

/** The first day Growzar fills in: Books' earliest start (D-98). */
export const FX_HISTORY_FROM = "2026-07-01";

export const fxHistoryUrl = (base: string, day: string) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/${base.toLowerCase()}.min.json`;

/** 1 / x as a plain decimal string with up to 12 decimals (what fx.ts reads), or null for nothing usable. */
export function inverseRate(x: unknown): string | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return null;
  const v = 1 / x;
  const s = v >= 1 ? Number(v.toPrecision(12)).toString() : v.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  return /^\d+(\.\d{1,12})?$/.test(s) && /[1-9]/.test(s) ? s : null;
}

/** One day's response as `fx_rates` rows for `base`; empty when the response isn't that day's or that base's. */
export function historyRows(base: string, day: string, body: unknown): Array<{ base: string; currency: string; day: string; rate: string; source: string }> {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const rates = b[base.toLowerCase()];
  if (b.date !== day || !rates || typeof rates !== "object") return [];
  const out = [];
  for (const [code, x] of Object.entries(rates as Record<string, unknown>)) {
    const currency = code.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || currency === base) continue;
    const rate = inverseRate(x);
    if (rate) out.push({ base, currency, day, rate, source: FX_HISTORY_SOURCE });
  }
  return out;
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
