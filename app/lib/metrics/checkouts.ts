import { readMoney, sumByCurrency, type Money } from "./money";
import { normalizeEmail } from "../customers/phone";
import type { JourneyRow } from "./messaging";

/**
 * Abandoned checkouts and whether anyone followed them up (Phase 5,
 * G-GZR5-6; I6 on Shopify checkouts), from Retainify's checkouts and
 * messages and Growzar's own orders.
 *
 * - Abandoned: no order from the buyer within an hour of starting checkout
 *   (most checkouts on these stores become an order within minutes).
 * - Followed up: a Retainify message for that checkout, or to the same buyer
 *   by email or phone, within 7 days of abandoning and before any order.
 * - Recovered (rule #24): followed up, then an order within 7 days. An order
 *   with no message before it came back on its own.
 *
 * Only Retainify's messages are seen; a reminder sent by another app looks
 * like no follow-up, and the screen says so.
 */

export const CONVERTED_MS = 60 * 60_000;
export const RECOVERY_MS = 7 * 86_400_000;
/** Abandoned checkouts, with their 7 days over, before I6 judges a store. */
export const MIN_ABANDONED = 20;
/** Share of those never followed up at which I6 speaks. */
export const UNFOLLOWED_SHARE = 0.5;

export type Checkout = {
  token: string;
  startedAt: Date;
  total: Money | null;
  email: string | null;
  customerId: string | null;
  /** Retainify's stamp: the checkout became an order (not "a message recovered it"). */
  becameOrderAt: Date | null;
};

export type CheckoutMessage = { checkoutToken: string | null; email: string | null; customerId: string | null; sentAt: Date };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

/** Retainify's checkout row, without the customer (resolved separately by phone). */
export function parseCheckout(p: unknown): (Omit<Checkout, "customerId"> & { phoneE164: string | null; phoneRaw: string | null }) | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const token = str(r.checkoutToken);
  const startedAt = date(r.abandonedAt);
  if (!token || !startedAt) return null;
  const buyer = (r.buyer && typeof r.buyer === "object" ? r.buyer : {}) as Record<string, unknown>;
  return {
    token,
    startedAt,
    total: readMoney(r.total),
    email: normalizeEmail(str(buyer.email)),
    becameOrderAt: date(r.recoveredAt),
    phoneE164: str(buyer.phone),
    phoneRaw: str(buyer.phoneRaw),
  };
}

export type CheckoutFate = "converted" | "open" | "recovered" | "came_back" | "lost";

export type CheckoutsView = {
  /** Checkouts started in the period. */
  started: number;
  abandoned: number;
  abandonedValue: Money[];
  /** Abandoned less than 7 days ago: still inside the recovery window. */
  open: number;
  /** Abandoned at least 7 days ago. */
  settled: number;
  followedUp: number;
  notFollowedUp: number;
  notFollowedUpValue: Money[];
  recovered: number;
  recoveredValue: Money[];
  cameBack: number;
  /** Retainify journeys triggered by an abandoned cart, with their status and last send. */
  cartJourneys: Array<{ name: string; status: string | null; lastSent: string | null }>;
};

export function checkoutFate(
  c: Checkout,
  input: { messages: readonly CheckoutMessage[]; orderTimes: ReadonlyMap<string, readonly number[]>; now: Date },
): { fate: CheckoutFate; followedUp: boolean } {
  const start = c.startedAt.getTime();
  const fromOrders = c.customerId ? (input.orderTimes.get(c.customerId) ?? []).filter((t) => t >= start) : [];
  const candidates = [...fromOrders, ...(c.becameOrderAt ? [c.becameOrderAt.getTime()] : [])].filter((t) => t >= start);
  const orderAt = candidates.length ? Math.min(...candidates) : null;
  if (orderAt !== null && orderAt - start < CONVERTED_MS) return { fate: "converted", followedUp: false };

  const until = Math.min(start + RECOVERY_MS, orderAt ?? Infinity);
  const followedUp = input.messages.some((m) => {
    const t = m.sentAt.getTime();
    if (t < start || t > until) return false;
    return m.checkoutToken === c.token || (!!c.email && m.email === c.email) || (!!c.customerId && m.customerId === c.customerId);
  });
  const recoveredInTime = orderAt !== null && orderAt - start <= RECOVERY_MS;
  if (recoveredInTime) return { fate: followedUp ? "recovered" : "came_back", followedUp };
  if (input.now.getTime() - start < RECOVERY_MS) return { fate: "open", followedUp };
  return { fate: "lost", followedUp };
}

export function checkoutsView(input: {
  checkouts: readonly Checkout[];
  messages: readonly CheckoutMessage[];
  /** Each customer's order times (ms), any source. */
  orderTimes: ReadonlyMap<string, readonly number[]>;
  journeys: readonly JourneyRow[];
  lastSentByJourney: ReadonlyMap<string, string>;
  now: Date;
}): CheckoutsView {
  const v: CheckoutsView = {
    started: input.checkouts.length,
    abandoned: 0,
    abandonedValue: [],
    open: 0,
    settled: 0,
    followedUp: 0,
    notFollowedUp: 0,
    notFollowedUpValue: [],
    recovered: 0,
    recoveredValue: [],
    cameBack: 0,
    cartJourneys: input.journeys
      .filter((j) => j.trigger === "cart_abandoned")
      .map((j) => ({ name: j.name, status: j.status ?? null, lastSent: input.lastSentByJourney.get(j.id) ?? null }))
      .sort((a, b) => (b.lastSent ?? "").localeCompare(a.lastSent ?? "")),
  };
  for (const c of input.checkouts) {
    const { fate, followedUp } = checkoutFate(c, input);
    if (fate === "converted") continue;
    v.abandoned += 1;
    if (c.total) v.abandonedValue = sumByCurrency([...v.abandonedValue, c.total]);
    if (fate === "open") {
      v.open += 1;
      continue;
    }
    v.settled += 1;
    if (followedUp) v.followedUp += 1;
    else {
      v.notFollowedUp += 1;
      if (c.total) v.notFollowedUpValue = sumByCurrency([...v.notFollowedUpValue, c.total]);
    }
    if (fate === "recovered") {
      v.recovered += 1;
      if (c.total) v.recoveredValue = sumByCurrency([...v.recoveredValue, c.total]);
    }
    if (fate === "came_back") v.cameBack += 1;
  }
  return v;
}

export type UnfollowedCheckoutsFinding = {
  kind: "unfollowed_checkouts";
  settled: number;
  notFollowedUp: number;
  notFollowedUpValue: Money[];
  recovered: number;
  cameBack: number;
  /** A cart journey that is not published, with when it last sent: the likely reason. */
  pausedJourney: { name: string; status: string | null; lastSent: string | null } | null;
};

type Skip = { kind: "skip"; status: "not_enough_data" | "nothing_found"; reason: string };

/** I6: abandoned checkouts that nobody followed up. */
export function unfollowedCheckoutsFinding(v: CheckoutsView | null | undefined): UnfollowedCheckoutsFinding | Skip {
  if (!v) return { kind: "skip", status: "not_enough_data", reason: "Retainify has sent no checkouts for this period" };
  if (v.settled < MIN_ABANDONED) {
    return { kind: "skip", status: "not_enough_data", reason: `${v.settled} abandoned checkouts have had their 7 days; ${MIN_ABANDONED} are needed` };
  }
  if (v.notFollowedUp / v.settled < UNFOLLOWED_SHARE) {
    return { kind: "skip", status: "nothing_found", reason: `${v.followedUp} of ${v.settled} abandoned checkouts got a message within 7 days` };
  }
  const live = v.cartJourneys.find((j) => j.status === "published");
  return {
    kind: "unfollowed_checkouts",
    settled: v.settled,
    notFollowedUp: v.notFollowedUp,
    notFollowedUpValue: v.notFollowedUpValue,
    recovered: v.recovered,
    cameBack: v.cameBack,
    pausedJourney: live ? null : (v.cartJourneys[0] ?? null),
  };
}
