import { prisma } from "../db.server";
import { loadAttribution, loadCampaignNames } from "../metrics/campaigns.server";
import { storeCoverage } from "../metrics/coverage.server";
import { profitTables } from "../metrics/screens.server";
import { scopeQuery, type Scope } from "../metrics/scope";
import { storeSummary, type StoreSummary } from "../metrics/summaries.server";
import { lineLabels, type Dimension, type StoreSlice } from "./engine";
import type { AskPeriod } from "./period.server";
import type { AskContext, AskStore } from "./types";

/**
 * Loading for the tools, through the metric layer only (D-14: no tool reads
 * a source row or writes SQL of its own). Memoised per question, so a second
 * tool call about the same store and period reuses the summary.
 */
export function memo<T>(ctx: AskContext, key: string, load: () => Promise<T>): Promise<T> {
  let p = ctx.memo.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    ctx.memo.set(key, p);
  }
  return p;
}

export const summaryFor = (ctx: AskContext, storeId: string, period: { from: string; to: string }, scope: Scope) =>
  memo(ctx, `summary:${storeId}:${period.from}:${period.to}:${scopeQuery(scope)}`, () => storeSummary(storeId, period.from, period.to, scope));

export const coverageFor = (ctx: AskContext, s: StoreSummary) =>
  memo(ctx, `coverage:${s.store.id}:${s.period.from}:${s.period.to}:${scopeQuery(s.scope)}`, () => storeCoverage(s));

/** The first order each buyer ever placed in the store, for "first or repeat order". */
async function firstOrders(storeId: string, customerIds: string[]): Promise<Map<string, Date>> {
  if (!customerIds.length) return new Map();
  const rows = await prisma.orderGrain.groupBy({
    by: ["customerId"],
    where: { storeId, customerId: { in: customerIds }, createdAt: { not: null } },
    _min: { createdAt: true },
  });
  return new Map(rows.filter((r) => r.customerId && r._min.createdAt).map((r) => [r.customerId!, r._min.createdAt!]));
}

/** One store's period, with what the dimension and metrics need beside the rows. */
export async function sliceFor(
  ctx: AskContext,
  store: AskStore,
  period: AskPeriod,
  scope: Scope,
  needs: { dimension: Dimension; profit: boolean },
): Promise<{ summary: StoreSummary; slice: StoreSlice }> {
  const summary = await summaryFor(ctx, store.id, period, scope);
  const ids = summary.rows.map((o) => o.orderId);
  const { dimension } = needs;
  const [attribution, firstOrderAt, profit, names] = await Promise.all([
    dimension === "campaign" || dimension === "channel" ? memo(ctx, `attribution:${store.id}:${period.from}:${period.to}:${scopeQuery(scope)}`, () => loadAttribution(store.id, ids)) : undefined,
    dimension === "buyer_type"
      ? memo(ctx, `first:${store.id}:${period.from}:${period.to}:${scopeQuery(scope)}`, () =>
          firstOrders(store.id, [...new Set(summary.rows.map((o) => o.customerId).filter((c): c is string => !!c))]),
        )
      : undefined,
    needs.profit && summary.store.currency && summary.profit
      ? memo(ctx, `profit:${store.id}:${period.from}:${period.to}:${scopeQuery(scope)}`, () => profitTables(store.id, summary, Infinity))
      : undefined,
    dimension === "campaign" ? memo(ctx, `campaigns:${store.id}`, () => loadCampaignNames(store.id)) : undefined,
  ]);
  const labels: Record<string, string> = { ...lineLabels(summary.rows), ...(profit?.labels ?? {}) };
  for (const [k, n] of names ?? []) if (n.name) labels[k] = n.name;
  return {
    summary,
    slice: {
      storeId: store.id,
      currency: summary.store.currency,
      period: summary.period,
      rows: summary.rows,
      profit: summary.profit,
      profitBy: profit?.profitBy ?? null,
      attribution,
      firstOrderAt,
      labels,
    },
  };
}
