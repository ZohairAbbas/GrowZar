import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import type { FindingsInput } from "../metrics/findings";
import { inventorySection } from "../metrics/inventory.server";
import { checkoutsSection, formAbandonmentsSection } from "../metrics/checkouts.server";
import { offersSection } from "../metrics/offers.server";
import { sumByCurrency } from "../metrics/money";
import { localDayOf } from "../metrics/order-grain";
import { periodFrom } from "../metrics/screens.server";
import { storeSummary, type StoreSummary } from "../metrics/summaries.server";
import { toRollupOrder } from "../metrics/rollups.server";
import { loadPayerHistories, loadStatements } from "../metrics/settlements.server";
import { loadParcelFacts } from "../metrics/returns.server";
import { loadAdSpend } from "../metrics/rollups.server";
import { loadReturnCost } from "../metrics/return-cost.server";
import {
  detectorLabel,
  evidenceOf,
  rankInsights,
  runDetectors,
  withoutMoney,
  type App,
  type DetectorId,
  type DetectorOutcome,
  type Insight,
} from "./detectors";
import type { InsightAction } from "./actions";

/**
 * The insight inbox (G-GZR3-3): evaluation in the worker, and Home's view.
 *
 * Detectors run live for the period the viewer picked (they read the metric
 * layer and take well under a second), so Home never shows a stale finding.
 * The `insights` table holds what live runs cannot: who dismissed or snoozed
 * what, and, from a fixed 90-day evaluation after each grain rebuild, when a
 * finding stopped firing.
 */

/** The window evaluation judges "resolved" on (PLAN.md §4: I1's 90 days). */
export const EVALUATION_DAYS = 90;
/** Alert fatigue (DECISION-LAYER B4): at most this many cards at once. */
export const MAX_SHOWN = 6;

export async function detectorInput(
  s: StoreSummary,
  now = new Date(),
): Promise<{ input: FindingsInput; connected: Set<App> }> {
  const viaCourierify = s.rows.filter((o) => o.parcelCount > 0).map((o) => o.orderId);
  const [connections, lastParcel, payers, awaiting, perProduct, returnCost, parcels, statements] = await Promise.all([
    prisma.appConnection.findMany({
      where: { storeId: s.store.id, status: "CONNECTED", app: { in: ["COURIERIFY", "FINANCIFY", "INVENTORIFY", "RETAINIFY", "PREVENTIFY"] } },
      select: { app: true },
    }),
    prisma.orderGrain.findFirst({
      where: { storeId: s.store.id, parcelCount: { gt: 0 }, localDay: { not: null } },
      orderBy: { localDay: "desc" },
      select: { localDay: true },
    }),
    // I4 reads today's state, whatever the period: every payer's payouts,
    // and every delivered order whose COD no settlement covers yet.
    loadPayerHistories(s.store.id),
    prisma.orderGrain.findMany({
      where: { storeId: s.store.id, outcome: "delivered", parcelCount: { gt: 0 }, uncollectedAmount: { not: null } },
    }),
    loadAdSpend(s.store.id, s.period.from, s.period.to),
    // What a return costs in courier charges, measured on every returned parcel on record.
    loadReturnCost(s.store.id, s.store.currency),
    // Phase 4c on Home: returns not confirmed back, and statements' deductions.
    loadParcelFacts(s.store.id, viaCourierify),
    loadStatements(s.store.id),
  ]);
  const connected = new Set(connections.map((c) => c.app as App));
  // I3 judges today's stock, whatever the period: "now" in the store's own days.
  const inventory = connected.has("INVENTORIFY")
    ? await inventorySection(s.store.id, { from: s.period.from, to: s.period.to, today: localDayOf(now, s.store.timezone ?? "UTC") }, s.store.currency, Infinity)
    : null;
  const checkouts = connected.has("RETAINIFY") ? await checkoutsSection(s.store.id, s.period, now) : null;
  const formAbandonments = connected.has("PREVENTIFY") ? await formAbandonmentsSection(s.store.id, s.period, now) : null;
  const offers = connected.has("PREVENTIFY") ? await offersSection(s.store.id, s.period) : null;
  const ads = s.adSpend;
  const complete = ads && ads.daysFetched === ads.daysInPeriod;
  return {
    connected,
    input: {
      currency: s.store.currency,
      rows: s.rows,
      orders: s.orders,
      profit: s.profit,
      // The same ad spend the profit subtracted: with platform fees, and only
      // when every day of the period is fetched.
      adSpend: complete ? sumByCurrency([...ads.spend, ...ads.fees]) : null,
      courierify: { connected: connected.has("COURIERIFY"), lastParcelDay: lastParcel?.localDay ?? null },
      cash: { asOf: now, payers, awaiting: awaiting.map(toRollupOrder) },
      asOf: now,
      // I2: per-product allocation, only when the period is fully fetched.
      adByVariant: complete ? Object.fromEntries(perProduct.byVariant) : undefined,
      periodDays: s.adSpend?.daysInPeriod,
      returnCost,
      parcels,
      statements,
      period: s.period,
      inventory,
      checkouts,
      formAbandonments,
      retainifyConnected: connected.has("RETAINIFY"),
      offers,
    },
  };
}

const foundIn = (outcomes: DetectorOutcome[]) =>
  outcomes.flatMap((o) => (o.status === "found" ? o.insights : []));

// ── Evaluation (worker) ──────────────────────────────────────────────────────

export type Evaluation = { found: number; created: number; resolved: number; reappeared: number; ms: number };

/**
 * Run every detector over the last 90 days and record what changed. A
 * finding resolves only when its detector ran and said "nothing found":
 * "not enough data" or "locked" is not knowing, and resolves nothing.
 */
export async function evaluateStore(storeId: string, now = new Date()): Promise<Evaluation> {
  const started = Date.now();
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { timezone: true } });
  const period = periodFrom(new URL(`http://evaluation/?days=${EVALUATION_DAYS}`), store.timezone, now);
  const { input, connected } = await detectorInput(await storeSummary(storeId, period.from, period.to), now);
  const outcomes = runDetectors(input, connected);
  const found = foundIn(outcomes);
  const conclusive = new Set(outcomes.filter((o) => o.status === "found" || o.status === "nothing_found").map((o) => o.detector));

  return prisma.$transaction(async (tx) => {
    const existing = await tx.insight.findMany({ where: { storeId } });
    const byFingerprint = new Map(existing.map((r) => [r.fingerprint, r]));
    let created = 0;
    let resolved = 0;
    let reappeared = 0;

    for (const i of found) {
      const evidence = evidenceOf(i) as Prisma.InputJsonValue;
      const before = byFingerprint.get(i.fingerprint);
      const row = await tx.insight.upsert({
        where: { storeId_fingerprint: { storeId, fingerprint: i.fingerprint } },
        create: { storeId, fingerprint: i.fingerprint, detector: i.detector, subject: i.subject, lastSeenAt: now, lastEvidence: evidence },
        update: { lastSeenAt: now, lastEvidence: evidence, resolvedAt: null },
      });
      if (!before) created += 1;
      else if (before.resolvedAt) {
        reappeared += 1;
        await tx.insightEvent.create({ data: { insightId: row.id, storeId, kind: "reappeared", detail: evidence, at: now } });
      }
    }

    const live = new Set(found.map((i) => i.fingerprint));
    for (const r of existing) {
      if (r.resolvedAt || live.has(r.fingerprint) || !conclusive.has(r.detector as DetectorId)) continue;
      await tx.insight.update({ where: { id: r.id }, data: { resolvedAt: now } });
      await tx.insightEvent.create({
        data: { insightId: r.id, storeId, kind: "resolved", detail: { last: r.lastEvidence } as Prisma.InputJsonValue, at: now },
      });
      resolved += 1;
    }
    return { found: found.length, created, resolved, reappeared, ms: Date.now() - started };
  });
}

// ── Home ─────────────────────────────────────────────────────────────────────

export type InboxItem = { id: string; insight: Insight };

export type InboxView = {
  days: number;
  items: InboxItem[];
  /** Found, but beyond MAX_SHOWN. */
  overflow: number;
  /** Dismissed, or snoozed and not yet due: listed so they can be reopened. */
  hidden: Array<{
    id: string;
    label: string;
    status: "dismissed" | "snoozed";
    reason: string | null;
    snoozedUntil: string | null;
  }>;
  /** Detectors that found nothing, lacked data, or are locked, and why. */
  checked: Array<{ label: string; status: "nothing_found" | "not_enough_data" | "locked"; text: string }>;
  canManage: boolean;
};

const APP_NAMES: Record<App, string> = { COURIERIFY: "Courierify", FINANCIFY: "Financify", INVENTORIFY: "Inventorify", RETAINIFY: "Retainify", PREVENTIFY: "Preventify" };

export async function inboxView(
  s: StoreSummary,
  days: number,
  viewer: { userId: string; canSeeMoney: boolean; canManage: boolean },
  now = new Date(),
): Promise<InboxView> {
  const { input, connected } = await detectorInput(s, now);
  const outcomes = runDetectors(input, connected);
  let insights = rankInsights(foundIn(outcomes));
  // Money leaves the server only for a viewer who may see Finance.
  if (!viewer.canSeeMoney) insights = withoutMoney(insights);

  // A finding gets a row the first time it is shown, so it can be acted on.
  if (insights.length) {
    await prisma.insight.createMany({
      data: insights.map((i) => ({ storeId: s.store.id, fingerprint: i.fingerprint, detector: i.detector, subject: i.subject })),
      skipDuplicates: true,
    });
  }
  const rows = await prisma.insight.findMany({
    where: { storeId: s.store.id, fingerprint: { in: insights.map((i) => i.fingerprint) } },
  });
  const row = new Map(rows.map((r) => [r.fingerprint, r]));
  const hiddenNow = (r: (typeof rows)[number]) =>
    r.status === "dismissed" || (r.status === "snoozed" && r.snoozedUntil !== null && r.snoozedUntil > now);

  const visible = insights.filter((i) => !hiddenNow(row.get(i.fingerprint)!));
  const items = visible.slice(0, MAX_SHOWN).map((i) => ({ id: row.get(i.fingerprint)!.id, insight: i }));

  if (items.length) {
    const day = localDayOf(now, s.store.timezone ?? "UTC");
    await prisma.insightEvent.createMany({
      data: items.map((it) => ({ insightId: it.id, storeId: s.store.id, kind: "shown", userId: viewer.userId, day, periodDays: days })),
      skipDuplicates: true,
    });
  }

  return {
    days,
    items,
    overflow: visible.length - items.length,
    hidden: insights
      .filter((i) => hiddenNow(row.get(i.fingerprint)!))
      .map((i) => {
        const r = row.get(i.fingerprint)!;
        return {
          id: r.id,
          label: detectorLabel(i.detector),
          status: r.status as "dismissed" | "snoozed",
          reason: r.dismissedReason,
          snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
        };
      }),
    checked: outcomes.flatMap((o) =>
      o.status === "found"
        ? []
        : [
            {
              label: detectorLabel(o.detector),
              status: o.status,
              text: o.status === "locked" ? `Connect ${o.needs.map((a) => APP_NAMES[a]).join(" and ")}: ${o.preview}` : o.reason,
            },
          ],
    ),
    canManage: viewer.canManage,
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function applyInsightAction(insightId: string, storeId: string, userId: string, action: InsightAction, now = new Date()) {
  const base = { actedByUserId: userId, actedAt: now };
  const data =
    action.intent === "dismiss"
      ? { ...base, status: "dismissed", dismissedReason: action.reason, dismissedNote: action.note, snoozedUntil: null }
      : action.intent === "snooze"
        ? { ...base, status: "snoozed", snoozedUntil: new Date(now.getTime() + action.days * 86_400_000), dismissedReason: null, dismissedNote: null }
        : { ...base, status: "open", snoozedUntil: null, dismissedReason: null, dismissedNote: null };
  await prisma.$transaction([
    prisma.insight.update({ where: { id: insightId }, data }),
    prisma.insightEvent.create({
      data: {
        insightId,
        storeId,
        kind: action.intent === "dismiss" ? "dismissed" : action.intent === "snooze" ? "snoozed" : "reopened",
        userId,
        detail: action as unknown as Prisma.InputJsonValue,
        at: now,
      },
    }),
  ]);
}

export async function recordClick(insightId: string, storeId: string, userId: string, to: string) {
  await prisma.insightEvent.create({ data: { insightId, storeId, kind: "clicked", userId, detail: { to } } });
}
