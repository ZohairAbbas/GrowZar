import { readMoney, sumByCurrency, type Money } from "./money";

/**
 * The Inbox section (Phase 5, G-GZR5-13), from WhatKaBot's conversations and
 * messages. Metadata only (D-55): no message text ever reaches Growzar, so
 * the section shows what conversations are about, who answered and how fast,
 * and sends the merchant to WhatKaBot to read and reply.
 */

export type Conversation = {
  id: string;
  channel: string;
  phone: string | null;
  status: string;
  owner: "ai" | "agent" | null;
  category: string | null;
  subcategory: string | null;
  createdAt: Date;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  firstResponseAt: Date | null;
  slaDueAt: Date | null;
  escalated: boolean;
  inbound: number;
  outboundAi: number;
  outboundAgent: number;
  aiCost: Money | null;
  csat: number | null;
  orders: number;
};

export type MessageMeta = { direction: "inbound" | "outbound"; author: string; createdAt: Date; deliveryStatus: string | null; errorCode: string | null };

const CLOSED = new Set(["resolved", "closed"]);
/** Conversations listed as waiting, longest first. */
export const WAITING_SHOWN = 25;
/**
 * A buyer counts as waiting only if they wrote within this many days. Some
 * stores never close conversations (zainvault: all 1,712 open), so an
 * unanswered message from August would otherwise sit at the top for ever.
 */
export const WAITING_DAYS = 7;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function parseConversation(p: unknown): Conversation | null {
  const r = obj(p);
  const id = str(r.id);
  const createdAt = date(r.createdAt);
  if (!id || !createdAt) return null;
  const m = obj(r.messages);
  const a = obj(r.assignee);
  const csat = typeof r.csat === "number" ? r.csat : null;
  return {
    id,
    channel: str(r.channel) ?? "unknown",
    phone: str(obj(r.customer).phone),
    status: str(r.status) ?? "unknown",
    owner: a.type === "ai" ? "ai" : a.type === "agent" ? "agent" : null,
    category: str(r.category),
    subcategory: str(r.subcategory),
    createdAt,
    lastInboundAt: date(r.lastInboundAt),
    lastOutboundAt: date(r.lastOutboundAt),
    firstResponseAt: date(r.firstResponseAt),
    slaDueAt: date(r.slaDueAt),
    escalated: r.escalated === true,
    inbound: num(m.inbound),
    outboundAi: num(m.outboundAi),
    outboundAgent: num(m.outboundAgent),
    aiCost: readMoney(r.aiCost),
    csat,
    orders: Array.isArray(r.orders) ? r.orders.length : 0,
  };
}

export function parseMessageMeta(p: unknown): MessageMeta | null {
  const r = obj(p);
  const createdAt = date(r.createdAt);
  const direction = r.direction === "inbound" || r.direction === "outbound" ? r.direction : null;
  if (!createdAt || !direction) return null;
  return { direction, author: str(r.author) ?? "unknown", createdAt, deliveryStatus: str(r.deliveryStatus), errorCode: str(r.errorCode) };
}

/** Waiting for the store: the buyer wrote last, and it isn't closed. */
export const isWaiting = (c: Conversation) =>
  !CLOSED.has(c.status) && c.lastInboundAt !== null && (c.lastOutboundAt === null || c.lastInboundAt > c.lastOutboundAt);

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

export type ConversationsView = {
  opened: number;
  byChannel: Array<{ channel: string; conversations: number }>;
  /** Of the period's conversations: answered only by AI, with a person involved, and never answered. */
  aiOnly: number;
  withAgent: number;
  unanswered: number;
  escalated: number;
  /** Minutes from opening to the first AI or agent reply, median, over those answered. */
  medianFirstResponseMinutes: number | null;
  csat: { average: number | null; rated: number };
  aiCost: Money[];
  categories: Array<{ category: string; conversations: number; share: number; topSubcategory: string | null; escalated: number; medianFirstResponseMinutes: number | null; withOrder: number }>;
  /** Now, whatever the period. */
  /** Now, whatever the period. `quiet`: the buyer wrote last, but more than WAITING_DAYS ago. */
  now: { open: number; waiting: number; quiet: number; pendingAgent: number; overdue: number };
  waitingList: Array<{ id: string; channel: string; phoneTail: string | null; category: string | null; subcategory: string | null; status: string; owner: "ai" | "agent" | null; waitingMinutes: number; overdue: boolean; orders: number }>;
  messages: { inbound: number; outboundByAuthor: Array<{ author: string; messages: number }>; failed: number; failedByCode: Array<{ code: string; messages: number }> };
};

export function conversationsView(input: {
  inPeriod: readonly Conversation[];
  open: readonly Conversation[];
  messages: readonly MessageMeta[];
  now: Date;
}): ConversationsView {
  const c = input.inPeriod;
  const firstResponse = (x: Conversation) => (x.firstResponseAt && x.firstResponseAt >= x.createdAt ? minutesBetween(x.createdAt, x.firstResponseAt) : null);
  const frs = (xs: readonly Conversation[]) => xs.map(firstResponse).filter((m): m is number => m !== null);
  const round = (m: number | null) => (m === null ? null : Math.round(m * 10) / 10);

  const channels = new Map<string, number>();
  for (const x of c) channels.set(x.channel, (channels.get(x.channel) ?? 0) + 1);

  const cats = new Map<string, Conversation[]>();
  for (const x of c) {
    const k = x.category ?? "uncategorised";
    cats.set(k, [...(cats.get(k) ?? []), x]);
  }
  const top = (xs: Conversation[]) => {
    const m = new Map<string, number>();
    for (const x of xs) if (x.subcategory) m.set(x.subcategory, (m.get(x.subcategory) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };

  const rated = c.filter((x) => x.csat !== null);
  const recent = input.now.getTime() - WAITING_DAYS * 86_400_000;
  const unanswered = input.open.filter(isWaiting);
  const waiting = unanswered.filter((x) => x.lastInboundAt!.getTime() >= recent);
  const overdue = (x: Conversation) => !CLOSED.has(x.status) && x.slaDueAt !== null && x.slaDueAt < input.now;

  const out = new Map<string, number>();
  const codes = new Map<string, number>();
  let inbound = 0;
  let failed = 0;
  for (const m of input.messages) {
    if (m.direction === "inbound") inbound += 1;
    else out.set(m.author, (out.get(m.author) ?? 0) + 1);
    if (m.deliveryStatus === "failed") {
      failed += 1;
      const code = m.errorCode ?? "unreported";
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  }

  return {
    opened: c.length,
    byChannel: [...channels.entries()].map(([channel, conversations]) => ({ channel, conversations })).sort((a, b) => b.conversations - a.conversations),
    aiOnly: c.filter((x) => x.outboundAgent === 0 && x.outboundAi > 0).length,
    withAgent: c.filter((x) => x.outboundAgent > 0).length,
    unanswered: c.filter((x) => x.inbound > 0 && x.outboundAgent + x.outboundAi === 0).length,
    escalated: c.filter((x) => x.escalated).length,
    medianFirstResponseMinutes: round(median(frs(c))),
    csat: { average: rated.length ? Math.round((10 * rated.reduce((s, x) => s + x.csat!, 0)) / rated.length) / 10 : null, rated: rated.length },
    aiCost: sumByCurrency(c.map((x) => x.aiCost)),
    categories: [...cats.entries()]
      .map(([category, xs]) => ({
        category,
        conversations: xs.length,
        share: Math.round((1000 * xs.length) / c.length) / 10,
        topSubcategory: top(xs),
        escalated: xs.filter((x) => x.escalated).length,
        medianFirstResponseMinutes: round(median(frs(xs))),
        withOrder: xs.filter((x) => x.orders > 0).length,
      }))
      .sort((a, b) => b.conversations - a.conversations),
    now: {
      open: input.open.filter((x) => !CLOSED.has(x.status)).length,
      waiting: waiting.length,
      quiet: unanswered.length - waiting.length,
      pendingAgent: input.open.filter((x) => x.status === "pending_agent").length,
      overdue: input.open.filter(overdue).length,
    },
    waitingList: waiting
      .map((x) => ({
        id: x.id,
        channel: x.channel,
        phoneTail: x.phone ? x.phone.replace(/\D/g, "").slice(-4) : null,
        category: x.category,
        subcategory: x.subcategory,
        status: x.status,
        owner: x.owner,
        waitingMinutes: Math.round(minutesBetween(x.lastInboundAt!, input.now)),
        overdue: overdue(x),
        orders: x.orders,
      }))
      .sort((a, b) => b.waitingMinutes - a.waitingMinutes)
      .slice(0, WAITING_SHOWN),
    messages: {
      inbound,
      outboundByAuthor: [...out.entries()].map(([author, messages]) => ({ author, messages })).sort((a, b) => b.messages - a.messages),
      failed,
      failedByCode: [...codes.entries()].map(([code, messages]) => ({ code, messages })).sort((a, b) => b.messages - a.messages).slice(0, 5),
    },
  };
}
