import { prisma } from "../db.server";
import { localDayOf } from "./order-grain";
import { conversationsView, parseConversation, parseMessageMeta, type ConversationsView } from "./conversations";

type Payload = { payload: unknown };
const DAY_MS = 86_400_000;

/**
 * The Inbox section for one store, from the WhatKaBot rows Growzar has synced
 * (G-GZR5-12): conversations opened and messages sent in the period's local
 * days, and every conversation still open now. Null before WhatKaBot has sent
 * any conversation for the store.
 */
export async function conversationsSection(storeId: string, period: { from: string; to: string }, now = new Date()): Promise<ConversationsView | null> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { timezone: true } });
  const tz = store.timezone ?? "UTC";
  const after = new Date(Date.parse(`${period.from}T00:00:00Z`) - DAY_MS).toISOString();
  const before = new Date(Date.parse(`${period.to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const inPeriod = (d: Date) => {
    const day = localDayOf(d, tz);
    return day >= period.from && day <= period.to;
  };
  const [periodRows, openRows, messageRows, any] = await Promise.all([
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'WHATKABOT' AND entity = 'CONVERSATION' AND "deletedAt" IS NULL
        AND payload->>'createdAt' >= ${after} AND payload->>'createdAt' < ${before}`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'WHATKABOT' AND entity = 'CONVERSATION' AND "deletedAt" IS NULL
        AND payload->>'status' NOT IN ('resolved', 'closed')`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'WHATKABOT' AND entity = 'MESSAGE' AND "deletedAt" IS NULL
        AND payload->>'createdAt' >= ${after} AND payload->>'createdAt' < ${before}`,
    prisma.rawRecord.findFirst({ where: { storeId, app: "WHATKABOT", entity: "CONVERSATION" }, select: { id: true } }),
  ]);
  if (!any) return null;
  const keep = <T,>(rows: Payload[], parse: (p: unknown) => T | null) => rows.map((r) => parse(r.payload)).filter((x): x is T => x !== null);
  return conversationsView({
    inPeriod: keep(periodRows, parseConversation).filter((c) => inPeriod(c.createdAt)),
    open: keep(openRows, parseConversation),
    messages: keep(messageRows, parseMessageMeta).filter((m) => inPeriod(m.createdAt)),
    now,
  });
}
