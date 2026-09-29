import { prisma } from "../db.server";
import { enqueueEvent } from "./queue.server";

/**
 * Pick up events that were written to the database but never reached the
 * queue.
 *
 * An event is stored first and enqueued second. If the queue is unreachable in
 * between, the row exists and no job does — which is the right way round, but
 * only if something eventually notices.
 *
 * It lives here rather than inside the worker so it can be called directly,
 * which is how its failure path gets tested. The failure path is the whole
 * point: this swept 26 rows every 60 seconds for two days, reported success
 * each time, and enqueued none of them.
 */
export type SweepResult = {
  found: number;
  enqueued: number;
  failed: number;
  /** Rows not attempted, because the batch was abandoned after a failure. */
  abandoned: number;
  firstError: string | null;
};

/** Give the endpoint's own enqueue a moment to win the race. */
const GRACE_MS = 30_000;
const BATCH = 100;

export async function sweepStrandedEvents(
  now = new Date(),
): Promise<SweepResult> {
  const stranded = await prisma.inboundEvent.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      receivedAt: { lt: new Date(now.getTime() - GRACE_MS) },
    },
    select: { id: true },
    take: BATCH,
  });

  const result: SweepResult = {
    found: stranded.length,
    enqueued: 0,
    failed: 0,
    abandoned: 0,
    firstError: null,
  };

  for (const [index, event] of stranded.entries()) {
    try {
      // The job id is derived from the row id, so re-enqueuing something
      // already queued is a no-op rather than a second run.
      await enqueueEvent(event.id);
      result.enqueued += 1;
    } catch (error) {
      result.failed += 1;
      result.firstError = error instanceof Error ? error.message : String(error);

      // Stop the batch at the first failure. Whatever is wrong with the queue
      // is wrong for every row, and each attempt waits out the enqueue
      // timeout — a hundred of them take longer than the gap between sweeps,
      // so they pile up on each other while the worker looks busy. One failure
      // is all the signal needed.
      result.abandoned = stranded.length - index - 1;
      break;
    }
  }

  return result;
}

/**
 * The log line.
 *
 * Found, enqueued AND failed — all three, every time. The old line reported
 * only what it found and discarded every enqueue error, so a total outage read
 * as a calm "swept 26 stranded event(s)". A number that cannot go wrong is not
 * a signal.
 */
export function describeSweep(result: SweepResult): string {
  const abandoned =
    result.abandoned > 0 ? `, ${result.abandoned} not attempted` : "";
  return `[events] swept: found ${result.found}, enqueued ${result.enqueued}, failed ${result.failed}${abandoned}`;
}
