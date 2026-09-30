import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { appRequest } from "../apps/client.server";
import { getAppCredentials } from "../apps/registry.server";
import { convertDated, NO_FX_SOURCE, type Conversion, type FxSource } from "./fx";
import { formatAmount, parseAmount, sumByCurrency, type Money } from "./money";
import { compareSettings, type SettingsComparison, type StoreSettings } from "./profit-settings";
import { bucketOf, profitAfterReturns, roas, type Bucket, type Profit, type RollupOrder } from "./rollups";
import { loadAdSpend, loadOrders } from "./rollups.server";

/**
 * Store and organization grains (G-GZR2-4), rolled from the order grain and
 * ad spend — never from source rows.
 *
 * The target customer is a multi-store operator (D-20), so the organization
 * grain is not an afterthought: its totals are per currency (rule #4), its
 * converted totals exist only where every rate is known and show the rates,
 * and a roll-up across stores with different profit settings is flagged
 * with the settings that differ (rule #15).
 */

const SETTINGS_REFRESH_MS = 60 * 60 * 1000;

/** Read a store's profit settings from Financify, at most hourly. */
export async function refreshProfitSettings(storeId: string, now = new Date()): Promise<"fetched" | "fresh" | "no_financify"> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: {
      shopDomain: true,
      profitSettings: { select: { fetchedAt: true } },
      connections: { where: { app: "FINANCIFY", status: "CONNECTED" }, select: { app: true } },
    },
  });
  if (!store.connections.length) return "no_financify";
  if (store.profitSettings && now.getTime() - store.profitSettings.fetchedAt.getTime() < SETTINGS_REFRESH_MS) {
    return "fresh";
  }
  const credentials = getAppCredentials("FINANCIFY");
  if (!credentials) return "no_financify";
  const response = await appRequest<{ settings?: unknown; isDefault?: unknown; settingsHash?: unknown }>("FINANCIFY", {
    pathWithQuery: "/api/v1/settings/profit",
    shopDomain: store.shopDomain,
    credentials,
  });
  if (!response.ok) throw new Error(`settings/profit: ${response.reason} ${response.message}`);
  const hash = response.data.settingsHash;
  if (typeof hash !== "string" || !hash) throw new Error("settings/profit answered without a settingsHash");

  const data = {
    settingsHash: hash,
    settings: (response.data.settings ?? {}) as Prisma.InputJsonValue,
    isDefault: (response.data.isDefault ?? {}) as Prisma.InputJsonValue,
    fetchedAt: now,
  };
  await prisma.storeProfitSettings.upsert({ where: { storeId }, update: data, create: { storeId, ...data } });
  return "fetched";
}

export type StoreSummary = {
  store: { id: string; shopDomain: string; currency: string | null; timezone: string | null };
  /** The store's own local days (rule #5). */
  period: { from: string; to: string };
  orders: Bucket;
  /** Ad-platform days, which are not the shop's local days; said beside the figure. */
  adSpend: { spend: Money[]; fees: Money[]; dateBasis: "ad_platform_day"; daysFetched: number; daysInPeriod: number } | null;
  profit: Profit | null;
  roas: number | null;
  settings: StoreSettings & { isDefault: Record<string, unknown> | null; fetchedAt: Date | null };
  /**
   * How much of the period's delivery detail comes from Courierify, the
   * delivery authority (rule #7). A store that stopped booking through
   * Courierify — `0dscam-qn` on 2026-09-01 — silently degrades to Financify's
   * coarser view; this makes it visible.
   */
  courierifyCoverage: { shippedOrders: number; withParcel: number };
  rows: RollupOrder[];
};

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export async function storeSummary(storeId: string, from: string, to: string): Promise<StoreSummary> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: {
      id: true,
      shopDomain: true,
      currency: true,
      timezone: true,
      profitSettings: true,
      connections: { where: { app: "FINANCIFY", status: "CONNECTED" }, select: { app: true } },
    },
  });
  const rows = await loadOrders(storeId, from, to);
  const orders = bucketOf(store.shopDomain, rows);

  const hasFinancify = store.connections.length > 0;
  const ads = hasFinancify ? await loadAdSpend(storeId, from, to) : null;
  const adSpend = ads
    ? {
        spend: ads.total,
        fees: sumByCurrency(
          (
            await prisma.adSpend.findMany({
              where: { storeId, level: "day", day: { gte: from, lte: to } },
              select: { feesAmount: true, currency: true },
            })
          ).map((r) => ({ amount: r.feesAmount.toFixed(6), currency: r.currency })),
        ),
        dateBasis: "ad_platform_day" as const,
        daysFetched: ads.fetchedDays.size,
        daysInPeriod: daysBetween(from, to),
      }
    : null;

  // Ad spend counted in profit and ROAS includes the platform fees: they are
  // money the merchant paid for the ads.
  const spendWithFees = adSpend ? sumByCurrency([...adSpend.spend, ...adSpend.fees]) : null;
  const complete = adSpend && adSpend.daysFetched === adSpend.daysInPeriod;
  const profit = store.currency
    ? profitAfterReturns(orders, store.currency, complete ? spendWithFees : null)
    : null;
  if (profit && adSpend && !complete) {
    // One fact, one line: say how much of the period's ad spend is fetched
    // instead of a bare "not available" beside it.
    profit.missing = profit.missing.map((m) =>
      m === "ad spend not available"
        ? `ad spend fetched for ${adSpend.daysFetched} of ${adSpend.daysInPeriod} day(s), so not subtracted`
        : m,
    );
  }

  const shipped = rows.filter((r) => ["delivered", "returned", "partially_delivered", "in_transit"].includes(r.outcome));
  return {
    store: { id: store.id, shopDomain: store.shopDomain, currency: store.currency, timezone: store.timezone },
    period: { from, to },
    orders,
    adSpend,
    profit,
    roas: store.currency && spendWithFees && complete ? roas(orders, spendWithFees, store.currency) : null,
    settings: {
      storeId: store.id,
      shopDomain: store.shopDomain,
      settingsHash: store.profitSettings?.settingsHash ?? null,
      settings: (store.profitSettings?.settings as Record<string, unknown> | undefined) ?? null,
      isDefault: (store.profitSettings?.isDefault as Record<string, unknown> | undefined) ?? null,
      fetchedAt: store.profitSettings?.fetchedAt ?? null,
    },
    courierifyCoverage: { shippedOrders: shipped.length, withParcel: shipped.filter((r) => r.parcelCount > 0).length },
    rows,
  };
}

export type OrganizationSummary = {
  organization: { id: string; name: string; baseCurrency: string };
  period: { from: string; to: string; note: string };
  stores: Array<Omit<StoreSummary, "rows">>;
  /** Every store's orders together: per currency, never mixed (rule #4). */
  orders: Bucket;
  /** In the base currency, at each order's own day's rate, with the rates shown. */
  converted: { placed: Conversion; deliveredRevenue: Conversion };
  /** Store profits added only where each is in the base currency and settings agree, or flagged. */
  profit: {
    total: Money | null;
    complete: boolean;
    storesIncluded: string[];
    storesExcluded: Array<{ shop: string; reason: string }>;
    flags: string[];
  };
  settings: SettingsComparison;
};

export async function organizationSummary(
  organizationId: string,
  from: string,
  to: string,
  fx: FxSource = NO_FX_SOURCE,
): Promise<OrganizationSummary> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { id: true, name: true, baseCurrency: true, stores: { select: { id: true }, orderBy: { shopDomain: "asc" } } },
  });

  const summaries: StoreSummary[] = [];
  for (const s of org.stores) summaries.push(await storeSummary(s.id, from, to));

  const allRows = summaries.flatMap((s) => s.rows);
  const dated = (pick: (r: RollupOrder) => Money | null) =>
    allRows.flatMap((r) => {
      const m = pick(r);
      return m && r.localDay ? [{ day: r.localDay, money: m }] : [];
    });

  const settings = compareSettings(summaries.map((s) => s.settings));

  // Profit: each store's figure is already in one currency with its own
  // completeness. The organization adds only base-currency store profits.
  const flags: string[] = [];
  const included: string[] = [];
  const excluded: Array<{ shop: string; reason: string }> = [];
  let total = 0n;
  let anyIncomplete = false;
  for (const s of summaries) {
    if (!s.profit) {
      excluded.push({ shop: s.store.shopDomain, reason: "store currency unknown" });
      continue;
    }
    if (s.profit.currency !== org.baseCurrency) {
      excluded.push({ shop: s.store.shopDomain, reason: `profit is in ${s.profit.currency}; no ${s.profit.currency}→${org.baseCurrency} rate source yet` });
      continue;
    }
    total += parseAmount(s.profit.amount)!;
    if (!s.profit.complete) anyIncomplete = true;
    included.push(s.store.shopDomain);
  }
  if (!settings.consistent) {
    flags.push(
      `stores use different Financify profit settings: ${settings.differences.map((d) => d.setting).join(", ")} — Growzar's profit after returns has one definition, but compare with Financify's net profit per store`,
    );
  }
  if (settings.unknown.length) flags.push(`profit settings unknown for ${settings.unknown.join(", ")} (no Financify)`);

  return {
    organization: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    period: { from, to, note: "each store's own local days (rule #5)" },
    stores: summaries.map(({ rows: _rows, ...rest }) => rest),
    orders: bucketOf(org.name, allRows),
    converted: {
      placed: convertDated(dated((r) => r.placed), org.baseCurrency, fx),
      deliveredRevenue: convertDated(
        dated((r) => (r.outcome === "delivered" ? r.delivered : null)),
        org.baseCurrency,
        fx,
      ),
    },
    profit: {
      total: included.length ? { amount: formatAmount(total), currency: org.baseCurrency } : null,
      complete: !anyIncomplete && excluded.length === 0,
      storesIncluded: included,
      storesExcluded: excluded,
      flags,
    },
    settings,
  };
}
