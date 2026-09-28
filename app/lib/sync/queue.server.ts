import { Queue } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "../db.server";

/**
 * The sync queue, reachable from the web process as well as the worker.
 *
 * It lived inside the worker, which meant only the worker could schedule a
 * store — and the worker only schedules at startup. A store claimed after that
 * was never scheduled and never synced until someone happened to restart the
 * worker. On a five-minute cycle that is invisible: nothing errors, the store
 * simply sits there empty.
 *
 * The connection is created lazily, so the web process pays for it only when a
 * store is actually claimed, and a Redis that is briefly down does not stop
 * the server booting.
 */
export const SYNC_QUEUE = "sync";
const PREFIX = process.env.BULLMQ_PREFIX ?? "growzar";

export type SyncJob = { storeId: string; kind: "cycle" | "backfill" };

let queue: Queue<SyncJob> | null = null;
let connection: IORedis | null = null;

export function syncQueue(): Queue<SyncJob> {
  if (!queue) {
    connection = new IORedis(
      process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      { maxRetriesPerRequest: null },
    );

    queue = new Queue(SYNC_QUEUE, {
      connection,
      prefix: PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
      },
    });
  }

  return queue;
}

function cycleSeconds(): number {
  return Number(process.env.SYNC_INTERVAL_SECONDS ?? 300);
}

/**
 * Put a store on the five-minute cycle. Idempotent: the scheduler is keyed by
 * store, so calling it twice re-asserts one schedule rather than creating two.
 */
export async function scheduleStore(storeId: string): Promise<void> {
  await syncQueue().upsertJobScheduler(
    `cycle:${storeId}`,
    { every: cycleSeconds() * 1000 },
    { name: "cycle", data: { storeId, kind: "cycle" } },
  );
}

export async function unscheduleStore(storeId: string): Promise<void> {
  await syncQueue().removeJobScheduler(`cycle:${storeId}`);
}

/**
 * Make the schedules match the database: every connected store on the cycle,
 * and nothing scheduled that no longer exists.
 *
 * Run at worker startup and periodically. Scheduling at claim time is the
 * primary path; this is the net underneath it, for a claim that happened while
 * Redis was unreachable, or a store deleted by hand.
 */
export async function reconcileSchedules(): Promise<{
  added: number;
  removed: number;
  total: number;
}> {
  const stores = await prisma.store.findMany({
    where: { connections: { some: { status: "CONNECTED" } } },
    select: { id: true },
  });
  const wanted = new Set(stores.map((store) => store.id));

  const existing = await syncQueue().getJobSchedulers(0, 1000);
  const scheduled = new Set(
    existing.map((s) => String(s.key ?? "").replace(/^cycle:/, "")),
  );

  let added = 0;
  for (const storeId of wanted) {
    if (!scheduled.has(storeId)) {
      await scheduleStore(storeId);
      added += 1;
    }
  }

  let removed = 0;
  for (const storeId of scheduled) {
    if (!wanted.has(storeId)) {
      await unscheduleStore(storeId);
      removed += 1;
    }
  }

  return { added, removed, total: wanted.size };
}

export async function closeSyncQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = null;
  connection = null;
}
