import { prisma } from "../db.server";
import { localDayOf } from "./order-grain";
import { formatAmount, parseAmount } from "./money";
import { offersView, parseFormOrder, type OffersView } from "./offers";

type Payload = { payload: unknown };
const DAY_MS = 86_400_000;

/**
 * Preventify's form orders placed in the period's local days, joined to the
 * store's orders by Shopify order id, with the offers' names and the period's
 * offer events. Null when Preventify has sent no form orders for it.
 */
export async function offersSection(storeId: string, period: { from: string; to: string }): Promise<OffersView | null> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { timezone: true, currency: true } });
  const tz = store.timezone ?? "UTC";
  const after = new Date(Date.parse(`${period.from}T00:00:00Z`) - DAY_MS).toISOString();
  const before = new Date(Date.parse(`${period.to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const inPeriod = (d: Date) => {
    const day = localDayOf(d, tz);
    return day >= period.from && day <= period.to;
  };
  const [orderRows, offerRows, eventRows] = await Promise.all([
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'PREVENTIFY' AND entity = 'FORM_ORDER' AND "deletedAt" IS NULL
        AND payload->>'createdAt' >= ${after} AND payload->>'createdAt' < ${before}`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'PREVENTIFY' AND entity = 'OFFER' AND "deletedAt" IS NULL`,
    prisma.$queryRaw<Array<{ offerId: string; kind: string; createdAt: string }>>`
      SELECT payload->>'offerId' AS "offerId", payload->>'kind' AS kind, payload->>'createdAt' AS "createdAt" FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'PREVENTIFY' AND entity = 'OFFER_EVENT' AND "deletedAt" IS NULL
        AND payload->>'createdAt' >= ${after} AND payload->>'createdAt' < ${before}`,
  ]);
  const formOrders = orderRows.map((r) => parseFormOrder(r.payload)).filter((o): o is NonNullable<typeof o> => o !== null && inPeriod(o.createdAt));
  if (!formOrders.length) return null;

  const grain = await prisma.orderGrain.findMany({
    where: { storeId, orderId: { in: formOrders.map((o) => o.orderId) } },
    select: { orderId: true, placedAmount: true, currency: true, outcome: true },
  });
  const facts = new Map(
    grain.map((g) => [
      g.orderId,
      {
        placed: g.placedAmount !== null && g.currency ? { amount: formatAmount(parseAmount(g.placedAmount.toFixed(6))!), currency: g.currency } : null,
        outcome: g.outcome,
      },
    ]),
  );
  const offerNames = new Map(
    offerRows.flatMap((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return typeof p.id === "string" ? [[p.id, { name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Untitled offer", type: String(p.type ?? "") }] as const] : [];
    }),
  );
  return offersView({
    formOrders,
    facts,
    offerNames,
    events: eventRows.filter((e) => e.offerId && !Number.isNaN(Date.parse(e.createdAt)) && inPeriod(new Date(e.createdAt))),
    currency: store.currency,
  });
}
