import { prisma } from "../db.server";
import { localDayOf } from "./order-grain";
import { consentView, parseConsent, parseConsentEvent, reachableByCustomer, type ConsentChannel, type ConsentView } from "./consent";
import { buyerPhone } from "./messaging";
import { customersByPhone } from "./messaging.server";

type Payload = { payload: unknown };
const DAY_MS = 86_400_000;

/**
 * Retainify's consent for one store, matched to its customers by phone, with
 * the period's changes. Null when Retainify has sent no consent for it.
 */
export async function consentSection(
  storeId: string,
  period: { from: string; to: string },
): Promise<{ view: ConsentView; byCustomer: Record<string, ConsentChannel[]> } | null> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { timezone: true, country: true } });
  const tz = store.timezone ?? "UTC";
  const after = new Date(Date.parse(`${period.from}T00:00:00Z`) - DAY_MS).toISOString();
  const before = new Date(Date.parse(`${period.to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const [contactRows, eventRows, buyers] = await Promise.all([
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'RETAINIFY' AND entity = 'CONSENT' AND "deletedAt" IS NULL`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'RETAINIFY' AND entity = 'CONSENT_EVENT' AND "deletedAt" IS NULL
        AND payload->>'source' IS DISTINCT FROM 'baseline'
        AND payload->>'createdAt' >= ${after} AND payload->>'createdAt' < ${before}`,
    prisma.customer.count({ where: { storeId, mergedIntoId: null } }),
  ]);
  const parsed = contactRows.map((r) => parseConsent(r.payload)).filter((c): c is NonNullable<typeof c> => c !== null);
  if (!parsed.length) return null;

  const phone = (c: (typeof parsed)[number]) => buyerPhone(c.phoneE164, c.phoneRaw, store.country);
  const customerOf = await customersByPhone(storeId, parsed.map(phone));
  const contacts = parsed.map((c) => {
    const p = phone(c);
    return { ...c, customerId: p ? (customerOf.get(p) ?? null) : null };
  });
  const events = eventRows
    .map((r) => parseConsentEvent(r.payload))
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .filter((e) => {
      const d = localDayOf(e.createdAt, tz);
      return d >= period.from && d <= period.to;
    });

  return { view: consentView({ contacts, events, buyers }), byCustomer: Object.fromEntries(reachableByCustomer(contacts)) };
}
