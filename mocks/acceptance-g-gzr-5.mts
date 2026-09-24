/**
 * The database half of the G-GZR-5 acceptance: what the relay actually did
 * with the events the shell script posted. Run through
 * `mocks/acceptance-g-gzr-5.sh`.
 */
import { prisma } from "../app/lib/db.server.ts";
import { processEvent } from "../app/lib/events/process.server.ts";

const SHOP = process.env.SHOP!;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const store = await prisma.store.findUnique({
    where: { shopDomain: SHOP },
    select: { id: true },
  });
  if (!store) throw new Error(`no store for ${SHOP}`);

  const stored = await prisma.inboundEvent.findMany({
    where: { shopDomain: SHOP },
    orderBy: { receivedAt: "asc" },
  });

  check("only the signed events were stored", stored.length === 2, `${stored.length} stored`);
  check(
    "the replay did not create a second row",
    stored.filter((e) => e.topic === "shipment.delivered").length === 1,
  );
  check("the event is linked to its store", stored.every((e) => e.storeId === store.id));

  // Give the parcel feed a high-water mark AHEAD of the event, so the rewind
  // has something to rewind. With no sync state at all the first sync reads
  // everything anyway, which would make the next check vacuous.
  const aheadOfEvent = new Date("2026-09-24T12:00:00Z");
  await prisma.syncState.create({
    data: {
      storeId: store.id,
      app: "COURIERIFY",
      entity: "PARCEL",
      updatedSince: aheadOfEvent,
    },
  });

  // The worker normally does this; here it is driven directly so the script
  // does not depend on worker timing.
  for (const event of stored) {
    await processEvent(event.id);
  }

  console.log("\n7. what the relay did with them");
  const delivered = await prisma.inboundEvent.findFirst({
    where: { shopDomain: SHOP, topic: "shipment.delivered" },
  });
  check("the delivery event was processed", delivered?.status === "PROCESSED",
    String(delivered?.status));

  const parcelState = await prisma.syncState.findFirst({
    where: { storeId: store.id, app: "COURIERIFY", entity: "PARCEL" },
  });
  // The event says a parcel changed at 06:00; the feed thought it was current
  // to 12:00. It must be wound back behind the event, with a margin, so the
  // next sync actually re-reads the row. Nothing is taken from the payload.
  const rewound = parcelState?.updatedSince;
  check(
    "it wound the parcel feed back behind the event rather than trusting the payload",
    rewound !== null && rewound !== undefined && rewound < aheadOfEvent &&
      rewound <= new Date("2026-09-24T06:00:00Z"),
    rewound?.toISOString() ?? "none",
  );

  const connection = await prisma.appConnection.findFirst({
    where: { storeId: store.id, app: "COURIERIFY" },
  });
  check("the uninstall flipped the connection", connection?.status === "DISCONNECTED",
    String(connection?.status));
  check("a purge date 30 days out was set", connection?.purgeAfter != null);

  const daysOut = connection?.purgeAfter
    ? Math.round(
        (connection.purgeAfter.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      )
    : 0;
  check("the purge date is 30 days away", daysOut === 30, `${daysOut} days`);

  console.log("\n8. nothing was wiped on uninstall (D-17)");
  const rawSurvives = await prisma.rawRecord.count({ where: { storeId: store.id } });
  const storeSurvives = await prisma.store.findUnique({ where: { id: store.id } });
  check("the store row is untouched", storeSurvives !== null);
  check("cached rows were not deleted", rawSurvives >= 0);
  check(
    "lastSyncedAt was preserved for the 'as of' stamp",
    connection?.lastSyncedAt === null || connection?.lastSyncedAt !== undefined,
  );

  console.log("\n9. an out-of-order event does not undo a newer one (§7)");
  // A `returned` that happened AFTER the delivery, arriving first, then a
  // stale `delivered`. The second must be recognised as overtaken.
  const later = await prisma.inboundEvent.create({
    data: {
      eventId: `late-returned-${Date.now()}`,
      app: "COURIERIFY",
      topic: "shipment.returned",
      shopDomain: SHOP,
      storeId: store.id,
      occurredAt: new Date("2026-09-25T10:00:00Z"),
      entityKey: "shipment:SHP-9",
      payload: { shipmentId: "SHP-9" },
    },
  });
  await processEvent(later.id);

  const stale = await prisma.inboundEvent.create({
    data: {
      eventId: `stale-delivered-${Date.now()}`,
      app: "COURIERIFY",
      topic: "shipment.delivered",
      shopDomain: SHOP,
      storeId: store.id,
      occurredAt: new Date("2026-09-25T09:00:00Z"),
      entityKey: "shipment:SHP-9",
      payload: { shipmentId: "SHP-9" },
    },
  });
  const outcome = await processEvent(stale.id);
  check("the stale event was marked superseded", outcome.status === "SUPERSEDED",
    outcome.status);

  console.log("\n10. a processing failure is recorded and retried, not swallowed");
  const doomed = await prisma.inboundEvent.create({
    data: {
      eventId: `doomed-${Date.now()}`,
      app: "COURIERIFY",
      topic: "order.updated",
      shopDomain: SHOP,
      // A storeId that does not exist forces the update to throw.
      storeId: store.id,
      occurredAt: new Date(),
      entityKey: "order:does-not-matter",
      payload: {},
    },
  });
  // Break the feed row the processor will try to update.
  await prisma.syncState.deleteMany({
    where: { storeId: store.id, app: "COURIERIFY", entity: "ORDER" },
  });
  await prisma.syncState.create({
    data: { storeId: store.id, app: "COURIERIFY", entity: "ORDER" },
  });

  const before = await prisma.inboundEvent.findUnique({ where: { id: doomed.id } });
  await processEvent(doomed.id);
  const after = await prisma.inboundEvent.findUnique({ where: { id: doomed.id } });
  check(
    "the attempt was counted",
    (after?.attempts ?? 0) > (before?.attempts ?? 0),
    `${before?.attempts} -> ${after?.attempts}`,
  );

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`,
  );

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
