import { prisma } from "../db.server";
import { acquisitionView, type AcquisitionView } from "./campaign-acquisition";
import { loadAttribution, loadCampaignNames } from "./campaigns.server";
import { formatAmount, parseAmount, type Money } from "./money";

/**
 * I10's inputs for one store and period: each buyer's first order with the
 * store (over all history, merges resolved) that falls in the period, the
 * campaign Financify ties it to, every campaign's order count in the period,
 * and campaign spend, only when the period's ad spend is fetched in full.
 */
export async function loadAcquisition(
  storeId: string,
  period: { from: string; to: string },
  spendComplete: boolean,
): Promise<AcquisitionView | null> {
  const [firsts, periodOrders] = await Promise.all([
    prisma.$queryRaw<Array<{ orderId: string; outcome: string }>>`
      SELECT f."orderId", f.outcome FROM (
        SELECT DISTINCT ON (COALESCE(c."mergedIntoId", c.id)) g."orderId", g.outcome, g."localDay"
        FROM order_grain g JOIN customers c ON c.id = g."customerId"
        WHERE g."storeId" = ${storeId} AND g."createdAt" IS NOT NULL
        ORDER BY COALESCE(c."mergedIntoId", c.id), g."createdAt", g."orderId"
      ) f
      WHERE f."localDay" >= ${period.from} AND f."localDay" <= ${period.to}`,
    prisma.orderGrain.findMany({ where: { storeId, localDay: { gte: period.from, lte: period.to } }, select: { orderId: true } }),
  ]);
  if (!firsts.length) return null;
  const attribution = await loadAttribution(storeId, periodOrders.map((o) => o.orderId));
  if (!attribution.size) return null;
  const ordersByCampaign = new Map<string, number>();
  for (const a of attribution.values()) if (a.campaignKey) ordersByCampaign.set(a.campaignKey, (ordersByCampaign.get(a.campaignKey) ?? 0) + 1);
  const [names, spend] = await Promise.all([loadCampaignNames(storeId), spendComplete ? loadCampaignSpend(storeId, period) : Promise.resolve(null)]);
  return acquisitionView({
    firsts: firsts.map((f) => ({ campaignKey: attribution.get(f.orderId)?.campaignKey ?? null, outcome: f.outcome })),
    ordersByCampaign,
    spend,
    names,
  });
}

/** Each campaign's measured spend plus platform fees over the period's days, in one currency. */
async function loadCampaignSpend(storeId: string, period: { from: string; to: string }): Promise<Map<string, Money>> {
  const rows = await prisma.$queryRaw<Array<{ key: string; currency: string; amount: string }>>`
    SELECT key, currency, (sum("spendAmount") + sum("feesAmount"))::text AS amount
    FROM ad_spend
    WHERE "storeId" = ${storeId} AND level = 'campaign' AND day >= ${period.from} AND day <= ${period.to}
    GROUP BY key, currency`;
  const out = new Map<string, Money>();
  const mixed = new Set<string>();
  for (const r of rows) {
    if (out.has(r.key)) mixed.add(r.key);
    out.set(r.key, { amount: formatAmount(parseAmount(r.amount) ?? 0n), currency: r.currency });
  }
  // A campaign billed in two currencies has no single spend (rule #4).
  for (const k of mixed) out.delete(k);
  return out;
}
