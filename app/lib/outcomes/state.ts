/**
 * Outcomes of state-based detectors (G-GZR9-3, pack §12). Pure.
 *
 * Their state keeps no history in Growzar, so a watch follows the orders the
 * finding was about when it was clicked (`baseline.items`), using the dates
 * the apps record (a parcel's settlement date, a return's received date, an
 * order's outcome time), or compares a rate before and after, or (stock,
 * statements) reads the apps' own dated records.
 */
import { courierDeductions, type DeductionRow } from "../metrics/cash";
import { MIN_UNITEMIZED_AMOUNT, MIN_UNITEMIZED_SHARE } from "../metrics/findings";
import { parseAmount, type Money } from "../metrics/money";
import type { RollupOrder } from "../metrics/rollups";
import type { Statement } from "../metrics/settlements";
import { emptyTally, type Tally, type Verdict, type WindowTally } from "./measure";
import type { WatchItem } from "./watch";

const DAY_MS = 86_400_000;

/** Detectors G-GZR9-3 measures. */
export const STATE_BASED = new Set([
  "cash_held",
  "returns_not_received",
  "stuck_parcels",
  "missing_courier_fees",
  "courierify_stopped",
  "unfollowed_checkouts",
  "unfollowed_form_abandonments",
  "courier_deductions",
  "stockout",
]);

/** A state-based outcome may be partly resolved (pack §12). */
export type StateVerdict = Verdict | "partly";

// ── A. Following the saved orders ────────────────────────────────────────────

export const FOLLOW_DAYS = [7, 14, 28] as const;
export const RESOLVED_SHARE = 0.8;
export const UNRESOLVED_SHARE = 0.2;

/** One saved order and when, if ever, it resolved (paid, received back, delivered or returned). */
export type Followed = {
  orderId: string;
  resolvedAt: Date | null;
  how?: string;
  money?: Money | null;
  /** I4 (D-93): its payout also reached the bank in Books' matched statements; absent when Books can't tell. */
  inBank?: boolean;
};

/** `inBankAmount` (D-93): of the amount resolved, what Books' bank statements show; only when Books can tell. */
export type FollowCheck = { day: number; resolved: number; total: number; share: number; amount: string | null; how?: Record<string, number>; inBankAmount?: string | null };

const sumMoney = (list: ReadonlyArray<Money | null | undefined>, currency: string | null): string | null => {
  if (!currency) return null;
  const units = list.reduce((a, m) => a + (m && m.currency === currency ? parseAmount(m.amount)! : 0n), 0n);
  return (Number(units) / 1_000_000).toFixed(2);
};

/** Where the saved orders stood on each check day so far, from their own dates. */
export function followChecks(items: readonly Followed[], actedAt: Date, now: Date, currency: string | null): FollowCheck[] {
  const daysSince = (now.getTime() - actedAt.getTime()) / DAY_MS;
  return FOLLOW_DAYS.filter((d) => daysSince >= d).map((day) => {
    const by = new Date(actedAt.getTime() + day * DAY_MS);
    const done = items.filter((i) => i.resolvedAt && i.resolvedAt <= by);
    const how: Record<string, number> = {};
    for (const i of done) if (i.how) how[i.how] = (how[i.how] ?? 0) + 1;
    const bankKnown = items.some((i) => i.inBank !== undefined);
    return {
      day,
      resolved: done.length,
      total: items.length,
      share: items.length ? Math.round((1000 * done.length) / items.length) / 1000 : 0,
      amount: sumMoney(done.map((i) => i.money), currency),
      ...(Object.keys(how).length ? { how } : {}),
      ...(bankKnown ? { inBankAmount: sumMoney(done.filter((i) => i.inBank).map((i) => i.money), currency) } : {}),
    };
  });
}

/** The verdict once day 28 is checked; too early before. */
export function followVerdict(checks: readonly FollowCheck[], totalItems: number): StateVerdict {
  const last = checks.find((c) => c.day === 28);
  if (!last) return "too_early";
  if (!totalItems) return "not_enough_data";
  if (last.share >= RESOLVED_SHARE) return "improved";
  if (last.share < UNRESOLVED_SHARE) return "no_change";
  return "partly";
}

type Parcel = Record<string, unknown>;
const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
const latest = (ds: ReadonlyArray<Date | null>) => (ds.some((d) => d === null) ? null : ds.reduce<Date | null>((a, d) => (!a || d! > a ? d : a), null));

/**
 * I4: an owed order is paid once every delivered parcel with COD on it is
 * settled; when, by the last settlement. With Books' matched bank statements
 * (`inBank`: Courierify settlement ids whose payout the bank shows, D-93), a
 * paid order also says whether the money reached the bank; it is paid either way.
 */
export function cashFollowed(items: readonly WatchItem[], parcelsByOrder: ReadonlyMap<string, readonly Parcel[]>, inBank: ReadonlySet<string> | null = null): Followed[] {
  return items.map((i) => {
    const ps = (parcelsByOrder.get(i.orderId) ?? []).filter((p) => p.status === "delivered");
    const s = ps.map((p) => (p.settlement ?? {}) as Record<string, unknown>);
    const resolvedAt = ps.length ? latest(s.map((x) => (x.settled === true ? date(x.settledAt) : null))) : null;
    const f: Followed = { orderId: i.orderId, resolvedAt, how: "paid", money: i.money ?? null };
    if (inBank) f.inBank = !!resolvedAt && s.every((x) => typeof x.settlementId === "string" && inBank.has(x.settlementId));
    return f;
  });
}

/** Returns not back: received once every returned parcel is confirmed received; the cost of what came back is the money. */
export function receivedFollowed(
  items: readonly WatchItem[],
  parcelsByOrder: ReadonlyMap<string, readonly Parcel[]>,
  ordersById: ReadonlyMap<string, RollupOrder>,
  currency: string | null,
  now: Date,
): Followed[] {
  return items.map((i) => {
    const ps = (parcelsByOrder.get(i.orderId) ?? []).filter((p) => p.status === "returned");
    // Received with no date: known only as of this measurement.
    const at = ps.map((p) => (p.returnReceived === true ? (date(p.returnReceivedAt) ?? now) : null));
    const o = ordersById.get(i.orderId);
    const cost = o && currency ? o.lines.reduce((a, l) => a + (l.cost && l.cost.currency === currency ? parseAmount(l.cost.amount)! : 0n), 0n) : 0n;
    return {
      orderId: i.orderId,
      resolvedAt: ps.length ? latest(at) : null,
      how: "received",
      money: currency ? { amount: (Number(cost) / 1_000_000).toFixed(2), currency } : null,
    };
  });
}

/** I7: a stuck parcel moved once its order is delivered or returned, at its outcome time. */
export function stuckFollowed(items: readonly WatchItem[], ordersById: ReadonlyMap<string, RollupOrder>): Followed[] {
  return items.map((i) => {
    const o = ordersById.get(i.orderId);
    const moved = o && (o.outcome === "delivered" || o.outcome === "returned");
    return { orderId: i.orderId, resolvedAt: moved ? (o.outcomeTiming?.at ?? null) : null, how: moved ? o.outcome : undefined };
  });
}

// ── B. Before/after rates (the store's own earlier rate) ─────────────────────

/** A fee recorded within this long after the order is still on its way, not missing. */
export const FEE_SETTLE_DAYS = 30;
const SHIPPED = ["delivered", "returned", "partially_delivered", "in_transit"];
const inWindow = (o: RollupOrder, w: { from: string; to: string }) => !!o.localDay && o.localDay >= w.from && o.localDay <= w.to;

/**
 * Rates as the rate engine counts them: `returned` is the bad side (a fee
 * missing, an order shipped outside Courierify, a checkout not followed up),
 * `delivered` the good one, `open` what may still go either way.
 */
export function rateTally(
  detector: "missing_courier_fees" | "courierify_stopped",
  orders: readonly RollupOrder[],
  w: { before: { from: string; to: string }; after: { from: string; to: string } },
  asOf: Date,
): { before: WindowTally; after: WindowTally } {
  const before: WindowTally = { subject: emptyTally(), rest: null };
  const after: WindowTally = { subject: emptyTally(), rest: null };
  for (const o of orders) {
    const into = inWindow(o, w.before) ? before.subject : inWindow(o, w.after) ? after.subject : null;
    if (!into || !SHIPPED.includes(o.outcome)) continue;
    if (detector === "courierify_stopped") {
      if (o.parcelCount > 0) into.delivered += 1;
      else into.returned += 1;
      continue;
    }
    if (o.parcelCount === 0) continue;
    if (o.courierFee) into.delivered += 1;
    else if (o.createdAt && asOf.getTime() - o.createdAt.getTime() < FEE_SETTLE_DAYS * DAY_MS) into.open += 1;
    else into.returned += 1;
  }
  return { before, after };
}

/** I6: a checkouts view as a tally, not followed up being the bad side. */
export const checkoutTally = (v: { open: number; followedUp: number; notFollowedUp: number } | null): Tally =>
  v ? { delivered: v.followedUp, returned: v.notFollowedUp, open: v.open, stale: 0 } : emptyTally();

// ── C. Statements and stock ──────────────────────────────────────────────────

/** Courier deductions: the payer's statements dated after acting, judged by the detector's own line. */
export function deductionsOutcome(
  statements: readonly Statement[],
  payer: string,
  after: { from: string; to: string },
  currency: string,
  atCutoff: boolean,
): { verdict: StateVerdict; row: DeductionRow | null; unitemizedShare: number | null } {
  const row = courierDeductions(statements, after.from, after.to, currency).find((r) => r.payer === payer) ?? null;
  if (!row) return { verdict: atCutoff ? "not_enough_data" : "too_early", row: null, unitemizedShare: null };
  const cod = parseAmount(row.cod.amount)!;
  const un = parseAmount(row.unitemized.amount)!;
  const share = cod > 0n ? Number((un * 1000n) / cod) / 10 : 0;
  const stillOver = share >= MIN_UNITEMIZED_SHARE && un >= MIN_UNITEMIZED_AMOUNT;
  return { verdict: stillOver ? "no_change" : "improved", row, unitemizedShare: share };
}

export const STOCK_DAYS_MARGIN = 3;
/** Snapshot days needed out of the 28 to judge. */
export const MIN_STOCK_DAYS = 21;

/** I3: days with nothing in stock on days 1–28 against the shortfall the card forecast. */
export function stockoutOutcome(
  snapshots: ReadonlyArray<{ day: string; stock: number }>,
  after: { from: string; to: string },
  forecastShortDays: number | null,
  afterClosed: boolean,
): { verdict: StateVerdict; daysOut: number; daysSeen: number; forecastShortDays: number | null } {
  const seen = new Map<string, number>();
  for (const s of snapshots) if (s.day >= after.from && s.day <= after.to) seen.set(s.day, Math.min(seen.get(s.day) ?? Infinity, s.stock));
  const daysOut = [...seen.values()].filter((v) => v <= 0).length;
  const base = { daysOut, daysSeen: seen.size, forecastShortDays };
  if (!afterClosed) return { verdict: "too_early", ...base };
  if (forecastShortDays === null || seen.size < MIN_STOCK_DAYS) return { verdict: "not_enough_data", ...base };
  if (daysOut <= forecastShortDays - STOCK_DAYS_MARGIN) return { verdict: "improved", ...base };
  if (daysOut >= forecastShortDays + STOCK_DAYS_MARGIN) return { verdict: "worse", ...base };
  return { verdict: "no_change", ...base };
}
