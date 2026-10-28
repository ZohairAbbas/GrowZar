import { randomUUID } from "node:crypto";

import { prisma } from "../db.server";
import { env } from "../env.server";
import { roleChecker } from "../role-check.server";
import { digestRecipients, storeIsStale, DIGEST_DAYS, type Recipient } from "../digest/digest.server";
import { digestSubject } from "../digest/render";
import { localParts, weekOf } from "../digest/week";
import { visibleInsights } from "../insights/inbox.server";
import { periodFrom } from "../metrics/screens.server";
import { storeSummary } from "../metrics/summaries.server";
import { booksOn } from "../books-app/switch.server";
import { countDrafts, getBook } from "../books/books.server";
import { internalEmails, isInternal } from "../outcomes/watch";
import { deliver, type Vapid } from "./deliver.server";
import {
  booksPush,
  DAILY_CAP,
  digestPush,
  findingCandidates,
  inSendingHours,
  isWeeklyTime,
  modeFor,
  pickForNow,
  PRIORITY,
  switchVisible,
  weeklyKey,
  type Candidate,
  type Push,
  type PushMode,
  type StoreFindings,
} from "./rules";

/**
 * Push notifications from the installed app (pre-Wave-1 pack 4). The rules
 * are in rules.ts; this is the database and the push service around them.
 *
 * The worker calls runDuePushes every ten minutes. Only members with a
 * subscription are looked at, and a store's findings are built only when one
 * of them could still be pushed something. Every push is logged in
 * push_sends before it goes, and its dedupe key is what stops a second.
 */

const INTERNAL = internalEmails(env.INTERNAL_EMAILS);
/** A failed push is tried again on later runs, up to this many attempts. */
export const MAX_ATTEMPTS = 3;
/** What counts toward the daily cap: the ones that went, or would have. */
const COUNTED = ["sending", "sent", "dry_run"];

export function vapid(): Vapid | null {
  const { PUSH_VAPID_PUBLIC: publicKey, PUSH_VAPID_PRIVATE: privateKey, PUSH_SUBJECT: subject } = env;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export const pushIsInternal = (email: string | null | undefined) => isInternal(email, INTERNAL);

/** What Settings shows a member: the switch or nothing, and whether their pushes are real. */
export function pushSettingFor(email: string) {
  const keys = vapid();
  const internal = pushIsInternal(email);
  return {
    visible: switchVisible(env.PUSH_SENDING, internal, keys !== null),
    publicKey: keys?.publicKey ?? null,
    live: modeFor(env.PUSH_SENDING, internal) === "live",
  };
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export type BrowserSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/** A PushSubscription's JSON, as the browser hands it over; null when it isn't one. */
export function parseSubscription(raw: string): BrowserSubscription | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof v?.endpoint !== "string" || typeof v.keys?.p256dh !== "string" || typeof v.keys?.auth !== "string") return null;
  let url: URL;
  try {
    url = new URL(v.endpoint);
  } catch {
    return null;
  }
  // Push services are https; anything else would have the worker post to an address a page chose.
  if (url.protocol !== "https:" || v.endpoint.length > 2000 || v.keys.p256dh.length > 200 || v.keys.auth.length > 100) return null;
  return { endpoint: v.endpoint, keys: { p256dh: v.keys.p256dh, auth: v.keys.auth } };
}

/** The device is this member's now, whoever had it before (one browser, one endpoint). */
export async function saveSubscription(memberId: string, sub: BrowserSubscription, userAgent: string | null, replaces?: string | null) {
  const data = { memberId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null };
  await prisma.pushSubscription.upsert({ where: { endpoint: sub.endpoint }, create: { endpoint: sub.endpoint, ...data }, update: { ...data, failures: 0 } });
  if (replaces && replaces !== sub.endpoint) await prisma.pushSubscription.deleteMany({ where: { memberId, endpoint: replaces } });
}

export async function removeSubscription(memberId: string, endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { memberId, endpoint } });
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** To every device the member has. A device the push service says is gone is deleted. */
export async function sendToMember(memberId: string, payload: Push & { id: string; tag: string }) {
  const keys = vapid();
  const devices = await prisma.pushSubscription.findMany({ where: { memberId } });
  if (!keys || !devices.length) return { delivered: 0, devices: 0, error: keys ? "no_subscription" : "no_keys" };
  let delivered = 0;
  const errors: string[] = [];
  for (const d of devices) {
    const r = await deliver(d, payload, keys);
    if (r.outcome === "delivered") {
      delivered += 1;
      await prisma.pushSubscription.update({ where: { id: d.id }, data: { lastSuccessAt: new Date(), failures: 0 } });
    } else if (r.outcome === "gone") {
      await prisma.pushSubscription.delete({ where: { id: d.id } }).catch(() => null);
      errors.push(`gone: ${r.error ?? r.status}`);
    } else {
      await prisma.pushSubscription.update({ where: { id: d.id }, data: { failures: { increment: 1 } } });
      errors.push(r.error ?? "failed");
    }
  }
  return { delivered, devices: devices.length, error: errors.length ? errors.join("; ").slice(0, 500) : null };
}

type Row = { organizationId: string; memberId: string; userId: string; day: string; mode: PushMode };

/** Log, then send (or not, for a dry run). A worker killed mid-send leaves "sending", which is never tried again. */
async function push(row: Row, c: Candidate, logged: { attempts: number } | null) {
  const data = { kind: c.kind, storeId: c.storeId, insightId: c.insightId, title: c.title, body: c.body, url: c.url, attempts: (logged?.attempts ?? 0) + 1 };
  const status = row.mode === "live" ? "sending" : "dry_run";
  const saved = logged
    ? await prisma.pushSend.update({ where: { dedupeKey: c.dedupeKey }, data: { ...data, day: row.day, status, error: null } })
    : await prisma.pushSend.create({ data: { ...row, ...data, dedupeKey: c.dedupeKey, status } });
  if (row.mode !== "live") return "dry_run" as const;

  const r = await sendToMember(row.memberId, { title: c.title, body: c.body, url: c.url, id: saved.id, tag: c.insightId ?? c.kind });
  const outcome = r.delivered ? "sent" : r.error === "no_subscription" ? "no_subscription" : "failed";
  await prisma.pushSend.update({
    where: { id: saved.id },
    data: { status: outcome, delivered: r.delivered, error: r.error, sentAt: r.delivered ? new Date() : null },
  });
  return outcome;
}

/** "Send a test": to the member's own devices now, whatever PUSH_SENDING says (as the digest's test). Not counted. */
export async function sendTestPush(viewer: { organizationId: string; memberId: string; userId: string }, timezone: string) {
  const now = new Date();
  const c = { title: "Notifications are on", body: "This is how Growzar will tell you when something needs you.", url: "/settings?from=push" };
  const saved = await prisma.pushSend.create({
    data: {
      organizationId: viewer.organizationId,
      memberId: viewer.memberId,
      userId: viewer.userId,
      kind: "test",
      mode: "test",
      day: localParts(now, timezone).date,
      dedupeKey: `test:${randomUUID()}`,
      status: "sending",
      attempts: 1,
      ...c,
    },
  });
  const r = await sendToMember(viewer.memberId, { ...c, id: saved.id, tag: "test" });
  const status = r.delivered ? "sent" : r.error === "no_subscription" ? "no_subscription" : "failed";
  await prisma.pushSend.update({ where: { id: saved.id }, data: { status, delivered: r.delivered, error: r.error, sentAt: r.delivered ? now : null } });
  return { status, delivered: r.delivered, devices: r.devices };
}

/** The service worker reports a click. Only the member it went to can mark it; the first click counts. */
export async function recordPushClick(sendId: string, userId: string) {
  await prisma.pushSend.updateMany({ where: { id: sendId, userId, clickedAt: null }, data: { clickedAt: new Date() } });
}

// ── The run (worker) ─────────────────────────────────────────────────────────

/**
 * What this process has already looked at today, so a store's findings are
 * not rebuilt every ten minutes: `day:member:store` once the day's top row was
 * checked, and `day:member:insight:appeared` for each cash-held row seen.
 * Lost on a restart, which costs one rebuild; the send log still stops repeats.
 */
const looked = new Set<string>();
let lookedDay = "";

export type PushRunResult = { sent: number; dryRun: number; failed: number };

export async function runDuePushes(now = new Date()): Promise<PushRunResult> {
  const result: PushRunResult = { sent: 0, dryRun: 0, failed: 0 };
  if (!vapid()) return result;
  const utcDay = now.toISOString().slice(0, 10);
  if (utcDay !== lookedDay && now.getUTCHours() === 12) {
    // Midday UTC is no store's local midnight in Pakistan, India or the Gulf; it clears yesterday's keys.
    looked.clear();
    lookedDay = utcDay;
  }

  const subscribed = await prisma.pushSubscription.findMany({ distinct: ["memberId"], select: { memberId: true, member: { select: { organizationId: true } } } });
  const byOrg = new Map<string, Set<string>>();
  for (const s of subscribed) byOrg.set(s.member.organizationId, (byOrg.get(s.member.organizationId) ?? new Set()).add(s.memberId));

  for (const [organizationId, memberIds] of byOrg) {
    const recipients = (await digestRecipients(organizationId)).filter((r) => memberIds.has(r.memberId));
    const can = await roleChecker(organizationId);
    const views = new Map<string, Promise<StoreView | null>>();
    const org = { id: organizationId, books: null as Promise<number> | null };
    for (const r of recipients) {
      try {
        const counts = await runMember(r, org, can, views, now);
        result.sent += counts.sent;
        result.dryRun += counts.dryRun;
        result.failed += counts.failed;
      } catch (error) {
        console.error(`[push] member=${r.memberId} failed`, error);
        result.failed += 1;
      }
    }
  }
  return result;
}

type StoreView = { visible: StoreFindings["visible"]; appearedAt: Map<string, Date>; period: string };

/** Home's findings for a store at one level of money access, as Home builds them; null when the store's data is stale. */
async function storeView(store: Recipient["stores"][number], canSeeMoney: boolean, now: Date): Promise<StoreView | null> {
  if (await storeIsStale(store.id, now)) return null;
  const period = periodFrom(new URL(`http://push/?days=${DIGEST_DAYS}`), store.timezone, now);
  const { visible, row } = await visibleInsights(await storeSummary(store.id, period.from, period.to), canSeeMoney, now);
  const items = visible.map((insight) => ({ id: row.get(insight.fingerprint)!.id, insight }));
  return { visible: items, appearedAt: await appearances(items.map((i) => i.id)), period: period.query };
}

/** When each insight last appeared: its latest reappearance, else when it was first seen. */
async function appearances(insightIds: string[]): Promise<Map<string, Date>> {
  if (!insightIds.length) return new Map();
  const [rows, back] = await Promise.all([
    prisma.insight.findMany({ where: { id: { in: insightIds } }, select: { id: true, firstSeenAt: true } }),
    prisma.insightEvent.groupBy({ by: ["insightId"], where: { insightId: { in: insightIds }, kind: "reappeared" }, _max: { at: true } }),
  ]);
  const latest = new Map(back.map((b) => [b.insightId, b._max.at]));
  return new Map(rows.map((r) => [r.id, latest.get(r.id) ?? r.firstSeenAt]));
}

async function runMember(
  r: Recipient,
  org: { id: string; books: Promise<number> | null },
  can: Awaited<ReturnType<typeof roleChecker>>,
  views: Map<string, Promise<StoreView | null>>,
  now: Date,
): Promise<PushRunResult> {
  const counts: PushRunResult = { sent: 0, dryRun: 0, failed: 0 };
  if (!r.canHome || !r.stores.length) return counts;
  const local = localParts(now, r.timezone);
  if (!inSendingHours(local.hour)) return counts;
  const mode = modeFor(env.PUSH_SENDING, pushIsInternal(r.email));

  const logged = await prisma.pushSend.findMany({
    where: { memberId: r.memberId, mode },
    select: { dedupeKey: true, status: true, attempts: true, day: true, kind: true, storeId: true },
  });
  const byKey = new Map(logged.map((l) => [l.dedupeKey, l]));
  const today = logged.filter((l) => l.day === local.date && COUNTED.includes(l.status));
  if (today.length >= DAILY_CAP) return counts;
  const alreadySent = (key: string) => {
    const l = byKey.get(key);
    return !!l && !(l.status === "failed" && l.attempts < MAX_ATTEMPTS);
  };

  const candidates: Candidate[] = [];
  const multi = r.stores.length > 1;
  for (const store of r.stores) {
    const topKey = `${local.date}:${r.memberId}:${store.id}`;
    const topDone = today.some((l) => l.kind === "top_finding" && l.storeId === store.id);
    // A cash-held row the evaluation found that this member hasn't been pushed, and this process hasn't looked at today.
    const cash = await prisma.insight.findMany({ where: { storeId: store.id, detector: "cash_held", resolvedAt: null }, select: { id: true } });
    const cashAt = await appearances(cash.map((c) => c.id));
    const cashKeys = [...cashAt].map(([id, at]) => `${local.date}:${r.memberId}:${id}:${at.toISOString()}`);
    const newCash = cashKeys.filter((k) => !looked.has(k));
    if ((topDone || looked.has(topKey)) && !newCash.length) continue;

    const key = `${store.id}:${r.canSeeMoney}`;
    if (!views.has(key)) views.set(key, storeView(store, r.canSeeMoney, now));
    const view = await views.get(key)!;
    looked.add(topKey);
    for (const k of cashKeys) looked.add(k);
    if (!view) continue;
    candidates.push(
      ...findingCandidates(
        { storeId: store.id, storeName: multi ? (store.displayName ?? store.shopDomain) : null, ...view },
        { memberId: r.memberId, canSeeMoney: r.canSeeMoney },
        mode,
        alreadySent,
        topDone,
      ),
    );
  }

  if (isWeeklyTime(local)) {
    const week = weekOf(now, r.timezone);
    const booksKey = weeklyKey(r.memberId, "books", week, mode);
    if (!alreadySent(booksKey) && r.allStores && can(r.role, "books", "manage")) {
      org.books ??= booksDrafts(org.id);
      const drafts = await org.books;
      if (drafts > 0) candidates.push({ ...booksPush(drafts), kind: "books", priority: PRIORITY.books, dedupeKey: booksKey, storeId: null, insightId: null });
    }
    const digestKey = weeklyKey(r.memberId, "digest", week, mode);
    if (!alreadySent(digestKey)) {
      const subject = await digestWentOut(r.memberId, week, mode);
      if (subject) candidates.push({ ...digestPush(subject), kind: "digest", priority: PRIORITY.digest, dedupeKey: digestKey, storeId: null, insightId: null });
    }
  }

  const row = { organizationId: org.id, memberId: r.memberId, userId: r.userId, day: local.date, mode };
  for (const c of pickForNow(candidates, today.length)) {
    const outcome = await push(row, c, byKey.get(c.dedupeKey) ?? null);
    if (outcome === "sent") counts.sent += 1;
    else if (outcome === "dry_run") counts.dryRun += 1;
    else counts.failed += 1;
  }
  return counts;
}

/** Books' drafts waiting, when the organization has Books on and a book. */
async function booksDrafts(organizationId: string): Promise<number> {
  if (!(await booksOn(organizationId))) return 0;
  const book = await getBook(organizationId);
  return book ? countDrafts(book) : 0;
}

/**
 * The digest's subject, once this member's digest for the week went out; null
 * before. A live push needs a sent email; a dry run also follows a dry-run digest.
 */
async function digestWentOut(memberId: string, week: string, mode: PushMode): Promise<string | null> {
  const sends = await prisma.digestSend.findMany({
    where: { memberId, week, mode: { in: mode === "live" ? ["live"] : ["live", "dry_run"] }, status: { in: mode === "live" ? ["sent"] : ["sent", "dry_run"] } },
    select: { content: true },
    take: 1,
  });
  if (!sends.length) return null;
  const stores = (sends[0]!.content as Array<{ name: string; skipped: string | null; items: unknown[] }>).filter((s) => s.skipped === null);
  return digestSubject({ stores: stores.map((s) => ({ name: s.name, rows: s.items as never[], app: null, results: [] })) });
}
