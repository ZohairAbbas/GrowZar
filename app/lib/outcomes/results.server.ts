import { prisma } from "../db.server";
import { env } from "../env.server";
import { outcomeLine, type OutcomeLine, type WatchRow } from "./line";
import { internalEmails, isInternal, PLACEBO } from "./watch";

/**
 * The outcome lines a viewer may see (G-GZR9-5): never a placebo, and an
 * internal account's watch only to an internal viewer (pack §10.1, §13).
 */

const INTERNAL = internalEmails(env.INTERNAL_EMAILS);

export const WATCH_SELECT = {
  id: true, insightId: true, storeId: true, detector: true, subject: true, trigger: true, actedAt: true, internal: true,
  baseline: true, effect: true, verdict: true, observed: true, checkpoints: true, judgedAt: true, closedAt: true, closedReason: true, hiddenAt: true,
} as const;

export async function viewerIsInternal(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return isInternal(u?.email, INTERNAL);
}

export type Viewer = { userId: string; canSeeMoney: boolean; internal?: boolean };

/** Every real watch of these stores a viewer may see, newest first, as sentences. */
export async function outcomeLinesOf(
  storeIds: readonly string[],
  viewer: Viewer,
  where: { insightIds?: readonly string[]; judgedSince?: Date } = {},
): Promise<Array<OutcomeLine & { storeId: string; actedAt: string }>> {
  if (!storeIds.length) return [];
  const internal = viewer.internal ?? (await viewerIsInternal(viewer.userId));
  const [stores, rows] = await Promise.all([
    prisma.store.findMany({ where: { id: { in: [...storeIds] } }, select: { id: true, timezone: true, currency: true } }),
    prisma.insightOutcome.findMany({
      where: {
        storeId: { in: [...storeIds] },
        trigger: { not: PLACEBO },
        ...(internal ? {} : { internal: false }),
        ...(where.insightIds ? { insightId: { in: [...where.insightIds] } } : {}),
        ...(where.judgedSince ? { judgedAt: { gte: where.judgedSince } } : {}),
      },
      select: WATCH_SELECT,
      orderBy: { actedAt: "desc" },
    }),
  ]);
  const store = new Map(stores.map((s) => [s.id, s]));
  return rows.flatMap((r) => {
    const s = store.get(r.storeId)!;
    const line = outcomeLine(r as WatchRow, { timezone: s.timezone ?? "UTC", canSeeMoney: viewer.canSeeMoney, currency: s.currency });
    return line ? [{ ...line, storeId: r.storeId, actedAt: r.actedAt.toISOString() }] : [];
  });
}

/** The newest visible line per insight: what a card shows. */
export async function latestLineByInsight(storeId: string, insightIds: readonly string[], viewer: Viewer): Promise<Record<string, OutcomeLine>> {
  if (!insightIds.length) return {};
  const lines = await outcomeLinesOf([storeId], viewer, { insightIds });
  const out: Record<string, OutcomeLine> = {};
  for (const l of lines) if (!out[l.insightId]) out[l.insightId] = l;
  return out;
}
