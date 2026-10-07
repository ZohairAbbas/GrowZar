/**
 * Campaign spend and store-versus-store comparison (Phase 4b, D5). Pure.
 *
 * Campaigns: Financify reports spend per campaign (`method: "measured"`,
 * ad-platform days) and, since G-FIN3-1, which campaign each order came from
 * (`attribution.campaignKey`). Spend, fees and how long each campaign ran come
 * from the first; orders, outcomes, ROAS on delivered revenue and return rate
 * per campaign from the second (`campaignOutcomes`).
 */
import { countDelta, moneyDelta, MIN_DECIDED_TO_RATE, type Delta } from "./compare";
import { formatAmount, parseAmount, type Money } from "./money";
import type { Bucket, Profit, RollupOrder } from "./rollups";
import type { Conversion } from "./fx";

export type CampaignSpendRow = {
  day: string;
  key: string;
  platform: string | null;
  name: string | null;
  spend: Money;
  fees: Money;
};

export type CampaignLine = {
  key: string;
  platform: string;
  name: string;
  spend: Money;
  fees: Money;
  /** Share of the period's campaign spend, percent. */
  share: number;
  daysWithSpend: number;
  firstDay: string;
  lastDay: string;
  /** Spend against the previous period; a campaign new this period has no previous. */
  change: Delta;
};

export type CampaignSpend = {
  currency: string;
  total: Money;
  fees: Money;
  platforms: Array<{ platform: string; spend: Money; share: number; campaigns: number }>;
  campaigns: CampaignLine[];
  /** Spend in another currency (Financify converts; a failed conversion stays apart). */
  otherCurrencies: string[];
};

const sumUnits = (list: Money[], currency: string) =>
  list.reduce((a, m) => a + (m.currency === currency ? parseAmount(m.amount)! : 0n), 0n);
const money = (u: bigint, currency: string): Money => ({ amount: formatAmount(u), currency });
const share = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1000n) / whole) / 10 : 0);

export function campaignSpend(rows: readonly CampaignSpendRow[], previous: readonly CampaignSpendRow[], currency: string): CampaignSpend {
  const mine = rows.filter((r) => r.spend.currency === currency);
  const byKey = new Map<string, CampaignSpendRow[]>();
  for (const r of mine) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  const prevBy = new Map<string, bigint>();
  for (const r of previous) if (r.spend.currency === currency) prevBy.set(r.key, (prevBy.get(r.key) ?? 0n) + parseAmount(r.spend.amount)!);
  const total = sumUnits(mine.map((r) => r.spend), currency);

  const campaigns = [...byKey.entries()]
    .map(([key, list]): CampaignLine => {
      const spend = sumUnits(list.map((r) => r.spend), currency);
      const days = list.filter((r) => parseAmount(r.spend.amount)! > 0n).map((r) => r.day).sort();
      const prev = prevBy.get(key);
      return {
        key,
        platform: list.find((r) => r.platform)?.platform ?? key.split(":")[0] ?? "unknown",
        name: [...list].reverse().find((r) => r.name)?.name ?? key,
        spend: money(spend, currency),
        fees: money(sumUnits(list.map((r) => r.fees), currency), currency),
        share: share(spend, total),
        daysWithSpend: new Set(days).size,
        firstDay: days[0] ?? list[0]!.day,
        lastDay: days.at(-1) ?? list[0]!.day,
        change: moneyDelta(money(spend, currency), prev === undefined ? null : money(prev, currency), currency),
      };
    })
    .filter((c) => parseAmount(c.spend.amount)! > 0n)
    .sort((a, b) => (parseAmount(b.spend.amount)! > parseAmount(a.spend.amount)! ? 1 : -1));

  const platforms = new Map<string, { units: bigint; campaigns: number }>();
  for (const c of campaigns) {
    const p = platforms.get(c.platform) ?? { units: 0n, campaigns: 0 };
    p.units += parseAmount(c.spend.amount)!;
    p.campaigns += 1;
    platforms.set(c.platform, p);
  }
  return {
    currency,
    total: money(total, currency),
    fees: money(sumUnits(mine.map((r) => r.fees), currency), currency),
    platforms: [...platforms.entries()]
      .map(([platform, p]) => ({ platform, spend: money(p.units, currency), share: share(p.units, total), campaigns: p.campaigns }))
      .sort((a, b) => b.share - a.share),
    campaigns,
    otherCurrencies: [...new Set(rows.filter((r) => r.spend.currency !== currency).map((r) => r.spend.currency))],
  };
}

// ── Store versus store ─────────────────────────────────────────────────────

export type StoreColumn = {
  storeId: string;
  name: string;
  currency: string | null;
  period: { from: string; to: string };
  orders: number;
  delivered: number;
  decided: number;
  stillOpen: number;
  /** Percent, null under MIN_DECIDED_TO_RATE decided orders. */
  deliveryRate: number | null;
  returnRate: number | null;
  /** In the organization's base currency at each order day's rate (rule #4), with the rates. */
  placed: Conversion | null;
  deliveredRevenue: Conversion | null;
  /** In the store's own currency; converted only when it is the base. */
  profit: (Profit & { inBase: boolean }) | null;
  adSpend: Money[] | null;
  roas: number | null;
  courierifyShare: number | null;
  /** Orders against the store's own previous period. */
  ordersChange: Delta;
};

export function storeColumn(input: {
  storeId: string;
  name: string;
  currency: string | null;
  base: string;
  period: { from: string; to: string };
  orders: Bucket;
  previousOrders: number | null;
  placed: Conversion | null;
  deliveredRevenue: Conversion | null;
  profit: Profit | null;
  adSpend: Money[] | null;
  roas: number | null;
  courierify: { shippedOrders: number; withParcel: number };
}): StoreColumn {
  const r = input.orders.deliveryRate;
  const decided = r.delivered + r.returned;
  const rated = decided >= MIN_DECIDED_TO_RATE;
  return {
    storeId: input.storeId,
    name: input.name,
    currency: input.currency,
    period: input.period,
    orders: input.orders.orders,
    delivered: r.delivered,
    decided,
    stillOpen: r.stillOpen,
    deliveryRate: rated ? Math.round((1000 * r.delivered) / decided) / 10 : null,
    returnRate: rated ? Math.round((1000 * r.returned) / decided) / 10 : null,
    placed: input.placed,
    deliveredRevenue: input.deliveredRevenue,
    profit: input.profit ? { ...input.profit, inBase: input.profit.currency === input.base } : null,
    adSpend: input.adSpend,
    roas: input.roas,
    courierifyShare: input.courierify.shippedOrders
      ? Math.round((1000 * input.courierify.withParcel) / input.courierify.shippedOrders) / 10
      : null,
    ordersChange: countDelta(input.orders.orders, input.previousOrders),
  };
}

// ── Campaign outcomes (Phase 4c, step 3) ───────────────────────────────────

/** Financify's order → campaign link (G-FIN3-1), as Growzar stores it. */
export type OrderAttribution = {
  campaignKey: string | null;
  platform: string | null;
  /** utm_id | mapping | utm_only | none | affiliate; null when Financify has no record yet. */
  method: string | null;
};

export type CampaignOutcome = {
  key: string;
  platform: string;
  name: string;
  /** Spend in the period (measured), null when the campaign spent nothing in it. */
  spend: Money | null;
  orders: number;
  delivered: number;
  returned: number;
  stillOpen: number;
  /**
   * Orders whose outcome no app will learn (withheld as one-sided, e.g.
   * shipped with a courier booked outside Shopify and Courierify).
   */
  notTrackable: number;
  decided: number;
  deliveredRevenue: Money;
  /** returned ÷ decided, percent; null under MIN_DECIDED_TO_RATE. */
  returnRate: number | null;
  /**
   * Delivered revenue ÷ (spend + fees); null without spend, or when more
   * than MAX_UNTRACKABLE_SHARE of the campaign's orders cannot be tracked —
   * their deliveries would never be counted, so the figure would read as
   * failure where it is only blindness.
   */
  roas: number | null;
  /** (spend + fees) ÷ delivered orders; null without either. */
  costPerDelivered: Money | null;
  /** How the orders were tied: by the campaign id in the UTM, or by name/mapping. */
  byId: number;
  byName: number;
};

export type CampaignOutcomes = {
  campaigns: CampaignOutcome[];
  /** Orders in the period with no campaign, by why. */
  unattributed: { untracked: number; affiliate: number; noRecord: number };
  /** Orders tied to a campaign, of orders Financify knows. */
  matched: number;
  of: number;
  storeReturnRate: number | null;
};

/**
 * What each campaign's orders did. Orders are the period's (store-local
 * days), tied by Financify's `campaignKey`; outcomes are Growzar's own, so a
 * campaign's returns are counted the way every other return is, one-sided
 * sources withheld. Spend is the period's measured spend plus platform fees,
 * so ROAS here and the store's ROAS use the same basis. A campaign with
 * orders but no spend in the period still appears, named from its whole
 * history (`names`).
 */
/** A campaign's ROAS is withheld above this share of orders whose outcome cannot be known. */
export const MAX_UNTRACKABLE_SHARE = 0.2;

export function campaignOutcomes(
  rows: readonly RollupOrder[],
  attribution: ReadonlyMap<string, OrderAttribution>,
  spend: CampaignSpend | null,
  names: ReadonlyMap<string, { name: string | null; platform: string | null }>,
  currency: string,
): CampaignOutcomes {
  const mine = rows.filter((o) => (o.placed?.currency ?? currency) === currency && attribution.has(o.orderId));
  const by = new Map<string, RollupOrder[]>();
  const unattributed = { untracked: 0, affiliate: 0, noRecord: 0 };
  for (const o of mine) {
    const a = attribution.get(o.orderId)!;
    if (a.campaignKey) by.set(a.campaignKey, [...(by.get(a.campaignKey) ?? []), o]);
    else if (a.method === "affiliate") unattributed.affiliate += 1;
    else if (a.method === null) unattributed.noRecord += 1;
    else unattributed.untracked += 1;
  }
  const spendBy = new Map((spend?.campaigns ?? []).map((c) => [c.key, c]));
  const keys = new Set([...by.keys(), ...spendBy.keys()]);
  const u = (m: Money | null | undefined) => (m && m.currency === currency ? parseAmount(m.amount)! : 0n);
  const decidedAll = mine.filter((o) => o.outcome === "delivered" || o.outcome === "returned");
  const returnedAll = decidedAll.filter((o) => o.outcome === "returned").length;

  const campaigns = [...keys].map((key): CampaignOutcome => {
    const list = by.get(key) ?? [];
    const s = spendBy.get(key);
    const delivered = list.filter((o) => o.outcome === "delivered");
    const returned = list.filter((o) => o.outcome === "returned").length;
    const decided = delivered.length + returned;
    const revenue = delivered.reduce((a, o) => a + u(o.delivered), 0n);
    const cost = s ? u(s.spend) + u(s.fees) : 0n;
    const notTrackable = list.filter((o) => o.outcome === "unknown").length;
    const live = list.filter((o) => o.outcome !== "order_cancelled" && o.outcome !== "shipment_cancelled").length;
    const blind = live > 0 && notTrackable > MAX_UNTRACKABLE_SHARE * live;
    const named = names.get(key);
    return {
      key,
      platform: s?.platform ?? named?.platform ?? key.split(":")[0] ?? "unknown",
      name: s?.name ?? named?.name ?? key,
      spend: s ? s.spend : null,
      orders: list.length,
      delivered: delivered.length,
      returned,
      stillOpen: list.filter((o) => ["in_transit", "booked", "not_shipped"].includes(o.outcome)).length,
      notTrackable,
      decided,
      deliveredRevenue: { amount: formatAmount(revenue), currency },
      returnRate: decided >= MIN_DECIDED_TO_RATE ? Math.round((1000 * returned) / decided) / 10 : null,
      roas: cost > 0n && !blind ? Number((revenue * 100n) / cost) / 100 : null,
      // Half-up to the cent (amounts are millionths).
      costPerDelivered:
        cost > 0n && delivered.length && !blind
          ? { amount: formatAmount(((cost / BigInt(delivered.length) + 5_000n) / 10_000n) * 10_000n), currency }
          : null,
      byId: list.filter((o) => attribution.get(o.orderId)!.method === "utm_id").length,
      byName: list.filter((o) => attribution.get(o.orderId)!.method === "mapping").length,
    };
  });
  return {
    campaigns: campaigns.sort((a, b) => u(b.spend) > u(a.spend) ? 1 : u(b.spend) < u(a.spend) ? -1 : b.orders - a.orders),
    unattributed,
    matched: mine.filter((o) => attribution.get(o.orderId)!.campaignKey).length,
    of: mine.length,
    storeReturnRate: decidedAll.length >= MIN_DECIDED_TO_RATE ? Math.round((1000 * returnedAll) / decidedAll.length) / 10 : null,
  };
}
