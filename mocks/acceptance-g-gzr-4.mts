/**
 * G-GZR-4 acceptance, driven directly against the sync engine.
 *
 * Every assertion here is one of the pack's acceptance criteria, or one of the
 * three defects the old hub's snapshot layer had. Run it through
 * `mocks/acceptance-g-gzr-4.sh`, which seeds the mocks first.
 */
import { prisma } from "../app/lib/db.server.ts";
import { syncFeed, syncStore } from "../app/lib/sync/sync.server.ts";
import { feedsFor } from "../app/lib/sync/entities.ts";
import { latestOrderSnapshots } from "../app/lib/sync/snapshots.server.ts";

const SHOP = process.env.SHOP!;
const CFY = process.env.CFY!;
const FIN = process.env.FIN!;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const seed = (base: string, path: string, rows: unknown[]) =>
  fetch(`${base}/__seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shop: SHOP, path, rows }),
  });

async function main() {
  // A store with both apps connected.
  const org = await prisma.organization.create({
    data: { name: `Sync ${SHOP}`, slug: `sync-${Date.now()}`, baseCurrency: "PKR" },
  });
  const store = await prisma.store.create({
    data: { organizationId: org.id, shopDomain: SHOP },
  });
  for (const app of ["COURIERIFY", "FINANCIFY"] as const) {
    await prisma.appConnection.create({
      data: { storeId: store.id, app, status: "CONNECTED", connectedAt: new Date() },
    });
  }

  console.log("\n1. a two-app store syncs orders, parcels, settlements and costs");
  const results = await syncStore(store.id);
  for (const result of results) {
    console.log(
      `      ${result.app}/${result.entity}: ${result.written} written, ${result.pages} page(s)${
        result.error ? ` ERROR ${result.error}` : ""
      }`,
    );
  }
  check("every feed finished without error", results.every((r) => !r.error));

  const counts = await prisma.rawRecord.groupBy({
    by: ["app", "entity"],
    where: { storeId: store.id },
    _count: { _all: true },
  });
  const countOf = (app: string, entity: string) =>
    counts.find((c) => c.app === app && c.entity === entity)?._count._all ?? 0;

  check("450 Financify orders cached", countOf("FINANCIFY", "ORDER") === 450,
    String(countOf("FINANCIFY", "ORDER")));
  check("120 parcels cached", countOf("COURIERIFY", "PARCEL") === 120,
    String(countOf("COURIERIFY", "PARCEL")));
  check("60 settlement lines cached", countOf("COURIERIFY", "SETTLEMENT") === 60,
    String(countOf("COURIERIFY", "SETTLEMENT")));
  check("40 costs cached", countOf("FINANCIFY", "COST") === 40,
    String(countOf("FINANCIFY", "COST")));
  // Courierify serves no orders endpoint — G-CFY-2 built confirmations
  // instead — so asking it for any would 404 every cycle.
  check("Courierify is not asked for orders it does not serve",
    countOf("COURIERIFY", "ORDER") === 0);

  const fresh = await prisma.store.findUnique({ where: { id: store.id } });
  console.log("\n2. currency and timezone come from the source, never a default");
  check("currency learned from the app", fresh?.currency === "PKR", String(fresh?.currency));
  check("timezone learned from the app", fresh?.timezone === "Asia/Karachi", String(fresh?.timezone));

  console.log("\n3. re-running changes nothing (updatedSince is inclusive, §6.2)");
  const second = await syncStore(store.id);
  const writtenAgain = second.reduce((n, r) => n + r.written, 0);
  const dupes = second.reduce((n, r) => n + r.duplicates, 0);
  check("no rows written on an unchanged re-run", writtenAgain === 0, `${writtenAgain} written`);
  check("the boundary row came back and was deduplicated", dupes > 0, `${dupes} duplicate(s)`);

  const totalAfter = await prisma.rawRecord.count({ where: { storeId: store.id } });
  check("row count unchanged", totalAfter === 450 + 120 + 60 + 40, String(totalAfter));

  console.log("\n4. a re-sent row updates rather than duplicating");
  const target = "5123456789005";
  await seed(FIN, "/api/v1/orders", [
    {
      id: target, orderId: target,
      updatedAt: new Date(Date.UTC(2026, 8, 20)).toISOString(),
      orderName: "#1005",
      total: { amount: "4500.00", currency: "PKR" },
      // Only the courier's booked fee changed — the exact case the old hub's
      // change detector missed.
      courierFee: { amount: "310.00", currency: "PKR" },
      confirmationStatus: "confirmed",
    },
  ]);
  const third = await syncStore(store.id);
  const rowsForTarget = await prisma.rawRecord.count({
    where: { storeId: store.id, app: "FINANCIFY", entity: "ORDER", externalId: target },
  });
  check("still one raw row for that order", rowsForTarget === 1, String(rowsForTarget));
  check("the correction was written", third.some((r) => r.written > 0));

  console.log("\n5. snapshot defect 2: a late fee correction produces a new version");
  const versions = await prisma.orderSnapshot.findMany({
    where: { storeId: store.id, orderId: target },
    orderBy: { version: "asc" },
  });
  check("two versions exist", versions.length === 2, `${versions.length} version(s)`);
  check("version 1 is marked superseded", versions[0]?.supersededAt !== null);
  check("version 2 is current", versions[1]?.supersededAt === null);

  console.log("\n6. snapshot defect 3: the latest view returns one row per order");
  const latest = await latestOrderSnapshots(store.id);
  const snapshotRows = await prisma.orderSnapshot.count({ where: { storeId: store.id } });
  check("view rows == distinct orders", latest.length === 450, String(latest.length));
  check("base table holds more rows than the view", snapshotRows > latest.length,
    `${snapshotRows} vs ${latest.length}`);
  check("the view shows the corrected version",
    (latest.find((r) => r.orderId === target)?.version ?? 0) === 2);

  console.log("\n7. snapshot defect 1: finalizing twice does not collide");
  await seed(FIN, "/api/v1/orders", [
    {
      id: target, orderId: target,
      updatedAt: new Date(Date.UTC(2026, 8, 21)).toISOString(),
      orderName: "#1005",
      total: { amount: "4500.00", currency: "PKR" },
      courierFee: { amount: "310.00", currency: "PKR" },
      confirmationStatus: "confirmed",
      isFinal: true,
    },
  ]);
  await syncStore(store.id);
  // Re-send it again with a later updatedAt: the sync will read it once more
  // and try to snapshot an order that is already final. The old hub crashed
  // here on the second run.
  await seed(FIN, "/api/v1/orders", [
    {
      id: target, orderId: target,
      updatedAt: new Date(Date.UTC(2026, 8, 22)).toISOString(),
      orderName: "#1005",
      total: { amount: "4500.00", currency: "PKR" },
      courierFee: { amount: "999.00", currency: "PKR" },
      confirmationStatus: "confirmed",
      isFinal: true,
    },
  ]);
  const finalRun = await syncStore(store.id);
  check("the second finalizing run did not error", finalRun.every((r) => !r.error),
    finalRun.find((r) => r.error)?.error ?? "");

  const finals = await prisma.orderSnapshot.count({
    where: { storeId: store.id, orderId: target, isFinal: true },
  });
  check("exactly one final version", finals === 1, String(finals));
  const viewAfterFinal = await latestOrderSnapshots(store.id, { orderIds: [target] });
  check("the view still returns one row for it", viewAfterFinal.length === 1);

  console.log("\n8. interrupted mid-walk, then resumed: no duplicates, no gaps");
  const secondShop = `${SHOP}`;
  // Reset this store's order feed so the walk starts again from nothing.
  await prisma.rawRecord.deleteMany({
    where: { storeId: store.id, app: "FINANCIFY", entity: "ORDER" },
  });
  await prisma.syncState.updateMany({
    where: { storeId: store.id, app: "FINANCIFY", entity: "ORDER" },
    data: { cursor: null, updatedSince: null, status: "IDLE", runStartedAt: null },
  });

  const orderFeed = feedsFor("FINANCIFY").find((f) => f.entity === "ORDER")!;

  // Fail hard enough to exhaust the client's retries on the SECOND page, which
  // from the database's point of view is indistinguishable from the worker
  // being killed between two pages.
  // Let page 1 land, then fail page 2 hard enough to exhaust the client's
  // retries. From the database's point of view that is exactly a worker killed
  // between two pages — and it is deterministic, which killing one is not.
  await fetch(`${FIN}/__fail?shop=${SHOP}&after=1&count=4`);

  const interrupted = await syncFeed({
    storeId: store.id, shopDomain: secondShop, app: "FINANCIFY", feed: orderFeed,
  });
  const afterInterrupt = await prisma.rawRecord.count({
    where: { storeId: store.id, app: "FINANCIFY", entity: "ORDER" },
  });
  const state = await prisma.syncState.findFirst({
    where: { storeId: store.id, app: "FINANCIFY", entity: "ORDER" },
  });
  console.log(
    `      interrupted after ${afterInterrupt} rows (${interrupted.error ?? "no error"}), cursor=${state?.cursor ? "held" : "none"}, state=${state?.status}`,
  );
  check("the interrupted run reported a failure", Boolean(interrupted.error));
  check("it stopped mid-walk, having written one page", afterInterrupt === 200,
    String(afterInterrupt));
  check("the cursor from the written page was kept", Boolean(state?.cursor));
  check("the failure did not leave the feed locked as RUNNING", state?.status === "FAILED");

  const resumed = await syncFeed({
    storeId: store.id, shopDomain: secondShop, app: "FINANCIFY", feed: orderFeed,
  });
  const afterResume = await prisma.rawRecord.count({
    where: { storeId: store.id, app: "FINANCIFY", entity: "ORDER" },
  });
  const distinct = await prisma.rawRecord.groupBy({
    by: ["externalId"],
    where: { storeId: store.id, app: "FINANCIFY", entity: "ORDER" },
  });
  console.log(
    `      resumed: +${resumed.written} rows, ${resumed.duplicates} duplicate(s), error=${resumed.error ?? "none"}`,
  );
  check("the resume succeeded", !resumed.error, resumed.error ?? "");
  check("every order is present after the resume", afterResume === 450, String(afterResume));
  check("no duplicates", distinct.length === afterResume, `${distinct.length} distinct`);

  console.log("\n9. tombstones are applied, not inferred from absence (§6.2)");
  await fetch(`${CFY}/__seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shop: SHOP, path: "/api/v1/growzar/shipments", deletedIds: ["SHP-3"] }),
  });
  await prisma.syncState.updateMany({
    where: { storeId: store.id, app: "COURIERIFY", entity: "PARCEL" },
    data: { updatedSince: null, cursor: null },
  });
  await syncStore(store.id);
  const tombstoned = await prisma.rawRecord.findFirst({
    where: { storeId: store.id, app: "COURIERIFY", entity: "PARCEL", externalId: "SHP-3" },
  });
  check("the deleted parcel is marked, not removed", tombstoned?.deletedAt !== null);
  check("its payload is still there to explain past numbers", tombstoned?.payload !== null);

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
