import { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { appRequest } from "../apps/client.server";
import { isQuietHours } from "../sync/sync.server";
import {
  ACTIVE_DAYS,
  BATCHES_PER_CYCLE,
  BATCH_SIZE,
  OPEN_DAYS,
  OPEN_OUTCOMES,
  buyerNetworkView,
  parseAnswer,
  pickRefresh,
  type BuyerNetworkView,
  type OpenOrder,
  type RefreshCandidate,
  type StoredAnswer,
} from "./buyer-network";

/** What Courierify's `/growzar/status` lists when it serves the endpoint. */
export const BUYER_NETWORK_CAPABILITY = "buyer_network:read";
const PATH = "/api/v1/growzar/buyer-network";
const DAY_MS = 86_400_000;

export type NetworkRefresh = { asked: number; written: number; skipped?: string; problem?: string };

/**
 * Ask Courierify about the store's active buyers that are due (see
 * `pickRefresh`), a few batches per worker cycle. Only the store's own
 * buyers are ever asked about, by the phone the store has for them.
 */
export async function refreshBuyerNetwork(storeId: string, now = new Date()): Promise<NetworkRefresh> {
  const connection = await prisma.appConnection.findFirst({
    where: { storeId, app: "COURIERIFY", status: "CONNECTED" },
    select: { capabilities: true, store: { select: { shopDomain: true } } },
  });
  if (!connection) return { asked: 0, written: 0, skipped: "Courierify not connected" };
  if (!connection.capabilities.includes(BUYER_NETWORK_CAPABILITY)) return { asked: 0, written: 0, skipped: "Courierify does not list buyer_network:read" };

  const since = new Date(now.getTime() - ACTIVE_DAYS * DAY_MS);
  const openSince = new Date(now.getTime() - OPEN_DAYS * DAY_MS);
  const [buyers, fetched] = await Promise.all([
    // Each live buyer with an order in ACTIVE_DAYS, and the phone it was most recently seen with.
    prisma.$queryRaw<Array<{ customerId: string; phone: string; lastOrderAt: Date; hasOpenOrder: boolean }>>`
      WITH active AS (
        SELECT COALESCE(c."mergedIntoId", c.id) AS "customerId", max(g."createdAt") AS "lastOrderAt",
               bool_or(g.outcome = ANY(${[...OPEN_OUTCOMES]}) AND g."createdAt" >= ${openSince}) AS "hasOpenOrder"
        FROM order_grain g JOIN customers c ON c.id = g."customerId"
        WHERE g."storeId" = ${storeId} AND g."createdAt" >= ${since}
        GROUP BY 1
      )
      SELECT a."customerId", a."lastOrderAt", a."hasOpenOrder", p.value AS phone
      FROM active a
      JOIN LATERAL (
        SELECT i.value FROM customer_identities i
        WHERE i."customerId" = a."customerId" AND i.kind = 'PHONE'
        ORDER BY i."lastSeenAt" DESC, i.value LIMIT 1
      ) p ON true`,
    prisma.buyerNetwork.findMany({ where: { storeId }, select: { customerId: true, fetchedAt: true, phone: true } }),
  ]);

  const batches = isQuietHours(now) ? BATCHES_PER_CYCLE.quiet : BATCHES_PER_CYCLE.open;
  const due = pickRefresh(
    buyers as RefreshCandidate[],
    new Map(fetched.map((f) => [f.customerId, f])),
    now,
    batches * BATCH_SIZE,
  );

  let asked = 0;
  let written = 0;
  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const batch = due.slice(i, i + BATCH_SIZE);
    const res = await appRequest<{ data?: unknown[] }>("COURIERIFY", {
      method: "POST",
      pathWithQuery: PATH,
      shopDomain: connection.store.shopDomain,
      body: { phones: batch.map((c) => c.phone) },
    });
    if (!res.ok) {
      // 404: Courierify doesn't know the shop. Either way, stop for this cycle.
      return { asked, written, problem: `${res.reason}${res.status ? ` ${res.status}` : ""}` };
    }
    asked += batch.length;
    const byPhone = new Map(batch.map((c) => [c.phone, c]));
    const answers = (res.data.data ?? []).map(parseAnswer).filter((a) => a !== null && byPhone.has(a.phone));
    const fetchedAt = new Date();
    await prisma.$transaction(
      answers.map((a) => {
        const data = {
          phone: a!.phone,
          status: a!.status,
          // A field Courierify now nulls must not keep its old value.
          storeFigures: a!.storeFigures ?? Prisma.DbNull,
          network: a!.network ?? Prisma.DbNull,
          otherStores: a!.otherStores,
          riskLevel: a!.riskLevel,
          riskBasis: a!.riskBasis,
          fetchedAt,
        };
        const customerId = byPhone.get(a!.phone)!.customerId;
        return prisma.buyerNetwork.upsert({
          where: { storeId_customerId: { storeId, customerId } },
          create: { storeId, customerId, ...data },
          update: data,
        });
      }),
    );
    written += answers.length;
  }
  return { asked, written };
}

/**
 * Buyers Courierify rates high, with every customer id that resolves to them,
 * so an order still carrying a merged-away id is found too.
 */
export async function highRiskBuyers(storeId: string): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM customers c
    JOIN buyer_network b ON b."storeId" = c."storeId" AND b."customerId" = COALESCE(c."mergedIntoId", c.id)
    WHERE c."storeId" = ${storeId} AND b.status = 'ok' AND b."riskLevel" = 'high'`;
  return new Set(rows.map((r) => r.id));
}

/** Courierify's stored answers for the given buyers. */
export async function loadNetworkAnswers(storeId: string, customerIds?: readonly string[]): Promise<Map<string, StoredAnswer>> {
  const rows = await prisma.buyerNetwork.findMany({
    where: { storeId, ...(customerIds ? { customerId: { in: [...customerIds] } } : {}) },
    select: { customerId: true, status: true, storeFigures: true, network: true, otherStores: true, riskLevel: true, riskBasis: true, fetchedAt: true },
  });
  return new Map(rows.map((r) => [r.customerId, r]));
}

/**
 * The Customers section's network panel: the period's buyers as Courierify
 * sees them, and the open orders of buyers it rates high. Null until
 * Courierify has answered for any of the store's buyers.
 */
export async function buyerNetworkSection(storeId: string, periodBuyers: ReadonlySet<string>, now = new Date()): Promise<BuyerNetworkView | null> {
  const answers = await loadNetworkAnswers(storeId);
  if (!answers.size) return null;
  const open = await prisma.$queryRaw<Array<{ orderId: string; orderName: string | null; customerId: string; createdAt: Date | null; outcome: string; phone: string | null }>>`
    SELECT g."orderId", g."orderName", COALESCE(c."mergedIntoId", c.id) AS "customerId", g."createdAt", g.outcome, b.phone
    FROM order_grain g
    JOIN customers c ON c.id = g."customerId"
    LEFT JOIN buyer_network b ON b."storeId" = g."storeId" AND b."customerId" = COALESCE(c."mergedIntoId", c.id)
    WHERE g."storeId" = ${storeId} AND g.outcome = ANY(${[...OPEN_OUTCOMES]}) AND g."createdAt" >= ${new Date(now.getTime() - OPEN_DAYS * DAY_MS)}`;
  return buyerNetworkView({
    periodBuyers,
    answers,
    openOrders: open.map(
      (o): OpenOrder => ({ orderId: o.orderId, orderName: o.orderName, customerId: o.customerId, createdAt: o.createdAt, outcome: o.outcome, phoneTail: o.phone ? o.phone.replace(/\D/g, "").slice(-4) : null }),
    ),
  });
}
