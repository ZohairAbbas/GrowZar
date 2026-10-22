import type { Prisma } from "@prisma/client";

import { prisma } from "../../db.server";
import type { BookView } from "../../books/books.server";
import { decimalToMinor } from "../../books/connectors/shopify-sales";
import { courierName } from "./courier-payouts";

/**
 * The parcel register's details from Growzar's own data (B5b), in place of
 * Financify's reads of Shopify's order metafields and its tracking table:
 * - Courierify's parcel: the courier, tracking number, booked fee, the amount
 *   to collect, and whether the courier has settled it (with when);
 * - Growzar's order grain: where the parcel is (delivered, returned, on the
 *   way) and since when, the same outcome Finance uses.
 * Parcels a payout in the books already cleared aren't looked at again.
 */
const STATUS: Record<string, string> = {
  delivered: "DELIVERED",
  partially_delivered: "DELIVERED",
  returned: "RETURNED",
  in_transit: "IN_TRANSIT",
  booked: "DISPATCHED",
};

type Money = { amount?: string | null; currency?: string | null } | null | undefined;

export async function refreshRegister(book: BookView, storeId: string): Promise<{ checked: number }> {
  const rows = await prisma.bkParcel.findMany({ where: { bookId: book.id, storeId, payoutDocId: null }, select: { id: true, orderId: true, courier: true, trackingNumber: true } });
  if (rows.length === 0) return { checked: 0 };
  const ids = rows.map((r) => r.orderId);
  const [grain, parcels] = await Promise.all([
    prisma.orderGrain.findMany({ where: { storeId, orderId: { in: ids } }, select: { orderId: true, outcome: true, outcomeAt: true } }),
    prisma.rawRecord.findMany({ where: { storeId, app: "COURIERIFY", entity: "PARCEL", deletedAt: null }, select: { payload: true } }),
  ]);
  const outcome = new Map(grain.map((g) => [g.orderId, g]));
  const byOrder = new Map<string, Record<string, unknown>>();
  for (const p of parcels) {
    const x = p.payload as Record<string, unknown>;
    if (x.orderId != null) byOrder.set(String(x.orderId), x);
  }
  const minor = (m: Money) => {
    if (!m || m.amount == null || (m.currency && m.currency !== book.currency)) return null;
    try {
      return decimalToMinor(String(m.amount), book.decimals);
    } catch {
      return null;
    }
  };
  const now = new Date();
  for (const r of rows) {
    const g = outcome.get(r.orderId);
    const c = byOrder.get(r.orderId);
    const data: Prisma.BkParcelUpdateInput = { checkedAt: now };
    if (g) {
      data.trackingStatus = STATUS[g.outcome] ?? null;
      if (g.outcome === "delivered" || g.outcome === "partially_delivered") data.deliveredAt = g.outcomeAt ?? null;
      else if (g.outcomeAt) data.trackingAt = g.outcomeAt;
      if (["booked", "in_transit", "delivered", "partially_delivered", "returned"].includes(g.outcome)) data.shipped = true;
    }
    if (c) {
      if (typeof c.courier === "string" && c.courier) data.courier = courierName(c.courier);
      if (typeof c.trackingNumber === "string" && c.trackingNumber) data.trackingNumber = c.trackingNumber;
      const fee = minor(c.bookedFee as Money);
      if (fee !== null) data.bookedFees = fee;
      const cod = minor(c.cod as Money);
      if (cod !== null) data.codAmount = cod;
      if (typeof c.bookedAt === "string" && !g?.outcomeAt) data.trackingAt = new Date(c.bookedAt);
      const s = c.settlement as { settled?: boolean; settledAt?: string | null; settlementId?: string | null } | null | undefined;
      // Settled per Courierify, before the payout reaches the books: the register says "paid by the courier, payout not in your books".
      if (s?.settled && s.settledAt) {
        data.settledAt = new Date(s.settledAt);
        data.settlementRef = s.settlementId ?? null;
      }
    }
    await prisma.bkParcel.update({ where: { id: r.id }, data });
  }
  return { checked: rows.length };
}

/** Each order's total and tax from Financify's order rows, for a lost parcel's share of tax. */
export async function orderTotals(storeIds: string[], orderIds: string[]): Promise<Map<string, { total: string; tax: string }>> {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.rawRecord.findMany({ where: { storeId: { in: storeIds }, app: "FINANCIFY", entity: "ORDER", deletedAt: null, externalId: { in: orderIds } }, select: { externalId: true, payload: true } });
  const out = new Map<string, { total: string; tax: string }>();
  for (const r of rows) {
    const m = (r.payload as { money?: { placed?: Money; tax?: Money } }).money;
    if (m?.placed?.amount != null) out.set(r.externalId, { total: String(m.placed.amount), tax: String(m.tax?.amount ?? "0") });
  }
  return out;
}

/**
 * A Courierify payout in the books clears the parcels it paid (Financify's
 * stamping after a payout run): paid what it collected, with its net and
 * charges; a returned parcel is marked returned so the sales run takes it off.
 */
export async function stampPayout(book: BookView, storeId: string, docId: string, day: string, ref: string, lines: Array<{ orderId: string | null; status?: string | null; collected: bigint; net: bigint; kept: bigint }>) {
  for (const l of lines) {
    if (!l.orderId) continue;
    const settled = { settlementRef: ref, settledAt: new Date(`${day}T00:00:00.000Z`), settledNet: l.net, settledFees: l.kept };
    if (l.collected > 0n) {
      await prisma.bkParcel.updateMany({ where: { bookId: book.id, storeId, orderId: l.orderId }, data: { payoutDocId: docId, paid: l.collected, settledStatus: "delivered", ...settled } });
    } else if (String(l.status ?? "").toLowerCase().includes("return")) {
      await prisma.bkParcel.updateMany({ where: { bookId: book.id, storeId, orderId: l.orderId, payoutDocId: null }, data: { settledStatus: "returned", ...settled } });
    }
  }
}
