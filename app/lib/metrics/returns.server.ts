import { prisma } from "../db.server";
import { formatAmount, parseAmount, type Money } from "./money";
import type { CourierNote, ParcelFacts } from "./returns";

const moneyOf = (v: unknown): Money | null => {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  return typeof m.amount === "string" && typeof m.currency === "string" ? { amount: m.amount, currency: m.currency } : null;
};

/**
 * Courierify parcel facts the grain does not hold — whether a return reached
 * the merchant, the fees recorded — for the given orders, keyed to them by the
 * parcel's order id (rule #6).
 */
export async function loadParcelFacts(storeId: string, orderIds: readonly string[]): Promise<ParcelFacts[]> {
  if (!orderIds.length) return [];
  const rows = await prisma.$queryRaw<Array<{ orderId: string; courier: string | null; outcome: string | null; received: string | null; returnedAt: string | null; deliveryFee: unknown; reversalFee: unknown }>>`
    SELECT payload->>'orderId' AS "orderId", lower(payload->>'courier') AS courier, payload->>'outcome' AS outcome,
           payload->>'returnReceived' AS received, payload->>'returnedAt' AS "returnedAt",
           payload->'deliveryFee' AS "deliveryFee", payload->'reversalFee' AS "reversalFee"
    FROM raw_records
    WHERE "storeId" = ${storeId} AND app = 'COURIERIFY' AND entity = 'PARCEL' AND "deletedAt" IS NULL
      AND payload->>'orderId' = ANY(${[...orderIds]})`;
  return rows
    .filter((p) => p.orderId)
    .map((p) => {
      const fees = [moneyOf(p.deliveryFee), moneyOf(p.reversalFee)].filter((m): m is Money => m !== null);
      return {
        orderId: p.orderId,
        courier: p.courier,
        outcome: p.outcome ?? "unknown",
        returnReceived: p.received === "true",
        returnedAt: p.returnedAt ? new Date(p.returnedAt) : null,
        fee: fees.length ? { amount: formatAmount(fees.reduce((a, m) => a + parseAmount(m.amount)!, 0n)), currency: fees[0]!.currency } : null,
      };
    });
}

/**
 * What couriers wrote on return and failed-attempt events for the given
 * orders, from Growzar's event log. A 3PL's Shopify fulfilment events
 * (Orio's "FAILURE") are its mark, not a courier's (rule #9), and are left out.
 */
export async function loadCourierNotes(storeId: string, orderIds: readonly string[]): Promise<CourierNote[]> {
  if (!orderIds.length) return [];
  const rows = await prisma.$queryRaw<Array<{ orderId: string; status: string; raw: string; at: Date }>>`
    SELECT r.payload->>'orderId' AS "orderId", e.status, e.raw, COALESCE(e."courierEventAt", e."observedAt") AS at
    FROM shipment_events e
    JOIN raw_records r ON r."storeId" = e."storeId" AND r.app = 'COURIERIFY' AND r.entity = 'PARCEL' AND r."externalId" = e."shipmentId"
    WHERE e."storeId" = ${storeId} AND e.status IN ('returned', 'attempted') AND e.raw IS NOT NULL
      AND e.source <> 'shopify_fulfillment_event'
      AND r.payload->>'orderId' = ANY(${[...orderIds]})`;
  return rows.map((n) => ({ orderId: n.orderId, kind: n.status === "attempted" ? "attempted" : "returned", raw: n.raw, at: new Date(n.at) }));
}
