import { prisma } from "../db.server";
import { localDayOf } from "./order-grain";
import { formatAmount, parseAmount } from "./money";
import { CLICK_WINDOW_MS, SAME_SESSION_MS, buyerPhone, messagingView, parseJourney, parseMessage, type MessagingView } from "./messaging";

type Payload = { payload: unknown };
const DAY_MS = 86_400_000;

/**
 * The store's customers by E.164 phone. Growzar's customers carry PHONE
 * identities only (no app sends a buyer email yet). A merged customer
 * answers as its winner.
 */
export async function customersByPhone(storeId: string, phones: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(phones.filter((p): p is string => p !== null))];
  if (!wanted.length) return new Map();
  const ids = await prisma.$queryRaw<Array<{ value: string; customerId: string }>>`
    SELECT i.value, COALESCE(c."mergedIntoId", c.id) AS "customerId"
    FROM customer_identities i JOIN customers c ON c.id = i."customerId"
    WHERE i."storeId" = ${storeId} AND i.kind = 'PHONE' AND i.value = ANY(${wanted})`;
  return new Map(ids.map((r) => [r.value, r.customerId]));
}

/**
 * The Marketing section's Retainify block for one store: messages sent in the
 * period's local days, their buyers resolved to the store's customers by
 * phone, and the orders those customers placed in the windows that follow.
 * Returns null when Retainify has sent no messages for the period.
 */
export async function messagingSection(
  storeId: string,
  period: { from: string; to: string },
): Promise<MessagingView | null> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { timezone: true, country: true } });
  const tz = store.timezone ?? "UTC";
  // A day either side covers any timezone; the local day decides.
  const after = new Date(Date.parse(`${period.from}T00:00:00Z`) - DAY_MS).toISOString();
  const before = new Date(Date.parse(`${period.to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const [messageRows, journeyRows] = await Promise.all([
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'RETAINIFY' AND entity = 'MESSAGE' AND "deletedAt" IS NULL
        AND payload->>'sentAt' >= ${after} AND payload->>'sentAt' < ${before}`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'RETAINIFY' AND entity = 'JOURNEY' AND "deletedAt" IS NULL`,
  ]);

  const parsed = messageRows
    .map((r) => parseMessage(r.payload))
    .filter((m): m is NonNullable<typeof m> => m !== null && m.sentAt !== null)
    .filter((m) => {
      const d = localDayOf(m.sentAt!, tz);
      return d >= period.from && d <= period.to;
    });
  if (!parsed.length) return null;

  const customerOf = await customersByPhone(storeId, parsed.map((m) => buyerPhone(m.phoneE164, m.phoneRaw, store.country)));
  const messages = parsed.map(({ phoneE164, phoneRaw, ...m }) => {
    const phone = buyerPhone(phoneE164, phoneRaw, store.country);
    return { ...m, customerId: phone ? (customerOf.get(phone) ?? null) : null };
  });

  const customers = [...new Set(messages.map((m) => m.customerId).filter((c): c is string => c !== null))];
  const first = Math.min(...messages.map((m) => m.sentAt!.getTime()));
  const last = Math.max(...messages.map((m) => (m.clickedAt ?? m.sentAt)!.getTime()));
  const orders = customers.length
    ? await prisma.orderGrain.findMany({
        // From an hour before the first message: an order's previous order decides whether it is the same session.
        where: { storeId, customerId: { in: customers }, createdAt: { gte: new Date(first - SAME_SESSION_MS), lte: new Date(last + CLICK_WINDOW_MS) } },
        select: { orderId: true, customerId: true, createdAt: true, outcome: true, deliveredAmount: true, currency: true },
      })
    : [];

  return messagingView({
    messages,
    journeys: journeyRows.map((r) => parseJourney(r.payload)).filter((j): j is NonNullable<typeof j> => j !== null),
    orders: orders.flatMap((o) =>
      o.customerId && o.createdAt
        ? [
            {
              orderId: o.orderId,
              customerId: o.customerId,
              placedAt: o.createdAt,
              outcome: o.outcome,
              delivered: o.deliveredAmount !== null && o.currency ? { amount: formatAmount(parseAmount(o.deliveredAmount.toFixed(6))!), currency: o.currency } : null,
            },
          ]
        : [],
    ),
  });
}
