import { prisma } from "../db.server";
import { coverageReport, type CoverageReport } from "./coverage";
import { readPayout, type Payout } from "./settlements";
import type { StoreSummary } from "./summaries.server";

/**
 * Load what `coverageReport` counts over, for one store's period (D1). The
 * order counts come from the same summary the screens render, so a coverage
 * line and the figure it qualifies are counted from the same rows.
 */
export async function storeCoverage(s: StoreSummary): Promise<CoverageReport> {
  const storeId = s.store.id;
  const buyerIds = [...new Set(s.rows.map((r) => r.customerId).filter((c): c is string => !!c))];
  const [connections, settlementRows, named] = await Promise.all([
    prisma.appConnection.findMany({ where: { storeId, status: "CONNECTED" }, select: { app: true } }),
    prisma.rawRecord.findMany({
      where: { storeId, app: "COURIERIFY", entity: "SETTLEMENT", deletedAt: null },
      select: { payload: true },
    }),
    buyerIds.length
      ? prisma.customer.count({ where: { id: { in: buyerIds }, displayName: { not: null } } })
      : Promise.resolve(0),
  ]);
  return coverageReport({
    period: s.period,
    rows: s.rows,
    connected: connections.map((c) => c.app),
    payouts: settlementRows
      .map((r) => readPayout((r.payload ?? {}) as Record<string, unknown>))
      .filter((p): p is Payout => p !== null),
    adSpend: s.adSpend ? { daysFetched: s.adSpend.daysFetched, daysInPeriod: s.adSpend.daysInPeriod } : null,
    buyers: { total: buyerIds.length, named },
    unconvertedOrders: s.fx?.unconverted.reduce((n, u) => n + u.orders, 0) ?? 0,
  });
}
