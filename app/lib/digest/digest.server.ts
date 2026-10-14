import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { env } from "../env.server";
import { sendEmail } from "../email.server";
import { roleChecker } from "../role-check.server";
import { resolveScopedStoreIds } from "../scope";
import { firstAction, SUITE_APPS } from "../apps/app-links";
import { visibleInsights } from "../insights/inbox.server";
import { ATTENTION_ROWS, needsAction, screensFor, summaryOf } from "../insights/summary";
import { periodFrom } from "../metrics/screens.server";
import { storeSummary } from "../metrics/summaries.server";
import { loadStoreFacts } from "../metrics/next-app.server";
import { nextAppPrompts, type PromptApp } from "../metrics/next-app";
import { renderDigest, type DigestAppLead, type DigestRow } from "./render";
import { unsubscribeUrl } from "./unsubscribe.server";
import { isSendTime, weekLabel, weekOf } from "./week";

/**
 * The weekly digest (G-GZR6-5, D-57): per member, each of their stores' top
 * findings from Home's "Needs your attention", worded as Home words them,
 * and the store's "Next app" lead, with every link through Growzar's tracked
 * routes tagged `from=digest`.
 *
 * Sent only when the organization has turned it on, and only for real when
 * DIGEST_SENDING=on; otherwise each due digest is built and logged as a dry
 * run. One row per member and week in digest_sends (its dedupeKey) is what
 * stops a second send, whatever happens to the worker in between.
 */

/** Home's default period (periodFrom), so the figures match what Home opens on. */
export const DIGEST_DAYS = 30;
/** A store whose apps have not synced for this long is left out rather than reported on old numbers. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
/** A failed send is retried on later checks that Monday, up to this many attempts. */
export const MAX_ATTEMPTS = 3;

const base = () => env.BETTER_AUTH_URL.replace(/\/$/, "");

type StoreRow = { id: string; shopDomain: string; displayName: string | null; currency: string | null; timezone: string | null };

export type BuiltStore = {
  storeId: string;
  name: string;
  /** Why the store is left out of this digest; null when it is in. */
  skipped: "stale" | "nothing" | null;
  rows: Array<{ insightId: string; fingerprint: string; detector: string; row: DigestRow }>;
  app: { app: PromptApp; lead: DigestAppLead } | null;
};

/** One store's part, for one level of money access. Records nothing. */
export async function buildStore(store: StoreRow, canSeeMoney: boolean, now = new Date()): Promise<BuiltStore> {
  const name = store.displayName ?? store.shopDomain;
  const empty = { storeId: store.id, name, rows: [], app: null };
  const synced = await prisma.appConnection.aggregate({ where: { storeId: store.id, status: "CONNECTED" }, _max: { lastSyncedAt: true } });
  const last = synced._max.lastSyncedAt;
  if (!last || now.getTime() - last.getTime() > STALE_AFTER_MS) return { ...empty, skipped: "stale" };

  const period = periodFrom(new URL(`http://digest/?days=${DIGEST_DAYS}`), store.timezone, now);
  const summary = await storeSummary(store.id, period.from, period.to);
  const { items, connected } = await visibleInsights(summary, canSeeMoney, now);

  const rows = needsAction(items)
    .slice(0, ATTENTION_ROWS)
    .map(({ id, insight }) => {
      const s = summaryOf(insight.finding, period.query);
      // Home's row: the headline opens Details when there is no link; here, the Insights page.
      const to = s.link?.to ?? `/insights?${period.query}`;
      const action = firstAction(screensFor(insight.finding), connected);
      return {
        insightId: id,
        fingerprint: insight.fingerprint,
        detector: insight.detector,
        row: {
          headline: s.headline,
          figure: s.figure,
          line: s.next ?? s.why ?? s.note,
          link: { href: `${base()}/insights/${id}/open?to=${encodeURIComponent(to)}&from=digest`, label: s.link?.label ?? "Details" },
          action: action ? { href: `${base()}/insights/${id}/act?screen=${action.screen}&from=digest`, label: action.label } : null,
        },
      };
    });

  const facts = await loadStoreFacts(store.id, store.currency, now);
  const lead = facts ? nextAppPrompts(facts, connected, canSeeMoney)[0] : undefined;
  const app = lead
    ? {
        app: lead.app,
        lead: {
          appName: SUITE_APPS[lead.app].name,
          headline: lead.headline,
          body: lead.body,
          link: { href: `${base()}/stores/${store.id}/apps/${lead.app}/install?lead=1&from=digest`, label: `Install ${SUITE_APPS[lead.app].name}` },
        },
      }
    : null;

  return { storeId: store.id, name, skipped: rows.length || app ? null : "nothing", rows, app };
}

// ── Recipients ───────────────────────────────────────────────────────────────

export type Recipient = {
  memberId: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
  /** Home access: without it a member is not sent the digest at all. */
  canHome: boolean;
  canSeeMoney: boolean;
  optedOut: boolean;
  stores: StoreRow[];
  /** The first store's timezone: when "Monday 09:00" is for this member. */
  timezone: string;
};

export async function digestRecipients(organizationId: string): Promise<Recipient[]> {
  const [can, members, stores] = await Promise.all([
    roleChecker(organizationId),
    prisma.member.findMany({
      where: { organizationId },
      select: {
        id: true,
        userId: true,
        role: true,
        scopeAllStores: true,
        storeScopes: { select: { storeId: true } },
        digestOptOut: { select: { memberId: true } },
        user: { select: { email: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.store.findMany({
      where: { organizationId },
      select: { id: true, shopDomain: true, displayName: true, currency: true, timezone: true },
      orderBy: { shopDomain: "asc" },
    }),
  ]);
  return members.map((m) => {
    const scoped = resolveScopedStoreIds(m.scopeAllStores, m.storeScopes);
    const mine = scoped === null ? stores : stores.filter((s) => scoped.includes(s.id));
    return {
      memberId: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name || null,
      role: m.role,
      canHome: can(m.role, "home", "view"),
      canSeeMoney: can(m.role, "finance", "view"),
      optedOut: m.digestOptOut !== null,
      stores: mine,
      timezone: mine[0]?.timezone ?? "UTC",
    };
  });
}

/** Builds each store once per level of money access, however many members share it. */
export function storeCache(now: Date) {
  const built = new Map<string, Promise<BuiltStore>>();
  return (store: StoreRow, canSeeMoney: boolean) => {
    const key = `${store.id}:${canSeeMoney}`;
    if (!built.has(key)) built.set(key, buildStore(store, canSeeMoney, now));
    return built.get(key)!;
  };
}

export type BuiltDigest = { week: string; stores: BuiltStore[]; subject: string; html: string; text: string; hasContent: boolean };

/** One member's digest, rendered. `onlyStores` narrows it (the preview, for a viewer scoped to fewer stores). */
export async function buildDigest(
  r: Recipient,
  organizationName: string,
  now: Date,
  store = storeCache(now),
  options: { test?: boolean; onlyStores?: string[] | null; unsubscribeMemberId?: string } = {},
): Promise<BuiltDigest> {
  const week = weekOf(now, r.timezone);
  const stores = options.onlyStores ? r.stores.filter((s) => options.onlyStores!.includes(s.id)) : r.stores;
  const built: BuiltStore[] = [];
  // One at a time: the worker's pool is two connections (app/worker/index.ts).
  for (const s of stores) built.push(await store(s, r.canSeeMoney));
  const shown = built.filter((b) => b.skipped === null);
  const { subject, html, text } = renderDigest({
    recipientName: r.name,
    organizationName,
    weekLabel: weekLabel(week),
    stores: shown.map((b) => ({ name: b.name, rows: b.rows.map((x) => x.row), app: b.app?.lead ?? null })),
    homeUrl: `${base()}/home`,
    settingsUrl: `${base()}/settings/digest`,
    // A test goes to the viewer, so its link must unsubscribe the viewer, not the member previewed.
    unsubscribeUrl: unsubscribeUrl(options.unsubscribeMemberId ?? r.memberId),
    test: options.test,
  });
  return { week, stores: built, subject, html, text, hasContent: shown.length > 0 };
}

/** What the log keeps of a digest: per store, what went in as written, or why it was left out. */
const contentOf = (d: BuiltDigest | null): Prisma.InputJsonValue =>
  d
    ? d.stores.map((s) => ({
        storeId: s.storeId,
        name: s.name,
        skipped: s.skipped,
        items: s.rows.map((x) => ({ insightId: x.insightId, fingerprint: x.fingerprint, detector: x.detector, headline: x.row.headline, figure: x.row.figure })),
        app: s.app ? { app: s.app.app, headline: s.app.lead.headline } : null,
      }))
    : [];

const headersFor = (memberId: string) => ({
  "List-Unsubscribe": `<${unsubscribeUrl(memberId)}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});

// ── The Monday run (worker) ──────────────────────────────────────────────────

export type RunResult = { sent: number; dryRun: number; skipped: number; failed: number };

/**
 * Send every digest that is due and not yet logged for its week. Safe to call
 * as often as the worker likes: outside Monday 09:00–24:00 local it does
 * nothing for that member, and a logged week is never sent again.
 */
export async function runDueDigests(now = new Date()): Promise<RunResult> {
  const result: RunResult = { sent: 0, dryRun: 0, skipped: 0, failed: 0 };
  const live = env.DIGEST_SENDING === "on";
  const mode = live ? "live" : "dry_run";
  const orgs = await prisma.digestSettings.findMany({ where: { enabled: true }, select: { organization: { select: { id: true, name: true } } } });

  for (const { organization } of orgs) {
    const store = storeCache(now);
    for (const r of await digestRecipients(organization.id)) {
      if (!r.canHome || !r.stores.length || !isSendTime(now, r.timezone)) continue;
      const week = weekOf(now, r.timezone);
      const dedupeKey = `${r.memberId}:${week}:${mode}`;
      const logged = await prisma.digestSend.findUnique({ where: { dedupeKey }, select: { status: true, attempts: true } });
      if (logged && !(logged.status === "failed" && logged.attempts < MAX_ATTEMPTS)) continue;

      const row = { organizationId: organization.id, memberId: r.memberId, userId: r.userId, email: r.email, mode, week, dedupeKey };
      if (r.optedOut) {
        await logAttempt(row, logged, { status: "opted_out", content: [] });
        result.skipped += 1;
        continue;
      }

      let digest: BuiltDigest;
      try {
        digest = await buildDigest(r, organization.name, now, store);
      } catch (error) {
        console.error(`[digest] could not build member=${r.memberId}`, error);
        await logAttempt(row, logged, { status: "failed", error: `build: ${error instanceof Error ? error.message : "unknown"}`.slice(0, 500), content: [] });
        result.failed += 1;
        continue;
      }
      if (!digest.hasContent) {
        await logAttempt(row, logged, { status: "empty", content: contentOf(digest) });
        result.skipped += 1;
        continue;
      }
      if (!live) {
        await logAttempt(row, logged, { status: "dry_run", content: contentOf(digest) });
        result.dryRun += 1;
        continue;
      }

      // Logged before sending: a worker killed mid-send leaves "sending",
      // which is never retried, so nobody gets the same week twice.
      const pending = await logAttempt(row, logged, { status: "sending", content: contentOf(digest) });
      const sent = await sendEmail({ to: r.email, subject: digest.subject, html: digest.html, text: digest.text, headers: headersFor(r.memberId) });
      await prisma.digestSend.update({
        where: { id: pending.id },
        data: {
          status: sent.sent ? "sent" : sent.reason === "no_api_key" ? "no_api_key" : "failed",
          providerId: sent.sent ? sent.id : null,
          error: sent.sent ? null : (sent.detail ?? sent.reason),
          sentAt: sent.sent ? now : null,
        },
      });
      if (sent.sent) {
        await recordEmailed(pending.id, r.userId, digest);
        result.sent += 1;
      } else result.failed += 1;
    }
  }
  return result;
}

async function logAttempt(
  row: { organizationId: string; memberId: string; userId: string; email: string; mode: string; week: string; dedupeKey: string },
  logged: { attempts: number } | null,
  outcome: { status: string; content: Prisma.InputJsonValue; providerId?: string | null; error?: string | null; sentAt?: Date | null },
) {
  const data = { ...outcome, attempts: (logged?.attempts ?? 0) + 1 };
  return logged
    ? prisma.digestSend.update({ where: { dedupeKey: row.dedupeKey }, data })
    : prisma.digestSend.create({ data: { ...row, ...data } });
}

/**
 * "emailed" beside Home's "shown": the success measure (PLAN.md §9) can then
 * tell a finding seen in the app from one only sent. Clicks from the email
 * arrive through the same routes as Home's, with `from: "digest"`.
 */
async function recordEmailed(sendId: string, userId: string, digest: BuiltDigest) {
  const shown = digest.stores.filter((s) => s.skipped === null);
  await prisma.insightEvent.createMany({
    data: shown.flatMap((s) => s.rows.map((x) => ({ insightId: x.insightId, storeId: s.storeId, kind: "emailed", userId, detail: { sendId } }))),
  });
  await prisma.appPromptEvent.createMany({
    data: shown.flatMap((s) => (s.app ? [{ storeId: s.storeId, app: s.app.app, kind: "emailed", userId, detail: { lead: true, sendId } }] : [])),
  });
}

// ── The preview page ─────────────────────────────────────────────────────────

/**
 * "Send a test to me": `target`'s digest as it stands now, to the viewer's
 * own address, marked as a test, and logged. Nothing is counted as emailed.
 */
export async function sendTestDigest(
  organizationId: string,
  target: Recipient,
  viewer: { userId: string; memberId: string; email: string; scopedStoreIds: string[] | null },
  now = new Date(),
) {
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
  const digest = await buildDigest(target, organization.name, now, storeCache(now), { test: true, onlyStores: viewer.scopedStoreIds, unsubscribeMemberId: viewer.memberId });
  const sent = await sendEmail({ to: viewer.email, subject: digest.subject, html: digest.html, text: digest.text, headers: headersFor(viewer.memberId) });
  await prisma.digestSend.create({
    data: {
      organizationId,
      memberId: target.memberId,
      userId: viewer.userId,
      email: viewer.email,
      mode: "test",
      week: digest.week,
      dedupeKey: `test:${randomUUID()}`,
      status: sent.sent ? "sent" : sent.reason === "no_api_key" ? "no_api_key" : "failed",
      attempts: 1,
      providerId: sent.sent ? sent.id : null,
      error: sent.sent ? null : (sent.detail ?? sent.reason),
      sentAt: sent.sent ? now : null,
      content: contentOf(digest),
    },
  });
  return sent;
}

