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

/**
 * The job id for an event row.
 *
 * A hyphen, not a colon. BullMQ 6 rejects `:` in a custom job id — it uses the
 * colon as its own key separator — and `add()` throws "Custom Id cannot
 * contain :". Every enqueue in production threw for two days because of it.
 *
 * Exported so a test can assert the shape without needing Redis, because the
 * whole failure was one character in a string nobody was checking.
 */
export function eventJobId(inboundEventId: string): string {
  return `event-${inboundEventId}`;
}

/** Characters BullMQ 6 refuses in a custom job id. */
export const ILLEGAL_JOB_ID_CHARS = [":"];

/**
 * How long to wait for Redis before calling an enqueue failed.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on its connection, which makes
 * ioredis retry a command forever. Without a bound, a dead Redis does not
 * throw — it hangs, and the sweeper blocks silently instead of reporting a
 * failure. A hang is the one outcome worse than an error, because nothing
 * anywhere says a word.
 */
const ENQUEUE_TIMEOUT_MS = 10_000;

export async function enqueueEvent(inboundEventId: string): Promise<void> {
  // The job id is derived from the row id, so an event enqueued twice — by the
  // endpoint and then by the sweeper — is one job, not two.
  const add = eventsQueue().add(
    "process",
    { inboundEventId },
    { jobId: eventJobId(inboundEventId) },
  );

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis did not accept the job within ${ENQUEUE_TIMEOUT_MS}ms`)),
      ENQUEUE_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([add, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeEventsQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = null;
  connection = null;
}
