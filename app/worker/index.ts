import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "~/lib/db.server";
import { isQuietHours, syncStore } from "~/lib/sync/sync.server";
import { EVENTS_QUEUE, enqueueEvent } from "~/lib/events/queue.server";
import {
  SYNC_QUEUE,
  type SyncJob,
  reconcileSchedules,
  scheduleStore,
  syncQueue as sharedSyncQueue,
  unscheduleStore,
} from "~/lib/sync/queue.server";
import { processEvent } from "~/lib/events/process.server";
import { describeSweep, sweepStrandedEvents } from "~/lib/events/sweep.server";
import { rebuildOrderGrain } from "~/lib/metrics/order-grain.server";
import { refreshAdSpend } from "~/lib/metrics/ad-spend.server";
import { refreshProfitSettings } from "~/lib/metrics/summaries.server";

/**
 * The sync worker.
 *
 * Redis on this box is shared with Courierify's own BullMQ, so every key is
 * under the `growzar` prefix and the queues cannot collide (G-GZR-5 uses the
 * same prefix for the event relay).
 *
 * Concurrency is 1. The worker's database pool is 2 connections, the box has
 * 2 vCPUs with swap already full, and the apps being polled are running on it
 * too. Syncing two stores at once would be borrowing from the four production
 * apps to finish Growzar's work a minute sooner.
 */
const PREFIX = process.env.BULLMQ_PREFIX ?? "growzar";
const CYCLE_SECONDS = Number(process.env.SYNC_INTERVAL_SECONDS ?? 300);

const connection = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});


/** Stores whose grain this process has rebuilt; see the rebuild below. */
const grainRebuiltSinceStart = new Set<string>();

export const syncWorker = new Worker<SyncJob>(
  SYNC_QUEUE,
  async (job) => {
    const { storeId, kind } = job.data;

    if (kind === "backfill" && isQuietHours()) {
      // Not a failure: come back after business hours rather than burning an
      // attempt (pack rule #4).
      const retryIn = 30 * 60 * 1000;
      await sharedSyncQueue().add(job.name, job.data, { delay: retryIn });
      return { deferred: "quiet_hours" };
    }

    // A scheduler outlives its store: `upsertJobScheduler` state lives in
    // Redis, and deleting a store does not touch it. Left alone, a deleted
    // store's cycle fires every five minutes forever, doing nothing, on a box
    // with 2 vCPUs and no headroom. So a job whose store is gone removes its
    // own schedule on the way out.
    const stillExists = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });

    if (!stillExists) {
      await unscheduleStore(storeId);
      console.log(`[sync] store=${storeId} no longer exists; schedule removed`);
      return { removed: true };
    }

    const results = await syncStore(storeId);

    const totals = results.reduce(
      (acc, result) => ({
        written: acc.written + result.written,
        duplicates: acc.duplicates + result.duplicates,
        tombstoned: acc.tombstoned + result.tombstoned,
        skipped: acc.skipped + result.skipped,
        snapshots: acc.snapshots + result.snapshots,
        errors: acc.errors + (result.error ? 1 : 0),
      }),
      { written: 0, duplicates: 0, tombstoned: 0, skipped: 0, snapshots: 0, errors: 0 },
    );

    // The report asks for rows per store per day and request volume per app;
    // this line is where those numbers come from.
    console.log(
      `[sync] store=${storeId} feeds=${results.length} written=${totals.written} dup=${totals.duplicates} tomb=${totals.tombstoned} skipped=${totals.skipped} snapshots=${totals.snapshots} errors=${totals.errors}`,
    );

    // The order grain is derived from what was just synced (G-GZR2-2), so
    // it is rebuilt whenever a cycle wrote anything, and once per store after
    // the worker starts. The second condition is what carries a change to
    // the grain's *code* into stored rows: without it, the G-GZR2-3 deploy
    // left every store's grain on the old builder until new orders happened
    // to arrive. A failed rebuild leaves the previous grain in place (it is
    // one transaction) and is logged as a failure, not swallowed.
    if (totals.written > 0 || !grainRebuiltSinceStart.has(storeId)) {
      try {
        const grain = await rebuildOrderGrain(storeId);
        grainRebuiltSinceStart.add(storeId);
        console.log(
          `[grain] store=${storeId} orders=${grain.orders} parcelsOnly=${grain.fromParcelsOnly} withCustomer=${grain.withCustomer} ms=${grain.ms}`,
        );
      } catch (error) {
        console.error(`[grain] store=${storeId} rebuild FAILED:`, error instanceof Error ? error.message : error);
      }
    }

    // Ad spend (G-GZR2-3): trailing days hourly, older days once each,
    // outside business hours. Its own try, so a Financify hiccup costs the
    // ad numbers and not the orders.
    try {
      const ads = await refreshAdSpend(storeId);
      if (ads.fetched.length || ads.problems.length) {
        console.log(
          `[ads] store=${storeId} fetched=${ads.fetched.length} (${ads.fetched[0] ?? ""}…${ads.fetched.at(-1) ?? ""})` +
            (ads.problems.length ? ` problems: ${ads.problems.slice(0, 3).join("; ")}` : ""),
        );
      }
    } catch (error) {
      console.error(`[ads] store=${storeId} refresh FAILED:`, error instanceof Error ? error.message : error);
    }

    // Profit settings (rule #15), hourly: an organization roll-up compares
    // them across stores.
    try {
      if ((await refreshProfitSettings(storeId)) === "fetched") {
        console.log(`[settings] store=${storeId} profit settings refreshed`);
      }
    } catch (error) {
      console.error(`[settings] store=${storeId} refresh FAILED:`, error instanceof Error ? error.message : error);
    }

    return totals;
  },
  { connection, prefix: PREFIX, concurrency: 1 },
);

syncWorker.on("failed", (job, error) => {
  console.error(`[sync] job ${job?.id} failed:`, error.message);
});

/**
 * The event relay's processor (G-GZR-5).
 *
 * A separate worker on a separate queue, so a backfill walking 25 pages cannot
 * sit in front of an `app.uninstalled`. Concurrency is 2: the work per event is
 * small, and an uninstall arriving while a hundred status changes are queued
 * should not wait for all of them.
 */
export const eventsWorker = new Worker<{ inboundEventId: string }>(
  EVENTS_QUEUE,
  async (job) => {
    const outcome = await processEvent(job.data.inboundEventId);
    console.log(
      `[events] ${job.data.inboundEventId} -> ${outcome.status}: ${outcome.note}`,
    );
    return outcome;
  },
  { connection, prefix: PREFIX, concurrency: 2 },
);

eventsWorker.on("failed", (job, error) => {
  console.error(`[events] job ${job?.id} failed:`, error.message);
});

/**
 * The sweeper.
 *
 * An event is written to the database and then enqueued. If Redis is
 * unavailable in between, the row exists and no job does — which is the right
 * way round, but only if something eventually notices. This does, every
 * minute, and it also retries events whose jobs exhausted their attempts.
 */
const SWEEP_INTERVAL_MS = 60_000;

async function sweep() {
  const result = await sweepStrandedEvents();
  if (result.found === 0) return;

  if (result.failed > 0) {
    console.error(`${describeSweep(result)} — first error: ${result.firstError}`);
  } else {
    console.log(describeSweep(result));
  }
}

const sweepTimer = setInterval(() => {
  void sweep().catch((error) => console.error("[events] sweep failed", error));
}, SWEEP_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[sync] ${signal}: draining`);
  clearInterval(sweepTimer);
  clearInterval(reconcileTimer);
  await eventsWorker.close();
  // Closing the worker lets the job in flight finish. A sync killed mid-run is
  // safe by design, but finishing the page it is on avoids re-fetching it.
  await syncWorker.close();
  await sharedSyncQueue().close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * Keep the schedules matching the database. Startup plus every cycle: the web
 * process schedules a store the moment it is claimed, and this is the net
 * under that for a claim made while Redis was unreachable.
 */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

async function reconcile(label: string) {
  const { added, removed, total } = await reconcileSchedules();
  if (added || removed || label === "startup") {
    console.log(
      `[sync] ${label}: ${total} connected store(s) scheduled (+${added} -${removed})`,
    );
  }
}

const reconcileTimer = setInterval(() => {
  void reconcile("reconcile").catch((error) =>
    console.error("[sync] reconcile failed", error),
  );
}, RECONCILE_INTERVAL_MS);

reconcile("startup").catch((error) => {
  console.error("[sync] could not schedule stores", error);
  process.exit(1);
});
