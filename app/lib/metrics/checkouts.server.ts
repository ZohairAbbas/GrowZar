import { prisma } from "../db.server";
import { normalizeEmail } from "../customers/phone";
import { localDayOf } from "./order-grain";
import { checkoutsView, parseCheckout, parseFormAbandonment, RECOVERY_MS, type CheckoutsView } from "./checkouts";
import { buyerPhone, parseJourney, parseMessage } from "./messaging";
import { customersByPhone } from "./messaging.server";

type Payload = { payload: unknown };
const DAY_MS = 86_400_000;

/**
 * Checkouts started in the period's local days (Retainify), what happened to
 * each, and whether any Retainify message followed it up. Null when
 * Retainify has sent no checkouts for the period. Preventify's COD-form
 * abandonments go through the same core.
 */
export async function checkoutsSection(storeId: string, period: { from: string; to: string }, now = new Date()): Promise<CheckoutsView | null> {
  return abandonmentsSection(storeId, period, now, "CHECKOUT", parseCheckout);
}

/** Preventify's COD-form abandonments in the period, by the same rules (G-GZR5-9). */
export async function formAbandonmentsSection(storeId: string, period: { from: string; to: string }, now = new Date()): Promise<CheckoutsView | null> {
  return abandonmentsSection(storeId, period, now, "FORM_ABANDONMENT", parseFormAbandonment);
}

async function abandonmentsSection(
  storeId: string,
  period: { from: string; to: string },
  now: Date,
  entity: "CHECKOUT" | "FORM_ABANDONMENT",
  parse: typeof parseCheckout,
): Promise<CheckoutsView | null> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { timezone: true, country: true } });
  const tz = store.timezone ?? "UTC";
  const after = new Date(Date.parse(`${period.from}T00:00:00Z`) - DAY_MS).toISOString();
  const before = new Date(Date.parse(`${period.to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const app = entity === "CHECKOUT" ? "RETAINIFY" : "PREVENTIFY";
  const rows = await prisma.$queryRaw<Payload[]>`
    SELECT payload FROM raw_records
    WHERE "storeId" = ${storeId} AND app = ${app}::"SuiteApp" AND entity = ${entity}::"SyncEntity" AND "deletedAt" IS NULL
      AND payload->>'abandonedAt' >= ${after} AND payload->>'abandonedAt' < ${before}`;
  const parsed = rows
    .map((r) => parse(r.payload))
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .filter((c) => {
      const d = localDayOf(c.startedAt, tz);
      return d >= period.from && d <= period.to;
    });
  if (!parsed.length) return null;

  const first = Math.min(...parsed.map((c) => c.startedAt.getTime()));
  const last = Math.max(...parsed.map((c) => c.startedAt.getTime())) + RECOVERY_MS;
  const [messageRows, journeyRows, lastSent] = await Promise.all([
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'RETAINIFY' AND entity = 'MESSAGE' AND "deletedAt" IS NULL
        AND payload->>'sentAt' >= ${new Date(first).toISOString()} AND payload->>'sentAt' <= ${new Date(last).toISOString()}`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'RETAINIFY' AND entity = 'JOURNEY' AND "deletedAt" IS NULL`,
    prisma.$queryRaw<Array<{ journeyId: string; lastSent: string }>>`
      SELECT payload->>'journeyId' AS "journeyId", MAX(payload->>'sentAt') AS "lastSent" FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'RETAINIFY' AND entity = 'MESSAGE' AND "deletedAt" IS NULL AND payload->>'sentAt' IS NOT NULL
      GROUP BY 1`,
  ]);
  const messages = messageRows
    .map((r) => ({ m: parseMessage(r.payload), raw: r.payload as Record<string, unknown> }))
    .filter((x): x is { m: NonNullable<ReturnType<typeof parseMessage>>; raw: Record<string, unknown> } => x.m !== null && x.m.sentAt !== null && !x.m.failedAt);

  const customerOf = await customersByPhone(storeId, [
    ...parsed.map((c) => buyerPhone(c.phoneE164, c.phoneRaw, store.country)),
    ...messages.map(({ m }) => buyerPhone(m.phoneE164, m.phoneRaw, store.country)),
  ]);
  const customer = (e164: string | null, raw: string | null) => {
    const p = buyerPhone(e164, raw, store.country);
    return p ? (customerOf.get(p) ?? null) : null;
  };
  const checkouts = parsed.map(({ phoneE164, phoneRaw, ...c }) => ({ ...c, customerId: customer(phoneE164, phoneRaw) }));
  const customers = [...new Set(checkouts.map((c) => c.customerId).filter((c): c is string => c !== null))];
  const orders = customers.length
    ? await prisma.orderGrain.findMany({
        where: { storeId, customerId: { in: customers }, createdAt: { gte: new Date(first), lte: new Date(last) } },
        select: { customerId: true, createdAt: true },
      })
    : [];
  const orderTimes = new Map<string, number[]>();
  for (const o of orders) if (o.customerId && o.createdAt) orderTimes.set(o.customerId, [...(orderTimes.get(o.customerId) ?? []), o.createdAt.getTime()]);

  return checkoutsView({
    checkouts,
    messages: messages.map(({ m, raw }) => {
      const buyer = (raw.buyer && typeof raw.buyer === "object" ? raw.buyer : {}) as Record<string, unknown>;
      return {
        checkoutToken: typeof raw.checkoutToken === "string" ? raw.checkoutToken : null,
        email: normalizeEmail(typeof buyer.email === "string" ? buyer.email : null),
        customerId: customer(m.phoneE164, m.phoneRaw),
        sentAt: m.sentAt!,
      };
    }),
    orderTimes,
    // Retainify's cart journeys answer Shopify checkouts, not COD forms.
    journeys: entity === "CHECKOUT" ? journeyRows.map((r) => parseJourney(r.payload)).filter((j): j is NonNullable<typeof j> => j !== null) : [],
    lastSentByJourney: new Map(lastSent.filter((r) => r.journeyId).map((r) => [r.journeyId, r.lastSent])),
    now,
  });
}
