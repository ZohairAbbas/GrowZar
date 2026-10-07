import { prisma } from "../db.server";
import type { OrderAttribution } from "./campaigns";

/**
 * Financify's order → campaign link (G-FIN3-1) for the given orders, from the
 * order rows Growzar stores. An order whose stored row predates the field is
 * left out (not "unattributed"); `attribution: null` is Financify saying it
 * has no record yet.
 */
export async function loadAttribution(storeId: string, orderIds: readonly string[]): Promise<Map<string, OrderAttribution>> {
  if (!orderIds.length) return new Map();
  const rows = await prisma.$queryRaw<Array<{ orderId: string; campaignKey: string | null; platform: string | null; method: string | null }>>`
    SELECT "externalId" AS "orderId",
           payload->'attribution'->>'campaignKey' AS "campaignKey",
           payload->'attribution'->>'platform' AS platform,
           payload->'attribution'->>'method' AS method
    FROM raw_records
    WHERE "storeId" = ${storeId} AND app = 'FINANCIFY' AND entity = 'ORDER' AND "deletedAt" IS NULL
      AND payload ? 'attribution' AND "externalId" = ANY(${[...orderIds]})`;
  return new Map(rows.map((r) => [r.orderId, { campaignKey: r.campaignKey, platform: r.platform, method: r.method }]));
}

/** Every campaign's latest name and platform, over all dates (a campaign can bring orders after its spend ends). */
export async function loadCampaignNames(storeId: string): Promise<Map<string, { name: string | null; platform: string | null }>> {
  const rows = await prisma.$queryRaw<Array<{ key: string; name: string | null; platform: string | null }>>`
    SELECT DISTINCT ON (key) key, detail->>'campaignName' AS name, platform
    FROM ad_spend
    WHERE "storeId" = ${storeId} AND level = 'campaign'
    ORDER BY key, day DESC`;
  return new Map(rows.map((r) => [r.key, { name: r.name, platform: r.platform }]));
}
