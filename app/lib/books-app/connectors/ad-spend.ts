/**
 * Ad spend into the books (B3), as pure rules.
 *
 * Growzar already holds each store's spend per platform per day, converted to
 * the store's currency by Financify, with the taxes and charges Financify
 * adds on top (`ad_spend` rows at level "platform"). So unlike Financify's
 * Books, which re-read the platforms and applied fee percentages itself, this
 * connector posts exactly what Finance shows:
 *
 *   Dr Advertising                 spend
 *   Dr taxes and charges           fees (an expense, or an asset you claim back)
 *   Cr where it was paid from      spend + fees
 *
 * One entry per store, platform and day (source `ad_spend`, ref
 * `<storeId>:<platform>:<day>`). A saved day is never edited: when the
 * platform later corrects it, the difference posts as a correction
 * (`…:c<n>`), dated on the spend day while that day's month is open, else on
 * the day the change is seen (D-74, D-84). Growzar re-reads the last 30 days
 * every day (D-85), and changes are found by comparing values.
 */

export const AD_PLATFORM_NAMES: Record<string, string> = {
  facebook: "Meta (Facebook & Instagram)",
  tiktok: "TikTok",
  google: "Google",
  snapchat: "Snapchat",
};

export const platformName = (p: string) => AD_PLATFORM_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

export interface AdPlatformMapping {
  /** The expense the spend goes to. */
  advertising: string;
  /** Where the taxes and charges on it go: an expense, or an asset when you can claim them back. */
  fees: string;
  /** The card, bank account, ad wallet or payable it was charged to. */
  paidFrom: string;
}

export interface AdSpendSettings {
  /** Per platform key as Growzar stores it ("facebook", "tiktok", …). */
  platforms: Record<string, AdPlatformMapping>;
}

export type Lines = Array<{ accountId: string; amount: string }>;
export type Posting = { debits: Lines; credits: Lines };

/** A decimal string (as stored, up to 6 places) → minor units, half away from zero. */
export function decimalToMinor(value: string, decimals: number): bigint {
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!m || (!m[2] && !m[3])) throw new Error(`Not an amount: ${value}`);
  const frac = m[3] ?? "";
  let v = BigInt(m[2] || "0") * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals).padEnd(decimals, "0") || "0");
  if (frac.length > decimals && Number(frac[decimals]) >= 5) v += 1n;
  return m[1] ? -v : v;
}

/** Signed sums per account (+debit / −credit) → the document's debits and credits. */
export function toPosting(sums: Map<string, bigint>): Posting {
  const debits: Lines = [];
  const credits: Lines = [];
  for (const [accountId, v] of [...sums].sort(([a], [b]) => a.localeCompare(b))) {
    if (v > 0n) debits.push({ accountId, amount: v.toString() });
    else if (v < 0n) credits.push({ accountId, amount: (-v).toString() });
  }
  return { debits, credits };
}

/** A posting's lines → signed sums per account. */
export function toSums(p: { debits?: Lines; credits?: Lines } | null | undefined): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (id: string, v: bigint) => out.set(id, (out.get(id) ?? 0n) + v);
  for (const l of p?.debits ?? []) add(l.accountId, BigInt(l.amount));
  for (const l of p?.credits ?? []) add(l.accountId, -BigInt(l.amount));
  return out;
}

/** One platform-day: spend and fees in minor units of the book's currency. */
export function buildAdDay(spend: bigint, fees: bigint, m: AdPlatformMapping): Map<string, bigint> {
  const sums = new Map<string, bigint>();
  const add = (id: string, v: bigint) => v !== 0n && sums.set(id, (sums.get(id) ?? 0n) + v);
  add(m.advertising, spend);
  add(m.fees, fees);
  add(m.paidFrom, -(spend + fees));
  return sums;
}

/** What is still to post: current figures less everything already saved for the day. */
export function difference(current: Map<string, bigint>, booked: Map<string, bigint>[]): Map<string, bigint> {
  const out = new Map(current);
  for (const b of booked) for (const [id, v] of b) out.set(id, (out.get(id) ?? 0n) - v);
  for (const [id, v] of out) if (v === 0n) out.delete(id);
  return out;
}

/** D-84: on the spend day while it's open, else the day the change is seen. */
export function correctionDate(day: string, lockedThrough: string | null, today: string): string {
  return lockedThrough && day <= lockedThrough ? today : day;
}

/**
 * The days a run looks at: from the start, or the day after the last run's
 * end, and always the last `window` days (Growzar re-reads 30), at most
 * `maxDays` per run; a run that falls behind carries on next time.
 */
export function daysToCheck(start: string, syncedThrough: string | null, yesterday: string, addDays: (d: string, n: number) => string, window = 35, maxDays = 62): { from: string; to: string } | null {
  let from = syncedThrough ? addDays(syncedThrough, 1) : start;
  const recheck = addDays(yesterday, -(window - 1));
  if (syncedThrough && recheck < from) from = recheck;
  if (from < start) from = start;
  const capped = addDays(from, maxDays - 1);
  const to = capped < yesterday ? capped : yesterday;
  return from > to ? null : { from, to };
}
