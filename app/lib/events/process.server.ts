import type { InboundEvent } from "@prisma/client";

import { prisma } from "../db.server";

/**
 * Applying an event (API-CONTRACT §7).
 *
 * **An event is a notification, not a source of truth.** Nothing here writes a
 * merchant's numbers from an event payload. The payload says *something
 * changed*; the read API (§6) says *what it is now*, and that is where the
 * money comes from. An event that matters marks its entity for a re-read on
 * the next cycle instead of being trusted.
 *
 * That is not caution for its own sake. Events are at-least-once, unordered,
 * and — per §7's own note on coverage — not yet emitted from every path that
 * writes a status. A number built from them would be wrong in ways nobody
 * could reconstruct.
 */

/** D-17: how long an uninstalled app's data survives before deletion. */
export const PURGE_AFTER_DAYS = 30;

export type ProcessOutcome =
  | { status: "PROCESSED"; note: string }
  | { status: "SUPERSEDED"; note: string }
  | { status: "IGNORED"; note: string };

/**
 * §7: ordering is not guaranteed, so the newest `occurredAt` per entity wins.
 *
 * A `shipment.delivered` arriving after the `shipment.returned` that followed
 * it must not undo the return. The check is against events already applied for
 * the same entity, not against arrival order.
 */
async function isOvertaken(event: InboundEvent): Promise<boolean> {
  if (!event.entityKey || !event.storeId) return false;

  const newer = await prisma.inboundEvent.findFirst({
    where: {
      storeId: event.storeId,
      entityKey: event.entityKey,
      status: "PROCESSED",
      occurredAt: { gt: event.occurredAt },
      id: { not: event.id },
    },
    select: { id: true },
  });

  return newer !== null;
}

/**
 * `app.uninstalled` (D-17).
 *
 * **Nothing is wiped.** The section goes into reconnect mode: the last-known
 * data stays visible, stamped with the date it was last true, actions are
 * disabled, and a purge date is set 30 days out. A merchant who uninstalls an
 * app by accident on Friday and reinstalls on Monday loses nothing, and one
 * who meant it gets their data removed on a schedule they can be told about.
 */
async function applyUninstall(event: InboundEvent): Promise<ProcessOutcome> {
  if (!event.storeId) {
    return { status: "IGNORED", note: "No store is connected for that shop." };
  }

  const now = new Date();
  const purgeAfter = new Date(
    now.getTime() + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  );

  const { count } = await prisma.appConnection.updateMany({
    where: { storeId: event.storeId, app: event.app },
    data: {
      status: "DISCONNECTED",
      disconnectedAt: now,
      purgeAfter,
      // `lastSyncedAt` is deliberately untouched: it is what the "as of <date>"
      // stamp on the reconnect banner is made of.
    },
  });

  return count === 1
    ? {
        status: "PROCESSED",
        note: `Reconnect mode; data kept until ${purgeAfter.toISOString().slice(0, 10)}.`,
      }
    : { status: "IGNORED", note: "No connection row for that app." };
}

/** `app.installed`: the reverse, including clearing the purge date. */
async function applyInstall(event: InboundEvent): Promise<ProcessOutcome> {
  if (!event.storeId) {
    return { status: "IGNORED", note: "No store is connected for that shop." };
  }

  await prisma.appConnection.upsert({
    where: { storeId_app: { storeId: event.storeId, app: event.app } },
    update: {
      status: "CONNECTED",
      connectedAt: new Date(),
      disconnectedAt: null,
      // Reinstalling cancels the deletion. Leaving it set would delete the
      // data of a store that is connected again.
      purgeAfter: null,
      lastError: null,
    },
    create: {
      storeId: event.storeId,
      app: event.app,
      status: "CONNECTED",
      connectedAt: new Date(),
    },
  });

  return { status: "PROCESSED", note: "Connection restored." };
}

/**
 * For everything else: bring the affected feed forward on the next cycle.
 *
 * Rewinding `updatedSince` by a minute is what turns "something changed" into
 * "re-read it from the app". A minute rather than a moment, because an app's
 * clock and ours are not the same clock, and re-reading a few extra rows costs
 * nothing while missing one costs a number.
 */
const TOPIC_FEEDS: Record<string, "ORDER" | "PARCEL" | "SETTLEMENT" | "COST"> = {
  "order.created": "ORDER",
  "order.updated": "ORDER",
  "order.cancelled": "ORDER",
  "shipment.booked": "PARCEL",
  "shipment.status_changed": "PARCEL",
  "shipment.delivered": "PARCEL",
  "shipment.returned": "PARCEL",
  "return.received": "PARCEL",
  "settlement.received": "SETTLEMENT",
  "payout.received": "SETTLEMENT",
  "cost.updated": "COST",
};

const REREAD_MARGIN_MS = 60_000;

async function markFeedForReread(event: InboundEvent): Promise<ProcessOutcome> {
  const entity = TOPIC_FEEDS[event.topic];

  if (!entity || !event.storeId) {
    return {
      status: "IGNORED",
      note: `Nothing in R1 acts on ${event.topic}.`,
    };
  }

  const state = await prisma.syncState.findUnique({
    where: {
      storeId_app_entity: { storeId: event.storeId, app: event.app, entity },
    },
    select: { id: true, updatedSince: true },
  });

  if (!state) {
    // No sync has run for this feed yet, so the first one will read everything
    // anyway. Nothing to rewind.
    return { status: "PROCESSED", note: `${entity} will be read on the first sync.` };
  }

  const rewindTo = new Date(event.occurredAt.getTime() - REREAD_MARGIN_MS);

  if (state.updatedSince && state.updatedSince <= rewindTo) {
    return {
      status: "PROCESSED",
      note: `${entity} already due to be read from that point.`,
    };
  }

  await prisma.syncState.update({
    where: { id: state.id },
    data: { updatedSince: rewindTo },
  });

  return {
    status: "PROCESSED",
    note: `${entity} will be re-read from ${rewindTo.toISOString()}.`,
  };
}

export async function applyEvent(event: InboundEvent): Promise<ProcessOutcome> {
  if (await isOvertaken(event)) {
    return {
      status: "SUPERSEDED",
      note: "A newer event for the same thing was already applied.",
    };
  }

  if (event.topic === "app.uninstalled") return applyUninstall(event);
  if (event.topic === "app.installed") return applyInstall(event);

  return markFeedForReread(event);
}

/**
 * Process one stored event by id, recording what happened either way.
 *
 * Throws on failure so the queue retries. The row is marked FAILED with the
 * reason first, so the event log shows a stuck event rather than a silent gap.
 */
export async function processEvent(inboundEventId: string): Promise<ProcessOutcome> {
  const event = await prisma.inboundEvent.findUnique({
    where: { id: inboundEventId },
  });

  if (!event) {
    return { status: "IGNORED", note: "That event no longer exists." };
  }

  if (event.status === "PROCESSED" || event.status === "SUPERSEDED") {
    return { status: event.status, note: "Already handled." };
  }

  try {
    const outcome = await applyEvent(event);

    await prisma.inboundEvent.update({
      where: { id: event.id },
      data: {
        status: outcome.status,
        processedAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
      },
    });

    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";

    await prisma.inboundEvent.update({
      where: { id: event.id },
      data: {
        status: "FAILED",
        attempts: { increment: 1 },
        lastError: message.slice(0, 500),
      },
    });

    throw error;
  }
}
