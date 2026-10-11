import { prisma } from "../db.server";
import { CONFIRMATION_TOPICS, contactReturnTest, type BuyerContact, type BuyerContactSection } from "./buyer-contact";
import { customersByPhone } from "./messaging.server";

/**
 * Every buyer message WhatKaBot has for the store, outside its COD
 * confirmation chats, by customer. Null when WhatKaBot has no conversations
 * for the store. Metadata only (D-55): times and the conversation's topic.
 */
export async function loadBuyerContact(storeId: string): Promise<BuyerContact | null> {
  const rows = await prisma.$queryRaw<Array<{ phone: string | null; topic: string | null; at: string | null }>>`
    SELECT c.payload->'customer'->>'phone' AS phone, c.payload->>'subcategory' AS topic, m.payload->>'createdAt' AS at
    FROM raw_records m
    JOIN raw_records c ON c."storeId" = m."storeId" AND c.app = 'WHATKABOT' AND c.entity = 'CONVERSATION'
      AND c."externalId" = m.payload->>'conversationId' AND c."deletedAt" IS NULL
    WHERE m."storeId" = ${storeId} AND m.app = 'WHATKABOT' AND m.entity = 'MESSAGE' AND m."deletedAt" IS NULL
      AND m.payload->>'direction' = 'inbound'`;
  if (!rows.length) return null;
  const kept = rows.filter((r) => r.phone && r.at && !Number.isNaN(Date.parse(r.at)) && !(r.topic && CONFIRMATION_TOPICS.has(r.topic)));
  const customerOf = await customersByPhone(storeId, kept.map((r) => r.phone));
  const byCustomer = new Map<string, Date[]>();
  let since: Date | null = null;
  for (const r of kept) {
    const at = new Date(r.at!);
    if (!since || at < since) since = at;
    const id = customerOf.get(r.phone!);
    if (id) byCustomer.set(id, [...(byCustomer.get(id) ?? []), at]);
  }
  for (const ts of byCustomer.values()) ts.sort((a, b) => a.getTime() - b.getTime());
  return { since, byCustomer };
}

/** The store's buyer messages, and whether writing in has meant a return there. */
export async function buyerContactSection(storeId: string): Promise<BuyerContactSection | null> {
  const contact = await loadBuyerContact(storeId);
  if (!contact) return null;
  const history = await prisma.orderGrain.findMany({
    // Courierify decides the outcome: the parcels I7 talks about are its own.
    where: { storeId, outcomeAuthority: "courierify", outcome: { in: ["delivered", "returned"] }, customerId: { not: null }, ...(contact.since ? { createdAt: { gte: contact.since } } : {}) },
    select: { customerId: true, createdAt: true, outcome: true, outcomeAt: true },
  });
  return { contact, test: contactReturnTest(history, contact) };
}
