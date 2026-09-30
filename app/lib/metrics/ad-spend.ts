/**
 * Financify's `/api/v1/ad-spend` for one day, as Growzar stores it
 * (G-GZR2-3). Pure: the refresh fetches, this decides what the answer means.
 *
 * Four levels, each labelled with how it was known:
 *  - `platform` × day — **measured**: what the ad platform reported. Its
 *    campaign coverage (spend no campaign accounts for) rides along.
 *  - `campaign` × day — **measured**.
 *  - `product` × day — **allocated**: Financify distributes spend to products
 *    by evidence (own orders, nearby days, campaign name, platform
 *    attribution). Never presented as measured (pack G-GZR2-3).
 *  - `product_unattributed` — the spend Financify could not place.
 * plus one `day` row: the platform total, and the proof the day was fetched
 * even when nothing was spent.
 *
 * Days are the ad account's reporting day, not the shop's (`dateBasis:
 * "ad_platform_day"`); a roll-up that sets them beside order days says so.
 */
import { formatAmount, parseAmount, readMoney, type Money } from "./money";

export type AdSpendRow = {
  day: string;
  level: "day" | "platform" | "campaign" | "product" | "product_unattributed";
  key: string;
  platform: string | null;
  spend: Money;
  fees: Money;
  method: "measured" | "allocated";
  fxStatus: string | null;
  detail: Record<string, unknown>;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export type ParsedAdSpend = { rows: AdSpendRow[]; problems: string[] };

export function parseAdSpendDay(day: string, body: unknown, shopCurrency: string): ParsedAdSpend {
  const b = obj(body);
  const rows: AdSpendRow[] = [];
  const problems: string[] = [];
  const zero = { amount: "0.00", currency: shopCurrency };

  if (b.dateBasis !== "ad_platform_day") {
    problems.push(`dateBasis is ${String(b.dateBasis)}, expected ad_platform_day`);
  }

  const coverage = new Map<string, Record<string, unknown>>();
  for (const c of arr(b.campaignCoverage)) {
    const row = obj(c);
    if (row.date === day && str(row.platform)) coverage.set(str(row.platform)!, row);
  }

  let totalSpend = 0n;
  let totalFees = 0n;
  let platforms = 0;

  for (const p of arr(b.platformDays)) {
    const row = obj(p);
    if (row.date !== day) continue;
    const platform = str(row.platform);
    const spend = readMoney(row.spend);
    const fees = readMoney(row.fees) ?? zero;
    if (!platform || !spend) {
      problems.push(`platform row without platform or spend on ${day}`);
      continue;
    }
    const fx = obj(row.fx);
    rows.push({
      day,
      level: "platform",
      key: platform,
      platform,
      spend,
      fees,
      method: "measured",
      fxStatus: str(fx.status),
      detail: { accountIds: row.accountIds ?? [], fx, coverage: coverage.get(platform) ?? null },
    });
    // The day total is in the shop's currency only. A row Financify could
    // not convert is kept, flagged, and left out of the total (rule #4).
    if (spend.currency === shopCurrency) {
      totalSpend += parseAmount(spend.amount)!;
      if (fees.currency === shopCurrency) totalFees += parseAmount(fees.amount)!;
    } else {
      problems.push(`${platform} spend on ${day} is in ${spend.currency}, not ${shopCurrency}`);
    }
    platforms += 1;
  }

  for (const c of arr(b.campaigns)) {
    const row = obj(c);
    if (row.date !== day) continue;
    const platform = str(row.platform);
    const id = str(row.campaignId);
    const spend = readMoney(row.spend);
    if (!platform || !id || !spend) continue;
    rows.push({
      day,
      level: "campaign",
      key: `${platform}:${id}`,
      platform,
      spend,
      fees: readMoney(row.fees) ?? zero,
      method: "measured",
      fxStatus: str(obj(row.fx).status),
      detail: { campaignName: row.campaignName ?? null, accountId: row.accountId ?? null, sourceSpend: row.sourceSpend ?? null },
    });
  }

  const products = obj(b.products);
  for (const item of arr(products.items)) {
    const row = obj(item);
    const key = str(row.variantId) ?? str(row.productId);
    const spend = readMoney(row.spend);
    if (!key || !spend) continue;
    rows.push({
      day,
      level: "product",
      key,
      platform: null,
      spend,
      fees: readMoney(row.fees) ?? zero,
      method: "allocated",
      fxStatus: null,
      detail: {
        productId: row.productId ?? null,
        title: row.title ?? null,
        byPlatform: row.byPlatform ?? [],
        campaignMatchedShare: row.campaignMatchedShare ?? null,
        evidence: row.evidence ?? {},
      },
    });
  }
  const unattributed = obj(products.unattributed);
  const unattributedSpend = readMoney(unattributed.spend);
  if (unattributedSpend) {
    rows.push({
      day,
      level: "product_unattributed",
      key: "_",
      platform: null,
      spend: unattributedSpend,
      fees: readMoney(unattributed.fees) ?? zero,
      method: "allocated",
      fxStatus: null,
      detail: { reasons: unattributed.reasons ?? {} },
    });
  }

  rows.push({
    day,
    level: "day",
    key: "_",
    platform: null,
    spend: { amount: formatAmount(totalSpend), currency: shopCurrency },
    fees: { amount: formatAmount(totalFees), currency: shopCurrency },
    method: "measured",
    fxStatus: null,
    detail: {
      platforms,
      productAllocation: products.method ? { method: products.method, basis: products.basis ?? null } : null,
      attributionCoverage: products.attributionCoverage ?? null,
    },
  });

  return { rows, problems };
}
