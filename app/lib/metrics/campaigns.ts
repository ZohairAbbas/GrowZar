/**
 * Campaign spend and store-versus-store comparison (Phase 4b, D5). Pure.
 *
 * Campaigns: Financify reports spend per campaign (`method: "measured"`,
 * ad-platform days). It does not say which campaign an order came from, so
 * orders, delivered revenue and return rate per campaign are not computed;
 * the coverage panel says so once. What is here is spend, fees, how long each
 * campaign ran, and how its spend moved against the previous period.
 */
import { countDelta, moneyDelta, MIN_DECIDED_TO_RATE, type Delta } from "./compare";
import { formatAmount, parseAmount, type Money } from "./money";
import type { Bucket, Profit } from "./rollups";
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
