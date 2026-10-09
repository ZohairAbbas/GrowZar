import { normalizePhone } from "../customers/phone";
import { sumByCurrency, type Money } from "./money";

/**
 * Marketing messages and what followed them (Phase 5, G-GZR5-5), from
 * Retainify's messages and journeys and Growzar's own orders.
 *
 * Attribution is Growzar's, not Retainify's (decided 2026-10-08): an order
 * follows a message when the same buyer orders within 7 days of clicking it,
 * or otherwise within 1 day of it reaching them. One order counts once, for
 * the latest message that qualifies. Revenue is delivered revenue: a COD order
 * that came back earned nothing.
 */

export const CLICK_WINDOW_MS = 7 * 86_400_000;
export const REACH_WINDOW_MS = 1 * 86_400_000;
/**
 * An order this soon after the same buyer's previous one is the same
 * shopping session (a split or duplicate order), not something a message
 * caused. On 0dscam-qn, post-purchase emails fired by an order were otherwise
 * "followed" by the second order of the same session, minutes later.
 */
export const SAME_SESSION_MS = 60 * 60_000;

export type Channel = "email" | "whatsapp" | "push";

export type MessageRow = {
  id: string;
  channel: Channel;
  journeyId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
  readAt: Date | null;
  clickedAt: Date | null;
  failedAt: Date | null;
  /** The buyer as Growzar knows them, or null when the phone matched no customer. */
  customerId: string | null;
};

export type JourneyRow = {
  id: string;
  name: string;
  kind: "flow" | "campaign";
  /** Retainify's trigger, e.g. `cart_abandoned`, `order_placed`, `broadcast`. */
  trigger?: string | null;
  /** `draft`, `published` or `paused`. */
  status?: string | null;
};

export type FollowedOrder = {
  orderId: string;
  customerId: string;
  placedAt: Date;
  outcome: string;
  delivered: Money | null;
};

const CHANNELS: Channel[] = ["email", "whatsapp", "push"];
const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Retainify's message row, without the buyer (resolved separately). */
export function parseMessage(p: unknown): (Omit<MessageRow, "customerId"> & { phoneE164: string | null; phoneRaw: string | null }) | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const id = str(r.id);
  const channel = str(r.channel) as Channel | null;
  if (!id || !channel || !CHANNELS.includes(channel)) return null;
  const buyer = (r.buyer && typeof r.buyer === "object" ? r.buyer : {}) as Record<string, unknown>;
  return {
    id,
    channel,
    journeyId: str(r.journeyId),
    sentAt: date(r.sentAt),
    deliveredAt: date(r.deliveredAt),
    openedAt: date(r.openedAt),
    readAt: date(r.readAt),
    clickedAt: date(r.clickedAt),
    failedAt: date(r.failedAt),
    phoneE164: str(buyer.phone),
    phoneRaw: str(buyer.phoneRaw),
  };
}

export function parseJourney(p: unknown): JourneyRow | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return { id, name: str(r.name) ?? "Untitled", kind: r.kind === "campaign" ? "campaign" : "flow", trigger: str(r.trigger), status: str(r.status) };
}

/**
 * A buyer's phone as Growzar keys customers (E.164). Retainify sends E.164
 * when it knows the shop's country, and otherwise the digits it stored, which
 * may be local (`03001234567`) or international without the `+`
 * (`923001234567`). Both readings are tried; if both are valid and differ,
 * nothing is guessed.
 */
export function buyerPhone(e164: string | null, raw: string | null, region: string | null): string | null {
  if (e164?.startsWith("+")) return e164;
  if (!raw) return null;
  const local = normalizePhone(raw, region).e164;
  const digits = raw.replace(/\D/g, "");
  const international = !raw.startsWith("+") && digits.length >= 8 ? normalizePhone(`+${digits}`).e164 : null;
  if (local && international && local !== international) return null;
  return local ?? international;
}

/**
 * When the message reached the buyer: when it was delivered, or, where no
 * delivery was ever reported (push never reports one; some providers' emails
 * neither), when it was sent. A failed message reached no one.
 */
export const reachedAt = (m: MessageRow) => (m.failedAt && !m.deliveredAt ? null : (m.deliveredAt ?? m.sentAt));
/** Sent, not failed, and no delivery reported: counted from when it was sent. */
const noDeliveryReport = (m: MessageRow) => !!m.sentAt && !m.deliveredAt && !m.failedAt;

/** The message an order follows, if any: the latest click within 7 days, else the latest reach within 1 day. */
export function attribute(order: FollowedOrder, messages: readonly MessageRow[]): { message: MessageRow; via: "click" | "reach" } | null {
  const t = order.placedAt.getTime();
  let best: { message: MessageRow; via: "click" | "reach"; at: number } | null = null;
  for (const m of messages) {
    if (m.customerId !== order.customerId) continue;
    const click = m.clickedAt?.getTime();
    if (click !== undefined && click <= t && t - click <= CLICK_WINDOW_MS) {
      if (!best || best.via === "reach" || click > best.at) best = { message: m, via: "click", at: click };
      continue;
    }
    const reach = reachedAt(m)?.getTime();
    if (reach !== undefined && reach <= t && t - reach <= REACH_WINDOW_MS && (!best || (best.via === "reach" && reach > best.at))) {
      best = { message: m, via: "reach", at: reach };
    }
  }
  return best ? { message: best.message, via: best.via } : null;
}

type Counts = { sent: number; reached: number; opened: number; clicked: number; failed: number; noDeliveryReport: number };
type Followed = { orders: number; delivered: number; returned: number; open: number; deliveredRevenue: Money[] };

export type MessagingView = {
  messages: number;
  /** Messages whose buyer matched one of the store's customers by phone. */
  matched: number;
  channels: Array<{ channel: Channel } & Counts>;
  journeys: Array<{ journeyId: string | null; name: string; kind: "flow" | "campaign" | null } & Counts & Followed>;
  followed: Followed & { viaClick: number; viaReach: number; sameSession: number };
};

const emptyCounts = (): Counts => ({ sent: 0, reached: 0, opened: 0, clicked: 0, failed: 0, noDeliveryReport: 0 });
const emptyFollowed = (): Followed => ({ orders: 0, delivered: 0, returned: 0, open: 0, deliveredRevenue: [] });

function addOrder(f: Followed, o: FollowedOrder) {
  f.orders += 1;
  if (o.outcome === "delivered" || o.outcome === "partially_delivered") {
    f.delivered += 1;
    if (o.delivered) f.deliveredRevenue = sumByCurrency([...f.deliveredRevenue, o.delivered]);
  } else if (o.outcome === "returned") f.returned += 1;
  else if (o.outcome !== "order_cancelled") f.open += 1;
}

/**
 * Messages sent in the period, and the orders that followed them. The orders
 * may fall just after the period ends: a message sent on its last day still
 * gets its 1 or 7 days.
 */
export function messagingView(input: { messages: readonly MessageRow[]; journeys: readonly JourneyRow[]; orders: readonly FollowedOrder[] }): MessagingView {
  const journeyName = new Map(input.journeys.map((j) => [j.id, j]));
  const channels = new Map<Channel, Counts>(CHANNELS.map((c) => [c, emptyCounts()]));
  const journeys = new Map<string, Counts & Followed>();
  const key = (id: string | null) => id ?? "";

  for (const m of input.messages) {
    const c = channels.get(m.channel)!;
    const j = journeys.get(key(m.journeyId)) ?? { ...emptyCounts(), ...emptyFollowed() };
    for (const x of [c, j]) {
      if (m.sentAt) x.sent += 1;
      if (reachedAt(m)) x.reached += 1;
      if (m.openedAt || m.readAt) x.opened += 1;
      if (m.clickedAt) x.clicked += 1;
      if (m.failedAt) x.failed += 1;
      if (noDeliveryReport(m)) x.noDeliveryReport += 1;
    }
    journeys.set(key(m.journeyId), j);
  }

  const followed = { ...emptyFollowed(), viaClick: 0, viaReach: 0, sameSession: 0 };
  // Each buyer's orders in time order, to spot an order in the same session as the one before it.
  const previous = new Map<string, number>();
  const sorted = [...input.orders].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
  const sessionRepeat = new Set<string>();
  for (const o of sorted) {
    const before = previous.get(o.customerId);
    if (before !== undefined && o.placedAt.getTime() - before < SAME_SESSION_MS) sessionRepeat.add(o.orderId);
    previous.set(o.customerId, o.placedAt.getTime());
  }
  const byCustomer = new Map<string, MessageRow[]>();
  for (const m of input.messages) if (m.customerId) byCustomer.set(m.customerId, [...(byCustomer.get(m.customerId) ?? []), m]);
  for (const o of input.orders) {
    const a = attribute(o, byCustomer.get(o.customerId) ?? []);
    if (!a) continue;
    if (sessionRepeat.has(o.orderId)) {
      followed.sameSession += 1;
      continue;
    }
    addOrder(followed, o);
    if (a.via === "click") followed.viaClick += 1;
    else followed.viaReach += 1;
    addOrder(journeys.get(key(a.message.journeyId))!, o);
  }

  return {
    messages: input.messages.length,
    matched: input.messages.filter((m) => m.customerId).length,
    channels: CHANNELS.map((channel) => ({ channel, ...channels.get(channel)! })).filter((c) => c.sent || c.failed),
    journeys: [...journeys.entries()]
      .map(([id, j]) => {
        const meta = id ? journeyName.get(id) : undefined;
        return { journeyId: id || null, name: meta?.name ?? (id ? "Journey not synced" : "No journey"), kind: meta?.kind ?? null, ...j };
      })
      .sort((a, b) => b.orders - a.orders || b.sent - a.sent || a.name.localeCompare(b.name)),
    followed,
  };
}
