import type { CustomerIdentityKind } from "@prisma/client";

import { prisma } from "../db.server";
import { normalizeEmail, normalizePhone } from "./phone";

/**
 * Resolving a buyer to one customer record (rule #19).
 *
 * Match on normalised phone, email, and Shopify customer id — any one is
 * enough. Two orders that share any identity are the same person, and when a
 * later order links two records that were previously separate (a buyer who
 * gave a phone one time and an email the next, then both together), they are
 * merged rather than left as two.
 */

export type BuyerIdentity = {
  phone?: string | null;
  email?: string | null;
  shopifyCustomerId?: string | null;
  name?: string | null;
};

export type ResolvedCustomer = {
  customerId: string;
  created: boolean;
  mergedCount: number;
  /** Normalisation problems, so a store's bad phone data is visible. */
  phoneProblem?: string;
};

type IdentityTriple = {
  kind: CustomerIdentityKind;
  value: string;
  raw: string | null;
};

/**
 * Pull the buyer out of whatever shape an app's order row happens to have.
 *
 * Deliberately generous about field names and strict about what counts as an
 * identity: a missing phone is common, a wrong match is not recoverable.
 */
export function buyerFromOrderPayload(payload: unknown): BuyerIdentity {
  if (!payload || typeof payload !== "object") return {};
  const row = payload as Record<string, unknown>;

  const customer =
    row.customer && typeof row.customer === "object"
      ? (row.customer as Record<string, unknown>)
      : {};

  // Financify's order rows (G-FIN-5) nest the buyer differently:
  // `buyer: { phone: { e164, raw } | null, phoneSource }`, with no name or
  // email. Reading only the flat shapes left every Financify order without a
  // customer.
  const buyer =
    row.buyer && typeof row.buyer === "object"
      ? (row.buyer as Record<string, unknown>)
      : {};
  const buyerPhone =
    buyer.phone && typeof buyer.phone === "object"
      ? (buyer.phone as Record<string, unknown>)
      : {};

  const pick = (...candidates: unknown[]): string | null => {
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return String(candidate);
      }
    }
    return null;
  };

  return {
    phone: pick(
      row.customerPhone,
      row.phone,
      customer.phone,
      row.buyerPhone,
      // E.164 first; the raw string only when the app could not normalise it,
      // so Growzar's own parser gets a go (rule #19).
      buyerPhone.e164,
      buyerPhone.raw,
      // Courierify sends `phone` in E.164 only "when unambiguous" and null
      // otherwise — foreign numbers, on the pilot store — with the original
      // in `phoneRaw`. Ignoring it left those buyers with no customer at all
      // (found by the Courierify reconciliation, 2026-09-30).
      customer.phoneRaw,
    ),
    email: pick(row.customerEmail, row.email, customer.email),
    shopifyCustomerId: pick(
      row.shopifyCustomerId,
      customer.shopifyCustomerId,
      customer.id,
    ),
    name: pick(row.customerName, customer.name, row.buyerName),
  };
}

function identitiesFor(
  buyer: BuyerIdentity,
  defaultRegion: string | null,
): { identities: IdentityTriple[]; phoneProblem?: string } {
  const identities: IdentityTriple[] = [];

  const phone = normalizePhone(buyer.phone, defaultRegion);
  if (phone.e164) {
    identities.push({ kind: "PHONE", value: phone.e164, raw: phone.raw });
  }

  const email = normalizeEmail(buyer.email);
  if (email) {
    identities.push({ kind: "EMAIL", value: email, raw: buyer.email ?? null });
  }

  if (buyer.shopifyCustomerId) {
    identities.push({
      kind: "SHOPIFY_ID",
      value: buyer.shopifyCustomerId,
      raw: buyer.shopifyCustomerId,
    });
  }

  return {
    identities,
    // An unparseable phone is only worth reporting when there WAS a phone.
    phoneProblem: phone.problem === "empty" ? undefined : phone.problem,
  };
}

/**
 * Fold `loser` into `winner`: move its identities across, mark it merged.
 *
 * The losing row is kept rather than deleted. A metric computed last week
 * against it has to remain explicable, and `mergedIntoId` is how a later
 * reader follows the trail.
 */
async function mergeCustomers(winnerId: string, loserId: string) {
  await prisma.$transaction(async (tx) => {
    const loserIdentities = await tx.customerIdentity.findMany({
      where: { customerId: loserId },
    });

    for (const identity of loserIdentities) {
      // The winner may already hold the same identity — that is often exactly
      // why these two are being merged — so a clash means "already there",
      // not an error.
      const held = await tx.customerIdentity.findFirst({
        where: {
          customerId: winnerId,
          storeId: identity.storeId,
          kind: identity.kind,
          value: identity.value,
        },
        select: { id: true },
      });

      if (held) {
        await tx.customerIdentity.delete({ where: { id: identity.id } });
      } else {
        await tx.customerIdentity.update({
          where: { id: identity.id },
          data: { customerId: winnerId },
        });
      }
    }

    await tx.customer.update({
      where: { id: loserId },
      data: { mergedIntoId: winnerId },
    });
  });
}

/** Follow a merge chain to the record that is still live. */
async function liveCustomerId(customerId: string): Promise<string> {
  let current = customerId;

  for (let hop = 0; hop < 10; hop += 1) {
    const row = await prisma.customer.findUnique({
      where: { id: current },
      select: { mergedIntoId: true },
    });
    if (!row?.mergedIntoId) return current;
    current = row.mergedIntoId;
  }

  return current;
}

export async function resolveCustomer(options: {
  storeId: string;
  buyer: BuyerIdentity;
  defaultRegion: string | null;
  seenAt?: Date;
}): Promise<ResolvedCustomer | null> {
  const { storeId, buyer, defaultRegion } = options;
  const seenAt = options.seenAt ?? new Date();

  const { identities, phoneProblem } = identitiesFor(buyer, defaultRegion);

  // No usable identity is not a customer. Creating a nameless record per order
  // would inflate the very count this table exists to get right.
  if (identities.length === 0) {
    return phoneProblem ? { customerId: "", created: false, mergedCount: 0, phoneProblem } : null;
  }

  const existing = await prisma.customerIdentity.findMany({
    where: {
      storeId,
      OR: identities.map(({ kind, value }) => ({ kind, value })),
    },
    select: { customerId: true },
  });

  const matchedIds = [
    ...new Set(
      await Promise.all(existing.map((row) => liveCustomerId(row.customerId))),
    ),
  ];

  let customerId: string;
  let created = false;
  let mergedCount = 0;

  if (matchedIds.length === 0) {
    const customer = await prisma.customer.create({
      data: {
        storeId,
        displayName: buyer.name ?? null,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      },
      select: { id: true },
    });
    customerId = customer.id;
    created = true;
  } else {
    // The oldest record wins, so `firstSeenAt` keeps meaning what it says.
    const winners = await prisma.customer.findMany({
      where: { id: { in: matchedIds } },
      orderBy: { firstSeenAt: "asc" },
      select: { id: true },
    });

    customerId = winners[0]!.id;

    for (const loser of winners.slice(1)) {
      await mergeCustomers(customerId, loser.id);
      mergedCount += 1;
    }
  }

  for (const identity of identities) {
    // Racing syncs can reach the same new buyer at once; the unique constraint
    // decides, and the loser just updates what the winner wrote.
    await prisma.customerIdentity.upsert({
      where: {
        storeId_kind_value: {
          storeId,
          kind: identity.kind,
          value: identity.value,
        },
      },
      update: { lastSeenAt: seenAt, customerId },
      create: {
        customerId,
        storeId,
        kind: identity.kind,
        value: identity.value,
        raw: identity.raw,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      },
    });
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      lastSeenAt: seenAt,
      ...(buyer.name ? { displayName: buyer.name } : {}),
    },
  });

  return { customerId, created, mergedCount, phoneProblem };
}
