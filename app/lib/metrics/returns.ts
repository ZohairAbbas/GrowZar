/**
 * Shipping depth (Phase 4c, A5–A8). Pure, over grain rows plus the parcel
 * facts the grain does not carry: whether a return reached the merchant, the
 * fees Courierify recorded per parcel, and what the courier wrote on its
 * return and failed-attempt events.
 *
 *  - what returns cost, and which returns have not come back (A5);
 *  - outcomes by the day orders were placed (A6);
 *  - why parcels come back and why attempts fail, in the courier's words (A7);
 *  - how each courier performs: speed, first-attempt success, stuck (A8).
 */
import { MIN_DECIDED_TO_RATE } from "./compare";
import { isStuck } from "./cash";
import { formatAmount, parseAmount, type Money } from "./money";
import { byCity, byCourier, type RollupOrder } from "./rollups";

const units = (m: Money | null | undefined, currency: string) => (m && m.currency === currency ? parseAmount(m.amount)! : 0n);
const money = (u: bigint, currency: string): Money => ({ amount: formatAmount(u), currency });
const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);

/** One Courierify parcel's facts the grain does not hold. */
export type ParcelFacts = {
  orderId: string;
  courier: string | null;
  outcome: string;
  /** The merchant confirmed the returned goods came back (Courierify). */
  returnReceived: boolean;
  /** When the courier marked it returned, if it said. */
  returnedAt: Date | null;
  /** Fees Courierify recorded on the parcel, where it has them. */
  fee: Money | null;
};

/** One courier event with text: a return or a failed attempt. */
export type CourierNote = { orderId: string; kind: "returned" | "attempted"; raw: string; at: Date };

// ── A7: reasons, in the courier's words ─────────────────────────────────────

/**
 * The reason inside a courier's status text, or null when it gives none.
 * Leopards writes "Ready for Return in LAHORE - REFUSED WITH NO REASON" and
 * "Pending - CONSIGNEE NOT AVAILABLE"; the part after the last " - " is the
 * reason. Text with no reason ("Being Return") is null rather than a reason
 * of its own. The words are the courier's; only their case is changed.
 */
export function parseReason(raw: string | null | undefined): string | null {
  const t = raw?.trim();
  if (!t) return null;
  const i = t.lastIndexOf(" - ");
  if (i < 0) return null;
  const r = t.slice(i + 3).trim();
  if (!r || /^self$/i.test(r)) return null;
  const lower = r.toLowerCase().replace(/\s+/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export type ReasonRow = { reason: string; orders: number; couriers: string[] };

function reasonsOf(notes: readonly CourierNote[], kind: CourierNote["kind"], courierOf: (orderId: string) => string): ReasonRow[] {
  // An order counts once per reason: the latest of each kind decides for returns,
  // every distinct reason counts for attempts.
  const latest = new Map<string, CourierNote>();
  const seen = new Map<string, Set<string>>();
  for (const n of notes.filter((x) => x.kind === kind)) {
    if (kind === "returned") {
      const r = parseReason(n.raw);
      const prev = latest.get(n.orderId);
      if (r && (!prev || n.at > prev.at)) latest.set(n.orderId, n);
    } else {
      const r = parseReason(n.raw);
      if (r) seen.set(r, (seen.get(r) ?? new Set()).add(n.orderId));
    }
  }
  if (kind === "returned") for (const n of latest.values()) seen.set(parseReason(n.raw)!, (seen.get(parseReason(n.raw)!) ?? new Set()).add(n.orderId));
  return [...seen.entries()]
    .map(([reason, orders]) => ({ reason, orders: orders.size, couriers: [...new Set([...orders].map(courierOf))].sort() }))
    .sort((a, b) => b.orders - a.orders || a.reason.localeCompare(b.reason));
}

// ── A5: what returns cost ───────────────────────────────────────────────────

export type ReturnsByCourier = {
  courier: string;
  returned: number;
  value: Money;
  productCost: Money;
  /** Courier fees recorded on these returns, and on how many. */
  fees: Money;
  withFee: number;
  received: number;
  notReceived: number;
  /** Returns with a reason in the courier's words. */
  withReason: number;
};

export type ReturnsView = {
  currency: string;
  returned: number;
  value: Money;
  /** Product that went out and came back: at risk until it is back on the shelf. */
  productCost: Money;
  fees: Money;
  withFee: number;
  /** Courierify-booked returns whose goods the merchant has not confirmed back. */
  notReceived: { orders: number; value: Money; productCost: Money; olderThan14Days: number };
  courierifyReturns: number;
  byCourier: ReturnsByCourier[];
  returnReasons: ReasonRow[];
  attemptReasons: ReasonRow[];
};

export function returnsView(
  rows: readonly RollupOrder[],
  parcels: readonly ParcelFacts[],
  notes: readonly CourierNote[],
  currency: string,
  asOf: Date,
): ReturnsView {
  const returned = rows.filter((o) => o.outcome === "returned" && (o.placed?.currency ?? currency) === currency);
  const ids = new Set(returned.map((o) => o.orderId));
  const parcelsOf = new Map<string, ParcelFacts[]>();
  for (const p of parcels) if (ids.has(p.orderId)) parcelsOf.set(p.orderId, [...(parcelsOf.get(p.orderId) ?? []), p]);
  const sum = (list: readonly RollupOrder[], pick: (o: RollupOrder) => Money | null | undefined) =>
    list.reduce((a, o) => a + units(pick(o), currency), 0n);
  const fee = (o: RollupOrder) => {
    const ps = parcelsOf.get(o.orderId) ?? [];
    const recorded = ps.filter((p) => p.fee);
    return recorded.length ? recorded.reduce((a, p) => a + units(p.fee, currency), 0n) : null;
  };
  const viaCourierify = returned.filter((o) => o.parcelCount > 0 && parcelsOf.has(o.orderId));
  const notBack = viaCourierify.filter((o) => parcelsOf.get(o.orderId)!.some((p) => p.outcome === "returned" && !p.returnReceived));
  const returnedAt = (o: RollupOrder) =>
    parcelsOf.get(o.orderId)!.map((p) => p.returnedAt ?? o.outcomeTiming?.at ?? null).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const reasonIds = new Set(notes.filter((n) => n.kind === "returned" && parseReason(n.raw)).map((n) => n.orderId));
  const courierOfOrder = new Map(rows.map((o) => [o.orderId, byCourier(o)[0]!]));

  const byCourierMap = new Map<string, RollupOrder[]>();
  for (const o of returned) byCourierMap.set(byCourier(o)[0]!, [...(byCourierMap.get(byCourier(o)[0]!) ?? []), o]);

  const feeTotal = returned.reduce((a, o) => a + (fee(o) ?? 0n), 0n);
  return {
    currency,
    returned: returned.length,
    value: money(sum(returned, (o) => o.placed), currency),
    productCost: money(sum(returned, (o) => o.cogs), currency),
    fees: money(feeTotal, currency),
    withFee: returned.filter((o) => fee(o) !== null).length,
    notReceived: {
      orders: notBack.length,
      value: money(sum(notBack, (o) => o.placed), currency),
      productCost: money(sum(notBack, (o) => o.cogs), currency),
      olderThan14Days: notBack.filter((o) => {
        const at = returnedAt(o);
        return at !== null && asOf.getTime() - at.getTime() > 14 * 86_400_000;
      }).length,
    },
    courierifyReturns: viaCourierify.length,
    byCourier: [...byCourierMap.entries()]
      .map(([courier, list]) => {
        const cfy = list.filter((o) => parcelsOf.has(o.orderId));
        const back = cfy.filter((o) => !notBack.includes(o));
        return {
          courier,
          returned: list.length,
          value: money(sum(list, (o) => o.placed), currency),
          productCost: money(sum(list, (o) => o.cogs), currency),
          fees: money(list.reduce((a, o) => a + (fee(o) ?? 0n), 0n), currency),
          withFee: list.filter((o) => fee(o) !== null).length,
          received: back.length,
          notReceived: cfy.length - back.length,
          withReason: list.filter((o) => reasonIds.has(o.orderId)).length,
        };
      })
      .sort((a, b) => b.returned - a.returned),
    returnReasons: reasonsOf(notes.filter((n) => ids.has(n.orderId)), "returned", (id) => courierOfOrder.get(id) ?? "unknown"),
    attemptReasons: reasonsOf(
      notes.filter((n) => courierOfOrder.has(n.orderId)),
      "attempted",
      (id) => courierOfOrder.get(id) ?? "unknown",
    ),
  };
}

// ── A6: outcomes by order day ───────────────────────────────────────────────

export type DayOutcome = { label: string; from: string; to: string; delivered: number; returned: number; open: number; other: number };

/**
 * Orders placed per day (per week past 31 days), split by what happened to
 * them. Shares are of orders placed, so recent days show what is still open
 * rather than a delivery rate that looks like it is collapsing.
 */
export function outcomesByDay(rows: readonly RollupOrder[], from: string, to: string): DayOutcome[] {
  const DAY = 86_400_000;
  const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const span = Math.round((at(to) - at(from)) / DAY) + 1;
  const step = span > 31 ? 7 : 1;
  const bins: DayOutcome[] = [];
  for (let end = at(to); end >= at(from); end -= step * DAY) {
    const start = Math.max(at(from), end - (step - 1) * DAY);
    bins.unshift({ label: step === 1 ? day(end) : `${day(start)} to ${day(end)}`, from: day(start), to: day(end), delivered: 0, returned: 0, open: 0, other: 0 });
  }
  for (const o of rows) {
    if (!o.localDay) continue;
    const b = bins.find((x) => o.localDay! >= x.from && o.localDay! <= x.to);
    if (!b) continue;
    if (o.outcome === "delivered") b.delivered += 1;
    else if (o.outcome === "returned") b.returned += 1;
    else if (["in_transit", "booked", "not_shipped"].includes(o.outcome)) b.open += 1;
    else b.other += 1;
  }
  return bins;
}

// ── A8: courier performance ─────────────────────────────────────────────────

export type CourierPerformance = {
  courier: string;
  orders: number;
  decided: number;
  deliveryRate: number | null;
  /** Days from order to delivery, courier-timed deliveries only. */
  medianDays: number | null;
  p90Days: number | null;
  timed: number;
  /** Delivered without a failed attempt first; null when the courier does not report attempts. */
  firstAttempt: number | null;
  /** Returned parcels that had at least one failed attempt first. */
  returnedAfterAttempt: number | null;
  stuck: number;
};

/** A courier reports failed attempts if this share of its decided orders has one. */
export const MIN_ATTEMPT_REPORTING = 0.05;

const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round((sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo)) * 10) / 10;
};

export function courierPerformance(rows: readonly RollupOrder[], notes: readonly CourierNote[], asOf: Date): CourierPerformance[] {
  const attempted = new Set(notes.filter((n) => n.kind === "attempted").map((n) => n.orderId));
  const by = new Map<string, RollupOrder[]>();
  for (const o of rows.filter((x) => x.parcelCount > 0)) by.set(byCourier(o)[0]!, [...(by.get(byCourier(o)[0]!) ?? []), o]);
  return [...by.entries()]
    .map(([courier, list]) => {
      const delivered = list.filter((o) => o.outcome === "delivered");
      const returned = list.filter((o) => o.outcome === "returned");
      const decided = delivered.length + returned.length;
      const timed = delivered
        .filter((o) => o.outcomeTiming?.basis === "happened_on" && o.createdAt)
        .map((o) => (o.outcomeTiming!.at.getTime() - o.createdAt!.getTime()) / 86_400_000)
        .sort((a, b) => a - b);
      const withAttempt = list.filter((o) => attempted.has(o.orderId)).length;
      const reports = decided > 0 && withAttempt / decided >= MIN_ATTEMPT_REPORTING;
      const rated = decided >= MIN_DECIDED_TO_RATE;
      return {
        courier,
        orders: list.length,
        decided,
        deliveryRate: rated ? pct(delivered.length, decided) : null,
        medianDays: timed.length >= MIN_DECIDED_TO_RATE ? quantile(timed, 0.5) : null,
        p90Days: timed.length >= MIN_DECIDED_TO_RATE ? quantile(timed, 0.9) : null,
        timed: timed.length,
        firstAttempt: reports && delivered.length >= MIN_DECIDED_TO_RATE ? pct(delivered.filter((o) => !attempted.has(o.orderId)).length, delivered.length) : null,
        returnedAfterAttempt: reports && returned.length ? pct(returned.filter((o) => attempted.has(o.orderId)).length, returned.length) : null,
        stuck: list.filter((o) => isStuck(o, asOf)).length,
      };
    })
    .sort((a, b) => b.orders - a.orders);
}

/** Top cities by returns, for the returns card. */
export function returnsByCity(rows: readonly RollupOrder[], limit = 8) {
  const by = new Map<string, { returned: number; decided: number }>();
  for (const o of rows) {
    if (o.outcome !== "delivered" && o.outcome !== "returned") continue;
    const k = byCity(o)[0]!;
    const e = by.get(k) ?? { returned: 0, decided: 0 };
    e.decided += 1;
    if (o.outcome === "returned") e.returned += 1;
    by.set(k, e);
  }
  return [...by.entries()]
    .filter(([, e]) => e.decided >= MIN_DECIDED_TO_RATE)
    .map(([city, e]) => ({ city, ...e, rate: pct(e.returned, e.decided)! }))
    .sort((a, b) => b.returned - a.returned)
    .slice(0, limit);
}
