import type { Prisma } from "@prisma/client";

import { env } from "../env.server";
import { baselineFrom, internalEmails, isInternal, opensWatch, type Trigger } from "./watch";

/**
 * Opening and closing watches (G-GZR9-1), inside the transaction that records
 * the click, app link or dismissal, so an event and its watch never disagree.
 */

const INTERNAL = internalEmails(env.INTERNAL_EMAILS);

/**
 * Open a watch for a click at `at` if the opening rule says so (watch.ts),
 * with the finding the last evaluation kept as its baseline. Returns the new
 * watch's id, or null when none was opened.
 */
export async function openWatch(
  tx: Prisma.TransactionClient,
  w: { insightId: string; userId: string | null; trigger: Trigger; at: Date },
): Promise<string | null> {
  // Two clicks at once must not both open a watch: serialise per insight.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`watch:${w.insightId}`}))`;
  const insight = await tx.insight.findUniqueOrThrow({
    where: { id: w.insightId },
    select: { storeId: true, detector: true, subject: true, lastFinding: true, lastEvidence: true, lastSeenAt: true },
  });
  const [latest, reappeared] = await Promise.all([
    tx.insightOutcome.findFirst({ where: { insightId: w.insightId }, orderBy: { actedAt: "desc" }, select: { actedAt: true, closedAt: true } }),
    tx.insightEvent.findFirst({ where: { insightId: w.insightId, kind: "reappeared" }, orderBy: { at: "desc" }, select: { at: true } }),
  ]);
  if (!opensWatch(insight.detector, latest, reappeared?.at ?? null)) return null;

  const user = w.userId ? await tx.user.findUnique({ where: { id: w.userId }, select: { email: true } }) : null;
  const { baseline, source } = baselineFrom(insight.lastFinding, insight.lastEvidence, insight.lastSeenAt);
  const row = await tx.insightOutcome.create({
    data: {
      insightId: w.insightId,
      storeId: insight.storeId,
      detector: insight.detector,
      subject: insight.subject,
      trigger: w.trigger,
      actedAt: w.at,
      actedByUserId: w.userId,
      internal: isInternal(user?.email, INTERNAL),
      baseline: baseline as unknown as Prisma.InputJsonValue,
      baselineSource: source,
    },
    select: { id: true },
  });
  return row.id;
}

/** Close the insight's open watches with no result (dismissed as wrong, pack §4). */
export async function closeWatches(tx: Prisma.TransactionClient, insightId: string, at: Date, reason: "dismissed_wrong" | "store_disconnected") {
  await tx.insightOutcome.updateMany({
    where: { insightId, closedAt: null },
    data: { closedAt: at, closedReason: reason, verdict: "closed" },
  });
}
