import { withoutMoney, type Insight } from "../insights/detectors";
import { needsAction, summaryOf } from "../insights/summary";

/**
 * Push notifications' rules (pre-Wave-1 pack 4, decided 2026-10-28), apart
 * from the database and the push service so they can be tested.
 *
 * What sends, in this order when more qualify than the day allows:
 * 1. a courier payout later than its usual cycle (the cash-held finding), when it first appears;
 * 2. the store's top "Needs your attention" row, once per member and finding;
 * 3. on Mondays from 09:00, Books drafts waiting, for members who can approve them;
 * 4. on Mondays, once that member's weekly digest went out: "it's in your inbox".
 *
 * A finding goes again only after it resolves and comes back. Every push is
 * worded as the card it opens, and money only reaches a member with
 * `finance:view` (D-57).
 */

export type PushSending = "on" | "internal" | "off";
export type PushKind = "cash_held" | "top_finding" | "books" | "digest";
export type PushMode = "live" | "dry_run";

/** At most this many a member's day; tests are not counted. */
export const DAILY_CAP = 2;
/** Nothing between 22:00 and 08:00 in the member's timezone: what is due then waits for morning. */
export const QUIET_FROM = 22;
export const QUIET_UNTIL = 8;
/** Books' nudge and the digest's: Mondays from 09:00, as the digest (week.ts). */
export const WEEKLY_WEEKDAY = 1;
export const WEEKLY_HOUR = 9;

/** Is this member's push real, or a dry run? */
export function modeFor(sending: PushSending, internal: boolean): PushMode {
  return sending === "on" || (sending === "internal" && internal) ? "live" : "dry_run";
}

/** Settings' switch: only with the keys in place, and only to internal accounts until sending is on for all. */
export function switchVisible(sending: PushSending, internal: boolean, configured: boolean): boolean {
  return configured && (sending === "on" || internal);
}

/** Outside the quiet hours, at this local hour? */
export const inSendingHours = (hour: number) => hour >= QUIET_UNTIL && hour < QUIET_FROM;

export const isWeeklyTime = (local: { weekday: number; hour: number }) => local.weekday === WEEKLY_WEEKDAY && local.hour >= WEEKLY_HOUR;

export type Push = { title: string; body: string; url: string };

/** Lower goes first (the order at the top of this file). */
export const PRIORITY: Record<PushKind, number> = { cash_held: 1, top_finding: 2, books: 3, digest: 4 };

export type Candidate = Push & {
  kind: PushKind;
  priority: number;
  dedupeKey: string;
  storeId: string | null;
  insightId: string | null;
};

/** The ones that go now: by priority, up to what is left of the day's cap. */
export function pickForNow(candidates: readonly Candidate[], sentToday: number): Candidate[] {
  const room = Math.max(0, DAILY_CAP - sentToday);
  return [...candidates].sort((a, b) => a.priority - b.priority).slice(0, room);
}

/** What a push service's answer means for the subscription: 404 and 410 mean the browser dropped it. */
export function subscriptionOutcome(statusCode: number | undefined): "delivered" | "gone" | "failed" {
  if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) return "delivered";
  if (statusCode === 404 || statusCode === 410) return "gone";
  return "failed";
}

// ── Keys: what stops a second push of the same thing ─────────────────────────

/** Once per appearance, whichever way it went (cash held or top row): a finding that resolves and comes back has a new `appearedAt`. */
export const findingKey = (memberId: string, insightId: string, appearedAt: Date, mode: PushMode) =>
  `${memberId}:finding:${insightId}:${appearedAt.toISOString()}:${mode}`;

export const weeklyKey = (memberId: string, kind: "books" | "digest", week: string, mode: PushMode) => `${memberId}:${kind}:${week}:${mode}`;

// ── Wording ──────────────────────────────────────────────────────────────────

/** Push services cap a payload at about 4 KB; a notification shows far less. */
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * A finding as Home's row words it (and the digest): the headline, then the
 * figure and the line under it. A member with more than one store is told
 * which. The click goes through the tracked route, tagged `from=push`.
 */
export function findingPush(insightId: string, insight: Insight, period: string, storeName: string | null): Push {
  const s = summaryOf(insight.finding, period);
  const line = s.next ?? s.why ?? s.note;
  const to = s.link?.to ?? `/insights?${period}`;
  return {
    title: clip(s.headline, 120),
    body: clip([storeName ? `${storeName} · ${s.figure}` : s.figure, line].filter(Boolean).join("\n"), 240),
    url: `/insights/${insightId}/open?to=${encodeURIComponent(to)}&from=push`,
  };
}

/** Home's Books row (B7), word for word. */
export function booksPush(drafts: number): Push {
  return {
    title: `${drafts.toLocaleString("en-GB")} ${drafts === 1 ? "entry is" : "entries are"} waiting for approval in Books`,
    body: "Drafts aren't in your books until someone approves them.",
    url: "/books/drafts?from=push",
  };
}

/** The digest's own subject line, and where it is. */
export function digestPush(subject: string): Push {
  return { title: clip(subject, 120), body: "Your weekly digest is in your inbox.", url: "/home?from=push" };
}

// ── A store's findings, for one member ──────────────────────────────────────

export type StoreFindings = {
  storeId: string;
  /** Shown only to a member with more than one store. */
  storeName: string | null;
  /** The findings this member would see on Home now, ranked, none dismissed or snoozed. */
  visible: ReadonlyArray<{ id: string; insight: Insight }>;
  /** When each finding last appeared: first seen, or its latest reappearance. */
  appearedAt: ReadonlyMap<string, Date>;
  /** Home's period, for the links. */
  period: string;
};

/**
 * The cash-held findings this member hasn't been pushed (priority 1), and the
 * store's top row if it is new to them (priority 2). Money goes before
 * anything is worded, unless the member may see it.
 */
export function findingCandidates(
  s: StoreFindings,
  member: { memberId: string; canSeeMoney: boolean },
  mode: PushMode,
  alreadySent: (dedupeKey: string) => boolean,
  topDone = false,
): Candidate[] {
  // As Home does it: a money finding loses its figures, or goes when it is nothing but money (cash held).
  const items = member.canSeeMoney ? [...s.visible] : s.visible.flatMap((v) => withoutMoney([v.insight]).map((insight) => ({ id: v.id, insight })));
  const fresh = (v: { id: string }) => {
    const at = s.appearedAt.get(v.id);
    if (!at) return null;
    const key = findingKey(member.memberId, v.id, at, mode);
    return alreadySent(key) ? null : key;
  };
  const candidate = (v: { id: string; insight: Insight }, kind: "cash_held" | "top_finding", key: string): Candidate => ({
    ...findingPush(v.id, v.insight, s.period, s.storeName),
    kind,
    priority: PRIORITY[kind],
    dedupeKey: key,
    storeId: s.storeId,
    insightId: v.id,
  });

  const out: Candidate[] = [];
  for (const v of items) {
    if (v.insight.detector !== "cash_held") continue;
    const key = fresh(v);
    if (key) out.push(candidate(v, "cash_held", key));
  }
  // At most one a day per store: the caller passes topDone once today's has gone.
  const top = needsAction(items)[0];
  if (!topDone && top && top.insight.detector !== "cash_held") {
    const key = fresh(top);
    if (key) out.push(candidate(top, "top_finding", key));
  }
  return out;
}
