/**
 * Enrol a store into syncing, optionally backfilling history.
 *
 * Phase 3 backtests the detectors against 60–90 days, so that history has to
 * exist before Phase 3 starts — which means the pilot stores begin syncing at
 * the end of Phase 1, not at the start of Phase 2.
 *
 *   npx tsx scripts/enroll-store.ts <shop-domain> [--backfill-days 90] [--now]
 *
 * `--now` runs the backfill in this process instead of queueing it. Without
 * it the work goes to the worker, which defers backfills out of Pakistan
 * business hours (05:00–15:00 UTC, pack rule #4) — the polite default for a
 * wide pull against apps running on this same box.
 */
import { prisma } from "../app/lib/db.server";
import { syncStore, isQuietHours } from "../app/lib/sync/sync.server";
import { SUITE_APPS, getAppCredentials } from "../app/lib/apps/registry.server";
import { feedsFor } from "../app/lib/sync/entities";

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main() {
  const shopDomain = process.argv[2]?.trim().toLowerCase();
  if (!shopDomain) {
    console.error("Usage: enroll-store.ts <shop-domain> [--backfill-days 90] [--now]");
    process.exit(1);
  }

  const backfillDays = Number(arg("backfill-days") ?? 90);
  const runNow = process.argv.includes("--now");

  const store = await prisma.store.findUnique({
    where: { shopDomain },
    include: { connections: true },
  });

  if (!store) {
    console.error(
      `No store for ${shopDomain}. It has to be claimed through an app first (G-GZR-3).`,
    );
    process.exit(1);
  }

  const connected = store.connections.filter((c) => c.status === "CONNECTED");
  if (connected.length === 0) {
    console.error(`${shopDomain} has no connected apps; nothing to sync.`);
    process.exit(1);
  }

  // Say plainly which apps can actually be reached. An app with no platform
  // credential on this host is not a failure to debug later — it is a thing
  // someone has to go and mint.
  console.log(`Store ${shopDomain}:`);
  for (const app of SUITE_APPS) {
    const isConnected = connected.some((c) => c.app === app);
    if (!isConnected) continue;
    const reachable = getAppCredentials(app) !== null;
    console.log(
      `  ${app}: connected, ${reachable ? "credentials present" : "NO CREDENTIALS — cannot sync"}`,
    );
  }

  const since = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000);

  // Wind every feed's high-water mark back to the start of the backfill. The
  // cursor is cleared with it: a cursor from the incremental walk points into
  // a different result set than the one a backfill asks for.
  let feeds = 0;
  for (const connection of connected) {
    for (const feed of feedsFor(connection.app)) {
      await prisma.syncState.upsert({
        where: {
          storeId_app_entity: {
            storeId: store.id,
            app: connection.app,
            entity: feed.entity,
          },
        },
        update: { updatedSince: since, cursor: null, status: "IDLE", runStartedAt: null },
        create: {
          storeId: store.id,
          app: connection.app,
          entity: feed.entity,
          updatedSince: since,
        },
      });
      feeds += 1;
    }
  }

  console.log(
    `\n${feeds} feed(s) wound back to ${since.toISOString().slice(0, 10)} (${backfillDays} days).`,
  );

  if (!runNow) {
    console.log(
      isQuietHours()
        ? "It is Pakistan business hours; the worker will hold the backfill until they end."
        : "The worker will pick it up on its next cycle.",
    );
    console.log("Start the worker with: npm run build && npm run worker");
    await prisma.$disconnect();
    return;
  }

  if (isQuietHours()) {
    console.warn(
      "\nWARNING: it is Pakistan business hours (05:00–15:00 UTC). Running a backfill\n" +
        "now competes with live merchants on this box. Continuing because --now was given.",
    );
  }

  console.log("\nSyncing…");
  const results = await syncStore(store.id);

  for (const result of results) {
    console.log(
      `  ${result.app}/${result.entity}: ${result.written} written, ${result.duplicates} dup, ` +
        `${result.snapshots} snapshot(s), ${result.customers} new customer(s)` +
        (result.unparseablePhones ? `, ${result.unparseablePhones} unparseable phone(s)` : "") +
        (result.error ? `  ERROR ${result.error}` : "") +
        (result.finished ? "" : "  (more pages remain; run again)"),
    );
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
