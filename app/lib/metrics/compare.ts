/**
 * Comparisons and trends for headline numbers (Phase 4b, D2). Pure.
 *
 * Every headline is set against the previous period of equal length, the
 * same store-local days shifted back (rule #5). Rates compare in percentage
 * points and only when both periods decided enough orders to rate (rule #8's
 * spirit: a rate on a handful of orders is noise). Money compares in one
 * currency, the store's; anything left in another currency is not compared.
 */
import { parseAmount, type Money } from "./money";
import type { Bucket, RollupOrder } from "./rollups";

/** Decided orders (delivered + returned) a period needs before its rate is compared or drawn. */
export const MIN_DECIDED_TO_RATE = 20;

export type Direction = "up" | "down" | "flat";

export type Delta = {
  current: number | null;
  previous: number | null;
  /**
   * Counts and money: relative change in percent (null when the previous
   * value is zero). Rates: change in percentage points.
   */
  change: number | null;
  direction: Direction | null;
  unit: "percent" | "points";
  /** Set when the two periods are not like-for-like, so no change is drawn. */
  notComparable?: string;
};

const DAY = 86_400_000;
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const atDay = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** The equal-length period that ends the day before `from`. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const length = Math.round((atDay(to) - atDay(from)) / DAY) + 1;
  return { from: toDay(atDay(from) - length * DAY), to: toDay(atDay(from) - DAY) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function direction(change: number | null): Direction | null {
  if (change === null) return null;
  return change > 0 ? "up" : change < 0 ? "down" : "flat";
}

export function countDelta(current: number | null, previous: number | null): Delta {
  const change = current === null || previous === null || previous === 0 ? null : round1((100 * (current - previous)) / previous);
  return { current, previous, change, direction: direction(change), unit: "percent" };
}

/** Money in `currency` only; a currency neither period has compares as null. */
export function moneyDelta(current: Money[] | Money | null, previous: Money[] | Money | null, currency: string | null): Delta {
  const pick = (m: Money[] | Money | null) => {
    if (!m || !currency) return null;
    const one = Array.isArray(m) ? m.find((x) => x.currency === currency) : m.currency === currency ? m : undefined;
    return one ? Number(parseAmount(one.amount)!) / 1_000_000 : Array.isArray(m) ? 0 : null;
  };
  const c = pick(current);
  const p = pick(previous);
  const change = c === null || p === null || p === 0 ? null : round1((100 * (c - p)) / Math.abs(p));
  return { current: c, previous: p, change, direction: direction(change), unit: "percent" };
}

/** A delivery rate (rule #8), in points, only when both periods decided enough orders. */
export function rateDelta(current: Bucket["deliveryRate"], previous: Bucket["deliveryRate"]): Delta {
  const rated = (r: Bucket["deliveryRate"]) =>
    r.rate !== null && r.delivered + r.returned >= MIN_DECIDED_TO_RATE ? 100 * r.rate : null;
  const c = rated(current);
  const p = rated(previous);
  const change = c === null || p === null ? null : round1(c - p);
  return { current: c, previous: p, change, direction: direction(change), unit: "points" };
}

/**
 * Outcome-dependent figures (delivered revenue, product cost of delivered
 * orders, profit) grow for weeks after a period ends, so a young period
 * always looks worse than a mature one. Compare them only when both
 * periods have at most this share of orders still open.
 */
export const MAX_OPEN_SHARE_TO_COMPARE = 0.15;

/** Fee or cost coverage may differ by at most this many points between periods. */
export const MAX_COVERAGE_GAP_POINTS = 10;

type Maturity = { orders: number; stillOpen: number };

/** Withdraw the change when outcomes are still arriving in either period. */
export function whenSettled(d: Delta, current: Maturity, previous: Maturity): Delta {
  const share = (m: Maturity) => (m.orders ? m.stillOpen / m.orders : 0);
  const worst = Math.max(share(current), share(previous));
  if (worst <= MAX_OPEN_SHARE_TO_COMPARE) return d;
  return {
    ...d,
    change: null,
    direction: null,
    notComparable: `${Math.round(100 * share(current))}% of this period's orders and ${Math.round(100 * share(previous))}% of the previous period's are still open`,
  };
}

/** Withdraw the change when a figure is recorded on very different shares of orders. */
export function whenCovered(d: Delta, what: string, current: { have: number; of: number }, previous: { have: number; of: number }): Delta {
  const pct = (c: { have: number; of: number }) => (c.of ? (100 * c.have) / c.of : 100);
  if (Math.abs(pct(current) - pct(previous)) <= MAX_COVERAGE_GAP_POINTS) return d;
  return {
    ...d,
    change: null,
    direction: null,
    notComparable: `${what} recorded on ${Math.round(pct(current))}% of orders this period and ${Math.round(pct(previous))}% before`,
  };
}

/**
 * When the store's history does not reach back over the whole previous
 * period, a comparison would set a full period against a part of one. Every
 * headline in a view (anything shaped `{ delta, good }`) loses its previous
 * value, so no change is drawn anywhere on the screen.
 */
export function withoutComparison<T>(view: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      if ("delta" in o && "good" in o) {
        return { ...o, delta: { ...(o.delta as Delta), previous: null, change: null, direction: null } };
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(view) as T;
}

// ── Trends ─────────────────────────────────────────────────────────────────

export type Trend = {
  unit: "day" | "week";
  points: Array<{ label: string; value: number | null }>;
};

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = atDay(from); t <= atDay(to); t += DAY) out.push(toDay(t));
  return out;
}

/** Fewer points than this is not a trend. */
const MIN_POINTS = 4;

/** A count per local day the order was placed (rule #5). */
export function dailyCount(rows: readonly RollupOrder[], from: string, to: string, pick: (o: RollupOrder) => boolean): Trend | null {
  const days = eachDay(from, to);
  if (days.length < MIN_POINTS) return null;
  const by = new Map<string, number>();
  for (const o of rows) if (o.localDay && pick(o)) by.set(o.localDay, (by.get(o.localDay) ?? 0) + 1);
  return { unit: "day", points: days.map((d) => ({ label: d, value: by.get(d) ?? 0 })) };
}

/** A money total per local day, in one currency. */
export function dailyMoney(
  rows: readonly RollupOrder[],
  from: string,
  to: string,
  currency: string | null,
  pick: (o: RollupOrder) => Money | null,
): Trend | null {
  if (!currency) return null;
  const days = eachDay(from, to);
  if (days.length < MIN_POINTS) return null;
  const by = new Map<string, bigint>();
  for (const o of rows) {
    const m = pick(o);
    if (!o.localDay || !m || m.currency !== currency) continue;
    by.set(o.localDay, (by.get(o.localDay) ?? 0n) + parseAmount(m.amount)!);
  }
  return { unit: "day", points: days.map((d) => ({ label: d, value: Number(by.get(d) ?? 0n) / 1_000_000 })) };
}

/**
 * Delivery rate per 7-day block, ending on `to`. A block with fewer than
 * MIN_DECIDED_TO_RATE decided orders has no point rather than a noisy one;
 * a partial first block is dropped.
 */
export function weeklyRate(rows: readonly RollupOrder[], from: string, to: string): Trend | null {
  const blocks: Array<{ from: string; to: string }> = [];
  for (let end = atDay(to); end - 6 * DAY >= atDay(from); end -= 7 * DAY) {
    blocks.unshift({ from: toDay(end - 6 * DAY), to: toDay(end) });
  }
  if (blocks.length < MIN_POINTS) return null;
  const points = blocks.map((b) => {
    const mine = rows.filter((o) => o.localDay && o.localDay >= b.from && o.localDay <= b.to);
    const delivered = mine.filter((o) => o.outcome === "delivered").length;
    const decided = delivered + mine.filter((o) => o.outcome === "returned").length;
    return { label: `${b.from} to ${b.to}`, value: decided >= MIN_DECIDED_TO_RATE ? round1((100 * delivered) / decided) : null };
  });
  return points.filter((p) => p.value !== null).length >= MIN_POINTS ? { unit: "week", points } : null;
}

/** Distinct values of `key` per 7-day block ending on `to` (buyers per week, say). */
export function weeklyDistinct(rows: readonly RollupOrder[], from: string, to: string, key: (o: RollupOrder) => string | null): Trend | null {
  const blocks: Array<{ from: string; to: string }> = [];
  for (let end = atDay(to); end - 6 * DAY >= atDay(from); end -= 7 * DAY) {
    blocks.unshift({ from: toDay(end - 6 * DAY), to: toDay(end) });
  }
  if (blocks.length < MIN_POINTS) return null;
  return {
    unit: "week",
    points: blocks.map((b) => ({
      label: `${b.from} to ${b.to}`,
      value: new Set(rows.filter((o) => o.localDay && o.localDay >= b.from && o.localDay <= b.to).map(key).filter(Boolean)).size,
    })),
  };
}

// ── Thin rows ──────────────────────────────────────────────────────────────

/**
 * Rule (pack §2.5): a breakdown suppresses a row below its minimum rather
 * than show a noisy percentage. Rows under `min` decided orders are folded
 * into one row, keyed `other`, which states how many rows it holds; the
 * table keeps every order, and no rate is drawn from a handful.
 */
export function foldThinRows<T extends { orders: number; deliveryRate: Bucket["deliveryRate"] }>(
  rows: readonly T[],
  min: number,
  fold: (thin: T[]) => T,
): { rows: T[]; folded: number } {
  const decided = (r: T) => r.deliveryRate.delivered + r.deliveryRate.returned;
  const kept = rows.filter((r) => decided(r) >= min);
  const thin = rows.filter((r) => decided(r) < min);
  if (!thin.length) return { rows: [...kept], folded: 0 };
  return { rows: [...kept, fold(thin)], folded: thin.length };
}
