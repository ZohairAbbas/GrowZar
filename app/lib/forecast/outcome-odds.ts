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

export type Level = "courier_city" | "courier" | "store";

export type Observation = {
  courier: string;
  city: string;
  delivered: boolean;
  /** Days from order to delivered or returned; null when the outcome was not timed. */
  decidedAfterDays: number | null;
};

const UNKNOWN_COURIER = "unknown";
const UNMAPPED_CITY = "unmapped";
const DELIVERED = new Set(["delivered", "partially_delivered"]);
const DECIDED = new Set([...DELIVERED, "returned"]);
const TIMED = new Set(["happened_on", "reported_by_3pl"]);

export const courierKey = (c: string | null | undefined) => (c ? c.toLowerCase() : UNKNOWN_COURIER);
export const cityKey = (c: string | null | undefined) => (c ? c.toLowerCase() : UNMAPPED_CITY);

/**
 * Decided orders placed in the window before `asOf`. Pass rows already read
 * as known at `asOf` (as-of.server.ts `knownAt`), so a backtest sees only
 * what was known then.
 */
export function observations(rows: readonly RollupOrder[], asOf: Date, windowDays = ODDS_WINDOW_DAYS): Observation[] {
  const from = asOf.getTime() - windowDays * DAY_MS;
  return rows
    .filter((o) => DECIDED.has(o.outcome) && o.createdAt && o.createdAt.getTime() >= from && o.createdAt < asOf)
    .map((o) => ({
      courier: courierKey(o.courier),
      city: cityKey(o.city),
      delivered: DELIVERED.has(o.outcome),
      decidedAfterDays: o.outcomeTiming && TIMED.has(o.outcomeTiming.basis) ? Math.max(0, daysBetween(o.createdAt!, o.outcomeTiming.at)) : null,
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

  /** The narrowest cell with at least `min` items passing `keep`. */
  find(courier: string | null, city: string | null, keep: (t: T) => boolean = () => true, min = MIN_CELL): { items: T[]; level: Level } | null {
    for (const level of ["courier_city", "courier", "store"] as const) {
      const items = (this.cells.get(cellOf(level, courierKey(courier), cityKey(city))) ?? []).filter(keep);
      if (items.length >= min) return { items, level };
    }
    return null;
  }
}

export type Odds = {
  /** P(delivered | decided), for an order still open at `ageDays`. */
  pDelivered: number;
  /** Decided orders the figure is built from. */
  n: number;
  level: Level;
  /** False when no level had enough timed orders older than the age, so the odds of a new order are used. */
  aged: boolean;
};

export class OutcomeOdds {
  private readonly pool: Pool<Observation>;

  constructor(observations: readonly Observation[]) {
    this.pool = new Pool(observations);
  }

  /** Odds for an order of this courier and city that is still undecided `ageDays` after it was placed. */
  at(courier: string | null, city: string | null, ageDays = 0): Odds | null {
    const survives = (o: Observation) => o.decidedAfterDays !== null && o.decidedAfterDays > ageDays;
    const aged = ageDays > 0 ? this.pool.find(courier, city, survives) : this.pool.find(courier, city);
    const hit = aged ?? this.pool.find(courier, city);
    if (!hit) return null;
    const delivered = hit.items.filter((o) => o.delivered).length;
    return { pDelivered: delivered / hit.items.length, n: hit.items.length, level: hit.level, aged: ageDays === 0 || aged !== null };
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
};

/**
 * Days from order to delivered, by courier × city, from timed deliveries
 * (pack: delivery-time distribution). For an order already `ageDays` old,
 * only deliveries that took longer than that are relevant, shifted to "days
 * from now".
 */
export class DeliveryTimes {
  private readonly pool: Pool<Observation>;

  constructor(observations: readonly Observation[]) {
    this.pool = new Pool(observations.filter((o) => o.delivered && o.decidedAfterDays !== null));
  }

  remaining(courier: string | null, city: string | null, ageDays = 0): Remaining | null {
    const hit = this.pool.find(courier, city, (o) => o.decidedAfterDays! > ageDays);
    if (!hit) return null;
    const days = hit.items.map((o) => o.decidedAfterDays! - ageDays).sort((a, b) => a - b);
    return { days, n: days.length, level: hit.level };
  }

  median(courier: string | null, city: string | null): number | null {
    const r = this.remaining(courier, city);
    return r ? quantile(r.days, 0.5) : null;
  }
}
