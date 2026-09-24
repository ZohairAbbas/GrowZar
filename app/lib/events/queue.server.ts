import { Queue } from "bullmq";
import IORedis from "ioredis";

/**
 * The event relay's queue.
 *
 * Separate from `sync` so a slow backfill cannot delay an uninstall, but under
 * the same `growzar` prefix, because Redis on this box is shared with
 * Courierify's own BullMQ and the two must never collide.
 *
 * The connection is created lazily: the web process only needs it when an
 * event actually arrives, and a Redis that is briefly down should not stop the
 * server booting.
 */
export const EVENTS_QUEUE = "events";
const PREFIX = process.env.BULLMQ_PREFIX ?? "growzar";

let queue: Queue<{ inboundEventId: string }> | null = null;
let connection: IORedis | null = null;

export function eventsQueue(): Queue<{ inboundEventId: string }> {
  if (!queue) {
    connection = new IORedis(
      process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      { maxRetriesPerRequest: null },
    );

    queue = new Queue(EVENTS_QUEUE, {
      connection,
      prefix: PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 1000 },
        // §7's own retry ladder is what apps use when Growzar is down. This is
        // the mirror of it: a processing failure gets six tries over hours,
        // because the usual cause is another app being briefly unavailable.
        attempts: 6,
        backoff: { type: "exponential", delay: 60_000 },
      },
    });
  }

  return queue;
}

export async function enqueueEvent(inboundEventId: string): Promise<void> {
  // The job id is the row id, so an event enqueued twice — by the endpoint and
  // then by the sweeper — is one job, not two.
  await eventsQueue().add(
    "process",
    { inboundEventId },
    { jobId: `event:${inboundEventId}` },
  );
}

export async function closeEventsQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = null;
  connection = null;
}
