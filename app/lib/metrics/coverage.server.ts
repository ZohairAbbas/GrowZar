import { prisma } from "../db.server";
import { coverageReport, type CoverageReport } from "./coverage";
import { readPayout, type Payout } from "./settlements";
import type { StoreSummary } from "./summaries.server";
import { loadAttribution } from "./campaigns.server";
import { feedsFor } from "../sync/entities";

/**
 * Load what `coverageReport` counts over, for one store's period (D1). The
 * order counts come from the same summary the screens render, so a coverage
 * line and the figure it qualifies are counted from the same rows.
 */
export async function storeCoverage(s: StoreSummary): Promise<CoverageReport> {
  const storeId = s.store.id;
  const buyerIds = [...new Set(s.rows.map((r) => r.customerId).filter((c): c is string => !!c))];
  const [connections, settlementRows, named, owing, attribution, syncRows, adFetched] = await Promise.all([
    prisma.appConnection.findMany({ where: { storeId, status: "CONNECTED" }, select: { app: true } }),
    prisma.rawRecord.findMany({
      where: { storeId, app: "COURIERIFY", entity: "SETTLEMENT", deletedAt: null },
      select: { payload: true },
    }),
    buyerIds.length
      ? prisma.customer.count({ where: { id: { in: buyerIds }, displayName: { not: null } } })
      : Promise.resolve(0),
    prisma.orderGrain.groupBy({
      by: ["courier"],
      where: { storeId, outcome: "delivered", parcelCount: { gt: 0 }, uncollectedAmount: { gt: 0 }, courier: { not: null } },
    }),
    loadAttribution(storeId, s.rows.map((r) => r.orderId)),
    prisma.syncState.findMany({
      where: { storeId },
      select: { app: true, entity: true, lastSuccessAt: true, consecutiveFailures: true, lastError: true },
    }),
    prisma.adSpend.aggregate({ where: { storeId }, _max: { fetchedAt: true } }),
  ]);
  // Only feeds that exist today: a dropped feed's old failure is not a gap.
  const current = new Set(connections.flatMap((c) => feedsFor(c.app).map((f) => `${c.app}:${f.entity}`)));
  const tied = [...attribution.values()];
  return coverageReport({
    period: s.period,
    rows: s.rows,
    connected: connections.map((c) => c.app),
    payouts: settlementRows
      .map((r) => readPayout((r.payload ?? {}) as Record<string, unknown>))
      .filter((p): p is Payout => p !== null),
    owingCouriers: owing.map((o) => o.courier!),
    adSpend: s.adSpend ? { daysFetched: s.adSpend.daysFetched, daysInPeriod: s.adSpend.daysInPeriod } : null,
    buyers: { total: buyerIds.length, named },
    unconvertedOrders: s.fx?.unconverted.reduce((n, u) => n + u.orders, 0) ?? 0,
    withheld: s.withheld,
    syncs: syncRows
      .filter((r) => current.has(`${r.app}:${r.entity}`))
      .map((r) => ({ app: r.app, entity: r.entity, lastSuccessAt: r.lastSuccessAt, failures: r.consecutiveFailures, error: r.lastError })),
    adSpendFetchedAt: adFetched._max.fetchedAt ?? null,
    asOf: new Date(),
    otherCosts: s.rows.length ? { have: s.rows.filter((r) => r.otherCosts).length, of: s.rows.length } : undefined,
    attribution: tied.length
      ? {
          matched: tied.filter((a) => a.campaignKey).length,
          of: tied.length,
          organic: tied.filter((a) => !a.campaignKey && a.method === "utm_only").length,
        }
      : undefined,
  });
}
