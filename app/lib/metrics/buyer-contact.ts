import { MIN_ROUTE_Z, zScore } from "./findings";

/**
 * Buyers who wrote to the store on WhatKaBot after ordering (I7, G-GZR5-15):
 * the half of "parcels about to become returns" that Courierify cannot see.
 *
 * Only the buyer's own messages count, matched to the store's customers by
 * phone. Chats WhatKaBot opened to confirm a COD order are left out (the
 * buyer answering "yes" is not a worry about the parcel), and so is the first
 * day after the order, which is when those confirmations happen.
 *
 * Whether writing in means a return is measured per store, on its own decided
 * orders, before a card says so: at one pilot store buyers who wrote came back
 * twice as often, at another no more than anyone else.
 */

/** WhatKaBot's conversation subcategories for its own COD confirmation chats. */
export const CONFIRMATION_TOPICS = new Set(["cod_confirm", "cod_decline"]);
/** A message within this long of the order is about confirming it, not the parcel. */
export const AFTER_ORDER_MS = 86_400_000;
/** Decided orders each side needs before the store's history is read. */
export const MIN_DECIDED = 30;

export type BuyerContact = {
  /** The earliest buyer message on record: history before it says nothing. */
  since: Date | null;
  /** Each customer's inbound message times, oldest first. */
  byCustomer: ReadonlyMap<string, readonly Date[]>;
};

export type ContactHistoryOrder = { customerId: string | null; createdAt: Date | null; outcome: string; outcomeAt: Date | null };

export type ContactReturnTest = {
  wrote: { decided: number; returned: number; rate: number | null };
  silent: { decided: number; returned: number; rate: number | null };
  z: number | null;
  /** Buyers who wrote in came back more often, with enough orders and z >= 1.96. */
  significant: boolean;
};

/** Whether the buyer wrote in after the order's first day and before `until`. */
export function wroteAfterOrdering(contact: BuyerContact, customerId: string | null, createdAt: Date | null, until: Date): boolean {
  if (!customerId || !createdAt) return false;
  const from = createdAt.getTime() + AFTER_ORDER_MS;
  return (contact.byCustomer.get(customerId) ?? []).some((t) => t.getTime() > from && t.getTime() <= until.getTime());
}

const pct = (returned: number, decided: number) => (decided ? Math.round((1000 * returned) / decided) / 10 : null);

/**
 * The store's decided orders since its message history began: returns where
 * the buyer wrote in between ordering and the outcome, against the rest.
 */
export function contactReturnTest(history: readonly ContactHistoryOrder[], contact: BuyerContact): ContactReturnTest {
  const wrote = { decided: 0, returned: 0 };
  const silent = { decided: 0, returned: 0 };
  for (const o of history) {
    if ((o.outcome !== "delivered" && o.outcome !== "returned") || !o.createdAt || !o.outcomeAt) continue;
    if (!contact.since || o.createdAt < contact.since) continue;
    const side = wroteAfterOrdering(contact, o.customerId, o.createdAt, o.outcomeAt) ? wrote : silent;
    side.decided += 1;
    if (o.outcome === "returned") side.returned += 1;
  }
  const enough = wrote.decided >= MIN_DECIDED && silent.decided >= MIN_DECIDED;
  const z = enough ? Math.round(zScore(wrote.returned, wrote.decided, silent.returned, silent.decided) * 100) / 100 : null;
  return {
    wrote: { ...wrote, rate: pct(wrote.returned, wrote.decided) },
    silent: { ...silent, rate: pct(silent.returned, silent.decided) },
    z,
    significant: z !== null && z >= MIN_ROUTE_Z,
  };
}

export type BuyerContactSection = { contact: BuyerContact; test: ContactReturnTest };
