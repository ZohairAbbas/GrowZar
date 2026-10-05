import type { OrderGrain as OrderGrainRow, Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { formatAmount, parseAmount, sumByCurrency, type Money } from "./money";
import type { RollupOrder } from "./rollups";

/**
 * Read the stored order grain and ad spend for roll-ups (G-GZR2-3). Screens,
 * Phase 3 detectors and "talk to your data" call these; none of them reads
 * `raw_records` or recomputes an order-level fact.
 */

/** Exact: the column holds six decimals, and rounding here would be silent. */
const exact = (d: Prisma.Decimal) => formatAmount(parseAmount(d.toFixed(6))!);
const money = (amount: Prisma.Decimal | null, currency: string | null): Money | null =>
  amount !== null && currency ? { amount: exact(amount), currency } : null;

/** A stored grain row, in the shape the roll-ups read. */
export function toRollupOrder(row: OrderGrainRow): RollupOrder {
  const lines = (Array.isArray(row.lines) ? row.lines : []) as unknown as RollupOrder["lines"];
  return {
    orderId: row.orderId,
    localDay: row.localDay,
    createdAt: row.createdAt,
    currency: row.currency,
    placed: money(row.placedAmount, row.currency),
    delivered: money(row.deliveredAmount, row.currency),
    refunded: money(row.refundedAmount, row.currency),
    collected: money(row.collectedAmount, row.collectedCurrency),
    uncollected: money(row.uncollectedAmount, row.uncollectedCurrency),
    cogs: money(row.cogsAmount, row.cogsCurrency),
    cogsComplete: row.cogsComplete,
    courierFee: money(row.courierFeeAmount, row.courierFeeCurrency),
    outcome: row.outcome as RollupOrder["outcome"],
    outcomeTiming:
      row.outcomeBasis && row.outcomeAt
        ? { basis: row.outcomeBasis as "happened_on" | "status_as_of", at: row.outcomeAt }
        : null,
    financifyOutcome: (row.financifyOutcome as RollupOrder["financifyOutcome"]) ?? null,
    parcelCount: row.parcelCount,
    courier: row.courier,
    fulfilledVia: row.fulfilledVia,
    city: row.city,
    cityRaw: row.cityRaw,
    confirmation: row.confirmation,
    customerId: row.customerId,
    lines: lines.map((l) => ({
      variantId: l.variantId ?? null,
      productId: l.productId ?? null,
      title: l.title ?? null,
      variantTitle: l.variantTitle ?? null,
      quantity: l.quantity ?? 0,
      value: l.value ?? null,
      cost: l.cost ?? null,
    })),
  };
}

/** Orders placed on the store's local days `from`…`to`, inclusive (rule #5). */
export async function loadOrders(storeId: string, from: string, to: string): Promise<RollupOrder[]> {
  const rows = await prisma.orderGrain.findMany({
    where: { storeId, localDay: { gte: from, lte: to } },
  });
  return rows.map(toRollupOrder);
}

/**
 * Ad spend for ad-platform days `from`…`to`: per day (measured), and per
 * variant (allocated). The two are kept apart by level and by label; a
 * caller setting them beside orders' local days is told the bases differ.
 */
export async function loadAdSpend(storeId: string, from: string, to: string) {
  const rows = await prisma.adSpend.findMany({
    where: { storeId, day: { gte: from, lte: to }, level: { in: ["day", "product", "product_unattributed"] } },
  });
  const as = (r: (typeof rows)[number]): Money => ({ amount: exact(r.spendAmount), currency: r.currency });

  const byDay = new Map<string, Money[]>();
  const byVariant = new Map<string, Money[]>();
  const unattributed: Money[] = [];
  const fetchedDays = new Set<string>();
  for (const r of rows) {
    if (r.level === "day") {
      byDay.set(r.day, [as(r)]);
      fetchedDays.add(r.day);
    } else if (r.level === "product") {
      byVariant.set(r.key, sumByCurrency([...(byVariant.get(r.key) ?? []), as(r)]));
    } else {
      unattributed.push(as(r));
    }
  }
  return {
    dateBasis: "ad_platform_day" as const,
    byDay,
    total: sumByCurrency([...byDay.values()].flat()),
    /** Financify's allocation: `method: "allocated"`, never measured. */
    byVariant,
    unattributed: sumByCurrency(unattributed),
    fetchedDays,
  };
}
