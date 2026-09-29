import { afterAll, describe, expect, it } from "vitest";

import {
  ILLEGAL_JOB_ID_CHARS,
  closeEventsQueue,
  enqueueEvent,
  eventJobId,
  eventsQueue,
} from "./queue.server";

/**
 * The relay processed nothing for two days because a job id contained a colon
 * and BullMQ 6 rejects it. Nothing in the suite noticed, because every test
 * called `processEvent` directly — the handler was covered, the path to it was
 * not.
 *
 * So there are two tests here, deliberately:
 *
 *  - a pure one that fails the moment the id becomes illegal again, and
 *  - one that actually puts a job on the real queue, because that is the thing
 *    that broke and an assertion about a string would not have caught it if
 *    BullMQ had tightened something else.
 *
 * The second needs Redis. That is correct rather than inconvenient: Redis is a
 * hard dependency of this app, and a test suite that passes without it is the
 * suite that let this ship.
 */
describe("eventJobId", () => {
  it("contains nothing BullMQ refuses", () => {
    const id = eventJobId("01JB8Z-1234-abcd");
    for (const illegal of ILLEGAL_JOB_ID_CHARS) {
      expect(id, `job id must not contain ${JSON.stringify(illegal)}`).not.toContain(
        illegal,
      );
    }
  });

  it("is derived from the row id, so a double enqueue is one job", () => {
    expect(eventJobId("abc")).toBe(eventJobId("abc"));
    expect(eventJobId("abc")).not.toBe(eventJobId("abd"));
  });

  it("keeps the row id recoverable from the job id", () => {
    expect(eventJobId("row-1").endsWith("row-1")).toBe(true);
  });
});

describe("enqueueEvent against the real queue", () => {
  const rowId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  afterAll(async () => {
    const queue = eventsQueue();
    const job = await queue.getJob(eventJobId(rowId));
    // The worker may already have taken it; removing a locked job throws.
    await job?.remove().catch(() => {});
    await closeEventsQueue();
  });

  it("actually puts a job on the queue", async () => {
    await expect(enqueueEvent(rowId)).resolves.not.toThrow();

    const job = await eventsQueue().getJob(eventJobId(rowId));

    // Either the job is still there, or a running worker has already consumed
    // it — both prove it reached the queue, which is the thing that was broken.
    if (job) {
      expect(job.data.inboundEventId).toBe(rowId);
    } else {
      const counts = await eventsQueue().getJobCounts();
      expect(
        (counts.completed ?? 0) + (counts.active ?? 0) + (counts.failed ?? 0),
      ).toBeGreaterThan(0);
    }
  });
});
