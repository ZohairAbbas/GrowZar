import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "~/lib/db.server";
import { isQuietHours, syncStore } from "~/lib/sync/sync.server";
import { EVENTS_QUEUE, enqueueEvent } from "~/lib/events/queue.server";
import { processEvent } from "~/lib/events/process.server";

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
const SYNC_QUEUE = "sync";
const CYCLE_SECONDS = Number(process.env.SYNC_INTERVAL_SECONDS ?? 300);

const connection = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});

type SyncJob = {
  storeId: string;
  /** A backfill is a wide pull and waits for quiet hours; a cycle never does. */
  kind: "cycle" | "backfill";
};

export const syncQueue = new Queue<SyncJob>(SYNC_QUEUE, {
  connection,
  prefix: PREFIX,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
  },
});

/**
 * One repeatable job per store, keyed by store id so re-enqueuing is idempotent
 * — a restart must not leave two schedules running for the same store.
 */
export async function scheduleStore(storeId: string): Promise<void> {
  // BullMQ 6's job scheduler, keyed by store. Upserting is idempotent, so a
  // restart re-asserts the schedule instead of leaving a second one running
  // beside the first — which is what `add` with `repeat` used to do.
  await syncQueue.upsertJobScheduler(
    `cycle:${storeId}`,
    { every: CYCLE_SECONDS * 1000 },
    { name: "cycle", data: { storeId, kind: "cycle" } },
  );
}

export async function scheduleAllConnectedStores(): Promise<number> {
  const stores = await prisma.store.findMany({
    where: { connections: { some: { status: "CONNECTED" } } },
    select: { id: true },
  });

  for (const store of stores) {
    await scheduleStore(store.id);
  }

  return stores.length;
}

export const syncWorker = new Worker<SyncJob>(
  SYNC_QUEUE,
  async (job) => {
    const { storeId, kind } = job.data;

    if (kind === "backfill" && isQuietHours()) {
      // Not a failure: come back after business hours rather than burning an
      // attempt (pack rule #4).
      const retryIn = 30 * 60 * 1000;
      await syncQueue.add(job.name, job.data, { delay: retryIn });
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
      await syncQueue.removeJobScheduler(`cycle:${storeId}`);
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

async function sweepStrandedEvents() {
  const stranded = await prisma.inboundEvent.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      // Give the endpoint's own enqueue a moment to win the race.
      receivedAt: { lt: new Date(Date.now() - 30_000) },
    },
    select: { id: true },
    take: 100,
  });

  for (const event of stranded) {
    // The job id is the row id, so re-enqueuing something already queued is a
    // no-op rather than a second run.
    await enqueueEvent(event.id).catch(() => {});
  }

  if (stranded.length > 0) {
    console.log(`[events] swept ${stranded.length} stranded event(s)`);
  }
}

const sweepTimer = setInterval(() => {
  void sweepStrandedEvents().catch((error) =>
    console.error("[events] sweep failed", error),
  );
}, SWEEP_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[sync] ${signal}: draining`);
  clearInterval(sweepTimer);
  await eventsWorker.close();
  // Closing the worker lets the job in flight finish. A sync killed mid-run is
  // safe by design, but finishing the page it is on avoids re-fetching it.
  await syncWorker.close();
  await syncQueue.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

scheduleAllConnectedStores()
  .then((count) => console.log(`[sync] worker up; ${count} store(s) scheduled`))
  .catch((error) => {
    console.error("[sync] could not schedule stores", error);
    process.exit(1);
  });
