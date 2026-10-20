/**
 * Outcome odds and delivery times, from this store's own orders (G-GZR11-1,
 * pack §5.1). Pure.
 *
 * Both are looked up by courier × city. A cell with fewer than MIN_CELL
 * usable orders falls back to the courier, then to the store: a thin cell
 * borrows its parent's figure instead of inventing one, and every answer says
 * which level it came from.
 *
 * Age is counted from when the order was placed, not when the parcel was
 * booked: the order grain has no booking time, and the same clock is used for
 * the history and for the open parcels it is applied to, so the two agree.
 * Only courier- or 3PL-timed outcomes have an age; Financify's status-as-of
 * outcomes count toward the odds of a new order but not toward aged ones.
 */

import type { RollupOrder } from "../metrics/rollups";
import { DAY_MS, daysBetween, quantile } from "./stats";

export const MIN_CELL = 30;
/** History the odds are read from (pack §5.1). */
export const ODDS_WINDOW_DAYS = 180;
/**
 * Orders placed more recently are left out of the odds. Deliveries are
 * decided sooner than returns, so among recent orders the decided ones are
 * mostly deliveries: counting them put yx4fu1-ax's odds at 0.97 delivered in
 * August, when 0.80 of those orders were.
 */
export const ODDS_MATURE_DAYS = 21;
/**
 * Delivery times read orders placed at least this long ago, so a parcel that
 * took four or five weeks is in the distribution rather than cut off; with
 * 21 days, weeks forecast at 0 kept getting late deliveries.
 */
export const TIMES_MATURE_DAYS = 42;

export type Level = "courier_city" | "courier" | "store";

export type Observation = {
  courier: string;
  city: string;
  delivered: boolean;
  /** Days from order to delivered or returned; null when the outcome was not timed. */
  decidedAfterDays: number | null;
  /** The week the order was placed (days since the epoch / 7), for week-to-week spread. */
  week: number;
};

const UNKNOWN_COURIER = "unknown";
const UNMAPPED_CITY = "unmapped";
const DELIVERED = new Set(["delivered", "partially_delivered"]);
const DECIDED = new Set([...DELIVERED, "returned"]);
const TIMED = new Set(["happened_on", "reported_by_3pl"]);

export const courierKey = (c: string | null | undefined) => (c ? c.toLowerCase() : UNKNOWN_COURIER);
export const cityKey = (c: string | null | undefined) => (c ? c.toLowerCase() : UNMAPPED_CITY);

/**
 * Decided orders placed in the window before `asOf`, leaving out the last
 * ODDS_MATURE_DAYS. Pass rows already read as known at `asOf`
 * (as-of.server.ts `knownAt`), so a backtest sees only what was known then.
 */
export function observations(rows: readonly RollupOrder[], asOf: Date, windowDays = ODDS_WINDOW_DAYS, matureDays = ODDS_MATURE_DAYS): Observation[] {
  const from = asOf.getTime() - windowDays * DAY_MS;
  const to = asOf.getTime() - matureDays * DAY_MS;
  return rows
    .filter((o) => DECIDED.has(o.outcome) && o.createdAt && o.createdAt.getTime() >= from && o.createdAt.getTime() < to)
    .map((o) => ({
      courier: courierKey(o.courier),
      city: cityKey(o.city),
      delivered: DELIVERED.has(o.outcome),
      decidedAfterDays: o.outcomeTiming && TIMED.has(o.outcomeTiming.basis) ? Math.max(0, daysBetween(o.createdAt!, o.outcomeTiming.at)) : null,
      week: Math.floor(o.createdAt!.getTime() / (7 * DAY_MS)),
    }));
}

type Cells<T> = Map<string, T[]>;
const cellOf = (level: Level, courier: string, city: string) =>
  level === "courier_city" ? `${courier}|${city}` : level === "courier" ? courier : "store";

/** Items grouped at every level once, then looked up from the narrowest cell that has enough. */
export class Pool<T extends { courier: string; city: string }> {
  private readonly cells: Cells<T> = new Map();

  constructor(items: readonly T[]) {
    for (const item of items) {
      for (const level of ["courier_city", "courier", "store"] as const) {
        const k = cellOf(level, item.courier, item.city);
        const list = this.cells.get(k);
        if (list) list.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }

  /** Every item, whatever its courier and city. */
  all(): T[] {
    return this.cells.get("store") ?? [];
  }

  /** The cells an order of this courier and city falls in, narrowest first. */
  levels(courier: string | null, city: string | null): Array<{ items: T[]; level: Level }> {
    return (["courier_city", "courier", "store"] as const).map((level) => ({ items: this.cells.get(cellOf(level, courierKey(courier), cityKey(city))) ?? [], level }));
  }

  /** The narrowest cell with at least `min` items passing `keep`. */
  find(courier: string | null, city: string | null, keep: (t: T) => boolean = () => true, min = MIN_CELL): { items: T[]; level: Level } | null {
    for (const { items: all, level } of this.levels(courier, city)) {
      const items = all.filter(keep);
      if (items.length >= min) return { items, level };
    }
    return null;
  }
}

export type Odds = {
  /** P(delivered | decided), for an order still open at `ageDays`. */
  pDelivered: number;
  /**
   * Orders the figure rests on: the decided orders for a new order; for an
   * older one, the timed orders that took longer than its age.
   */
  n: number;
  level: Level;
  /** False when no level had enough timed orders of both outcomes, so the odds of a new order are used. */
  aged: boolean;
};

/** Timed deliveries and timed returns each a cell needs before its timing is trusted for an aged order. */
export const MIN_TIMED = 10;

/**
 * For an order still open at age a:
 *
 *   P(delivered | open at a) = p·S_d(a) / (p·S_d(a) + (1 − p)·S_r(a))
 *
 * p is the delivered share of all decided orders, timed or not; S_d and S_r
 * are the shares of timed deliveries and timed returns that took longer than
 * a. Reading the odds off timed orders alone would be biased wherever one
 * outcome is timed more often than the other: on yx4fu1-ax Smartlane times
 * most deliveries but few returns, so an order a week old looked certain to
 * be delivered.
 */
export class OutcomeOdds {
  private readonly pool: Pool<Observation>;

  constructor(observations: readonly Observation[]) {
    this.pool = new Pool(observations);
  }

  /** Odds for an order of this courier and city that is still undecided `ageDays` after it was placed. */
  at(courier: string | null, city: string | null, ageDays = 0): Odds | null {
    const fresh = this.pool.find(courier, city);
    if (!fresh) return null;
    const base = { pDelivered: fresh.items.filter((o) => o.delivered).length / fresh.items.length, n: fresh.items.length, level: fresh.level };
    if (ageDays <= 0) return { ...base, aged: true };
    for (const { items, level } of this.pool.levels(courier, city)) {
      if (items.length < MIN_CELL) continue;
      const tD = items.filter((o) => o.delivered && o.decidedAfterDays !== null);
      const tR = items.filter((o) => !o.delivered && o.decidedAfterDays !== null);
      if (tD.length < MIN_TIMED || tR.length < MIN_TIMED) continue;
      const sD = tD.filter((o) => o.decidedAfterDays! > ageDays).length;
      const sR = tR.filter((o) => o.decidedAfterDays! > ageDays).length;
      if (sD + sR < MIN_TIMED) continue;
      const p = items.filter((o) => o.delivered).length / items.length;
      const d = p * (sD / tD.length);
      const r = (1 - p) * (sR / tR.length);
      return { pDelivered: d / (d + r), n: sD + sR, level, aged: true };
    }
    return { ...base, aged: false };
  }

  /** The whole store's odds for a new order (not the "unknown courier, unmapped city" cell). */
  store(): Odds | null {
    const all = this.pool.all();
    if (all.length < MIN_CELL) return null;
    return { pDelivered: all.filter((o) => o.delivered).length / all.length, n: all.length, level: "store", aged: true };
  }
}

export type Remaining = {
  /** Days from now to delivered, ascending, for an order still open at the age asked. */
  days: number[];
  n: number;
  level: Level;
  /** False when it came from the shorter history (orders placed 21+ days ago), whose slowest deliveries are cut off. */
  complete: boolean;
};

/**
 * Days from order to delivered, by courier × city, from timed deliveries
 * (pack: delivery-time distribution). For an order already `ageDays` old,
 * only deliveries that took longer than that are relevant, shifted to "days
 * from now".
 *
 * Read from orders placed TIMES_MATURE_DAYS or more ago when there are
 * enough, so slow deliveries are in it; otherwise (a store whose courier
 * history is a few weeks old) from the odds' history, marked incomplete.
 */
export class DeliveryTimes {
  private readonly long: Pool<Observation>;
  private readonly short: Pool<Observation>;

  constructor(long: readonly Observation[], short: readonly Observation[] = []) {
    const timed = (xs: readonly Observation[]) => xs.filter((o) => o.delivered && o.decidedAfterDays !== null);
    this.long = new Pool(timed(long));
    this.short = new Pool(timed(short));
  }

  remaining(courier: string | null, city: string | null, ageDays = 0): Remaining | null {
    const older = (o: Observation) => o.decidedAfterDays! > ageDays;
    const long = this.long.find(courier, city, older);
    const hit = long ?? this.short.find(courier, city, older);
    if (!hit) return null;
    const days = hit.items.map((o) => o.decidedAfterDays! - ageDays).sort((a, b) => a - b);
    return { days, n: days.length, level: hit.level, complete: long !== null };
  }

  median(courier: string | null, city: string | null): number | null {
    const r = this.remaining(courier, city);
    return r ? quantile(r.days, 0.5) : null;
  }
}

export type Spread = {
  /** Week-to-week standard deviation of the delivered share beyond what chance explains. */
  odds: number;
  /** Week-to-week standard deviation of the median days to delivery. */
  days: number;
  level: Level;
};

/** Orders a weekly group needs to count toward the spread. */
export const MIN_WEEK = 10;
/** Weekly groups needed before a spread is trusted. */
export const MIN_WEEKS = 4;

const sd = (xs: readonly number[]) => {
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

/**
 * How much a courier's weeks differ from each other (G-GZR11-2). A run of the
 * cash forecast moves all of a courier's parcels together by one draw of
 * this, because a bad week (a strike, a backlog, a city closing) hits every
 * parcel at once; without it, weekly ranges were far too narrow.
 */
export function spreadOf(items: readonly Observation[]): { odds: number | null; days: number | null } {
  const byWeek = new Map<number, Observation[]>();
  for (const o of items) byWeek.set(o.week, [...(byWeek.get(o.week) ?? []), o]);
  const weeks = [...byWeek.values()].filter((w) => w.length >= MIN_WEEK);
  let odds: number | null = null;
  if (weeks.length >= MIN_WEEKS) {
    const shares = weeks.map((w) => w.filter((o) => o.delivered).length / w.length);
    const chance = weeks.reduce((a, w, i) => a + (shares[i]! * (1 - shares[i]!)) / w.length, 0) / weeks.length;
    odds = Math.sqrt(Math.max(0, sd(shares) ** 2 - chance));
  }
  const timed = weeks
    .map((w) => w.filter((o) => o.delivered && o.decidedAfterDays !== null).map((o) => o.decidedAfterDays!).sort((a, b) => a - b))
    .filter((w) => w.length >= MIN_WEEK);
  const days = timed.length >= MIN_WEEKS ? sd(timed.map((w) => quantile(w, 0.5)!)) : null;
  return { odds, days };
}

export class Spreads {
  private readonly pool: Pool<Observation>;
  private readonly cache = new Map<string, Spread | null>();

  constructor(observations: readonly Observation[]) {
    this.pool = new Pool(observations);
  }

  /** The narrowest level with enough weeks for both figures; null when even the store has too few. */
  of(courier: string | null): Spread | null {
    const key = courierKey(courier);
    if (this.cache.has(key)) return this.cache.get(key)!;
    let found: Spread | null = null;
    for (const { items, level } of this.pool.levels(courier, null)) {
      if (level === "courier_city") continue;
      const s = spreadOf(items);
      if (s.odds !== null && s.days !== null) {
        found = { odds: s.odds, days: s.days, level };
        break;
      }
    }
    this.cache.set(key, found);
    return found;
  }

  /** The whole store's spread (not the "unknown courier" cell). */
  store(): Spread | null {
    const s = spreadOf(this.pool.all());
    return s.odds !== null && s.days !== null ? { odds: s.odds, days: s.days, level: "store" } : null;
  }
}
