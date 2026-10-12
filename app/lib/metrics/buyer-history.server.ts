import { prisma } from "../db.server";
import { buyerHistoryView, networkHistory, type BuyerHistoryView, type NetworkHistory } from "./buyer-history";
import { HISTORY_DAYS } from "./buyer-network";
import { highRiskOrders } from "./buyer-network.server";

/**
 * Every order with a known buyer for the store (their history), the period's
 * orders among them, and Preventify's OTP switch when it is connected.
 */
export async function buyerHistorySection(storeId: string, period: { from: string; to: string }): Promise<BuyerHistoryView | null> {
  const [history, settings, formOrders] = await Promise.all([
    prisma.orderGrain.findMany({
      where: { storeId, customerId: { not: null }, createdAt: { not: null } },
      select: { orderId: true, customerId: true, createdAt: true, outcome: true, outcomeAt: true, localDay: true },
    }),
    prisma.$queryRaw<Array<{ otp: string | null }>>`
      SELECT payload->>'otpEnabled' AS otp FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'PREVENTIFY' AND entity = 'FORM_SETTINGS' AND "deletedAt" IS NULL LIMIT 1`,
    prisma.$queryRaw<Array<{ orderId: string }>>`
      SELECT payload->>'orderId' AS "orderId" FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'PREVENTIFY' AND entity = 'FORM_ORDER' AND "deletedAt" IS NULL AND payload->>'orderId' IS NOT NULL`,
  ]);
  const periodOrderIds = new Set(history.filter((o) => o.localDay && o.localDay >= period.from && o.localDay <= period.to).map((o) => o.orderId));
  if (!periodOrderIds.size) return null;
  const view = buyerHistoryView({
    history: history.map((o) => ({ orderId: o.orderId, customerId: o.customerId!, createdAt: o.createdAt!, outcome: o.outcome, outcomeAt: o.outcomeAt })),
    periodOrderIds,
    otpEnabled: settings[0]?.otp === "true" ? true : settings[0]?.otp === "false" ? false : null,
    // Preventify connected (its settings synced): which orders its form took.
    formOrderIds: settings.length ? new Set(formOrders.map((r) => r.orderId)) : null,
  });
  return { ...view, network: await loadNetworkHistory(storeId) };
}

/**
 * I5 on network history: the store's decided Courierify orders of the last
 * HISTORY_DAYS with Courierify's label for the buyer when each was placed.
 * Null until Courierify has labelled any order of the store.
 */
async function loadNetworkHistory(storeId: string, now = new Date()): Promise<NetworkHistory | null> {
  const rows = await prisma.$queryRaw<Array<{ outcome: string; status: string | null; riskLevel: string | null }>>`
    SELECT g.outcome, n.status, n."riskLevel"
    FROM order_grain g
    LEFT JOIN order_network n ON n."storeId" = g."storeId" AND n."orderId" = g."orderId"
    WHERE g."storeId" = ${storeId} AND g."outcomeAuthority" = 'courierify' AND g.outcome IN ('delivered', 'returned')
      AND g."createdAt" >= ${new Date(now.getTime() - HISTORY_DAYS * 86_400_000)}`;
  if (!rows.some((r) => r.status)) return null;
  return networkHistory(rows, HISTORY_DAYS, (await highRiskOrders(storeId, now)).size);
}
