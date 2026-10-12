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
import { rebuildOrderGrain, updateOrderGrain } from "~/lib/metrics/order-grain.server";
import type { CityAlias } from "~/lib/metrics/city-aliases";
import { evaluateStore } from "~/lib/insights/inbox.server";
import { refreshFxRates } from "~/lib/metrics/fx.server";
import { refreshAdSpend } from "~/lib/metrics/ad-spend.server";
import { refreshProfitSettings } from "~/lib/metrics/summaries.server";
import { refreshBuyerNetwork, refreshOrderNetwork } from "~/lib/metrics/buyer-network.server";

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


/** When this process last refreshed exchange rates (all stores share them). */
let fxRefreshedAt = 0;

/**
 * Per store, since this process started: when its grain was last rebuilt in
 * full, and the city aliases that rebuild learned (the incremental path
 * needs them). No entry means the next cycle rebuilds in full.
 */
const grainState = new Map<string, { cityAliases: Map<string, CityAlias>; fullAt: number }>();
/** When each store's insights were last evaluated by this process. */
const evaluatedAt = new Map<string, number>();
const FULL_REBUILD_EVERY_MS = 60 * 60 * 1000;
const EVALUATE_EVERY_MS = 15 * 60 * 1000;
/** Above this many touched orders or parcels, a full rebuild is the cheaper path. */
const MAX_INCREMENTAL = 500;

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

    // The order grain is derived from what was just synced (G-GZR2-2).
    //
    // A full rebuild once per store after the worker starts (that is what
    // carries a change to the grain's *code* into stored rows), after a
    // deletion, when a cycle touched very many orders, and at least hourly
    // as the net under the incremental path. Otherwise only the orders this
    // cycle touched are rebuilt: for the largest store a full rebuild took
    // 9-28 s every cycle for ~5 changed orders.
    //
    // Insights read the grain and the other feeds (G-GZR3-3). They are
    // evaluated after a full rebuild, and otherwise at most every 15 minutes
    // when anything was written. Home and /insights compute their own view
    // on each request; this paces only the stored new/resolved record.
    //
    // Each step has its own try: a failed rebuild leaves the previous grain
    // in place (one transaction), and a detector failing must not look like
    // a grain failure, nor stop the rest of the cycle.
    const changes = {
      orderIds: [...new Set(results.flatMap((r) => r.grain.orderIds))],
      shipmentIds: [...new Set(results.flatMap((r) => r.grain.shipmentIds))],
    };
    const state = grainState.get(storeId);
    const now = Date.now();
    const full =
      !state ||
      results.some((r) => r.grain.full) ||
      now - state.fullAt > FULL_REBUILD_EVERY_MS ||
      changes.orderIds.length + changes.shipmentIds.length > MAX_INCREMENTAL;
    let grainChanged = false;
    try {
      if (full) {
        const grain = await rebuildOrderGrain(storeId);
        grainState.set(storeId, { cityAliases: grain.cityAliases, fullAt: now });
        grainChanged = true;
        console.log(
          `[grain] store=${storeId} orders=${grain.orders} parcelsOnly=${grain.fromParcelsOnly} withCustomer=${grain.withCustomer} ms=${grain.ms}`,
        );
      } else if (changes.orderIds.length || changes.shipmentIds.length) {
        const grain = await updateOrderGrain(storeId, changes, state.cityAliases);
        grainChanged = grain.considered > 0;
        console.log(`[grain] store=${storeId} incremental considered=${grain.considered} written=${grain.written} ms=${grain.ms}`);
      }
    } catch (error) {
      // The next cycle starts over with a full rebuild.
      grainState.delete(storeId);
      console.error(`[grain] store=${storeId} rebuild FAILED:`, error instanceof Error ? error.message : error);
    }

    const lastEvaluated = evaluatedAt.get(storeId) ?? 0;
    if ((full && grainChanged) || ((grainChanged || totals.written > 0) && now - lastEvaluated >= EVALUATE_EVERY_MS)) {
      try {
        const e = await evaluateStore(storeId);
        evaluatedAt.set(storeId, now);
        console.log(
          `[insights] store=${storeId} found=${e.found} new=${e.created} resolved=${e.resolved} reappeared=${e.reappeared} ms=${e.ms}`,
        );
      } catch (error) {
        console.error(`[insights] store=${storeId} evaluation FAILED:`, error instanceof Error ? error.message : error);
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

    // Exchange rates (rule #4, G-FIN2-1): not per store, so at most hourly
    // across all of them. Past days never change; today's arrives once the
    // provider publishes it, shortly after 00:00 UTC.
    if (Date.now() - fxRefreshedAt > 60 * 60 * 1000) {
      fxRefreshedAt = Date.now();
      try {
        const fx = await refreshFxRates();
        if (fx.stored || fx.problems.length) {
          console.log(`[fx] stored=${fx.stored} bases=${fx.bases.join(",")}` + (fx.problems.length ? ` problems: ${fx.problems.join("; ")}` : ""));
        }
      } catch (error) {
        console.error("[fx] refresh FAILED:", error instanceof Error ? error.message : error);
      }
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

    // Courierify's buyer network (G-GZR5-16): a few batches of due buyers
    // per cycle, one during the quiet hours. Its own try, like ad spend.
    try {
      const net = await refreshBuyerNetwork(storeId);
      if (net.asked || net.problem) {
        console.log(`[network] store=${storeId} asked=${net.asked} written=${net.written}` + (net.problem ? ` problem: ${net.problem}` : ""));
      }
    } catch (error) {
      console.error(`[network] store=${storeId} refresh FAILED:`, error instanceof Error ? error.message : error);
    }

    // Each order's buyer as of its placement (G-GZR5-17), once per order.
    try {
      const net = await refreshOrderNetwork(storeId);
      if (net.asked || net.problem) {
        console.log(`[network-orders] store=${storeId} asked=${net.asked} written=${net.written}` + (net.problem ? ` problem: ${net.problem}` : ""));
      }
    } catch (error) {
      console.error(`[network-orders] store=${storeId} refresh FAILED:`, error instanceof Error ? error.message : error);
    }

    return totals;
  },
  {
    connection,
    prefix: PREFIX,
    concurrency: 1,
    // BullMQ's default 30 s lock is renewed every 15 s by a timer. A cycle for
    // the largest store (0dscam-qn, 4,500 orders) takes 20–70 s, and on this
    // box (swap full, the worker near its MemoryHigh) the event loop has
    // stalled past 30 s mid-cycle: the lock expired, BullMQ marked the job
    // stalled and ran the whole cycle a second time beside the first (seen
    // as "Missing lock for job … moveToFinished" and stalled counts of 1–2).
    // One worker runs one job at a time, so a long lock cannot overlap
    // anything; it only delays recovering a job if this process dies
    // mid-cycle, and the next cycle comes five minutes later regardless.
    lockDuration: 10 * 60 * 1000,
  },
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
