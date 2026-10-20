/**
 * The cash forecast (G-GZR11-2, pack §5.3 as changed by §10 P11-5/P11-6).
 * Pure.
 *
 * Two parts, because on the pilot stores most payout timing is not measured:
 *
 * 1. **COD becoming due**: each open order with a Courierify parcel is
 *    delivered or returned at its courier × city odds for its age, on a day
 *    drawn from the delivery times of orders that took at least that long.
 *    Its COD is due the day it is delivered.
 * 2. **Payouts**: due COD (and COD already delivered but unpaid) is paid a
 *    lag after delivery: drawn from the payer's measured cycle, or the
 *    merchant's own lag (labelled their estimate), or, with neither, shown
 *    apart as "payout timing unknown".
 *
 * Open orders without a Courierify parcel (booked through a 3PL Courierify
 * does not see, or Financify-only) have no delivery time to track, so they
 * are listed with their expected COD but no week.
 *
 * Ranges come from SIMULATIONS seeded runs. Each run moves every order's
 * odds together by one draw of their sampling error, and each courier's
 * parcels together by one draw of its week-to-week spread in delivered share
 * and in days to delivery (`Spreads`): a bad week hits all of a courier's
 * parcels at once, and independent coin flips alone gave ranges far too
 * narrow (73% of payer-weeks inside low–high on 0dscam-qn).
 */

import { parseAmount, type Money } from "../metrics/money";
import type { RollupOrder } from "../metrics/rollups";
import type { Figure } from "./backtest";
import type { Parcel } from "./base.server";
import { courierKey, type DeliveryTimes, type OutcomeOdds, type Spreads } from "./outcome-odds";
import type { PayoutCycle } from "./payout-cycle";
import { DAY_MS, daysBetween, DEFAULT_SEED, rangeOf, rng, type Range } from "./stats";

export const WEEKS = 4;
export const SIMULATIONS = 1000;
const OPEN = new Set(["in_transit", "booked"]);

export type CashInput = {
  asOf: Date;
  currency: string | null;
  rows: readonly RollupOrder[];
  parcels: readonly Parcel[];
  odds: OutcomeOdds;
  deliveryTimes: DeliveryTimes;
  spreads: Spreads;
  payoutCycles: ReadonlyMap<string, PayoutCycle>;
};

export type CashOptions = {
  /** Days from delivered to paid, entered by the merchant for payers without a measured cycle (P11-5). */
  merchantLags?: ReadonlyMap<string, number>;
  simulations?: number;
  seed?: number;
};

export type Week = { from: string; to: string };
export type PayoutBasis = "measured" | "merchant" | "unknown";

export type PayerDue = { payer: string; orders: number; weeks: Range[]; total: Range };
export type PayerPaid = { payer: string; basis: PayoutBasis; weeks: Range[]; total: Range; reason: string | null };
export type Untimed = {
  payer: string;
  basis: PayoutBasis;
  reason: string | null;
  /** COD already delivered and unpaid: exact. */
  deliveredUnpaid: number;
  deliveredParcels: number;
  /** COD expected from parcels still on the way, delivered within the forecast weeks. */
  expected: Range;
};

export type CashForecast = {
  asOf: string;
  currency: string | null;
  weeks: Week[];
  due: { byPayer: PayerDue[]; weeks: Range[]; total: Range };
  paid: { byPayer: PayerPaid[]; weeks: Range[]; total: Range };
  /** Payers whose payout timing is not known: what they hold and what is coming. */
  untimed: Untimed[];
  /** Delivered unpaid COD older than anything the payer's measured cycle has taken. */
  overdue: Array<{ payer: string; amount: number; parcels: number }>;
  /** Open orders whose delivery can't be timed (no Courierify parcel, or no delivery times for it), with their expected COD. */
  notTracked: { orders: number; expected: Range };
  /** Open orders left out, and why. */
  excluded: { noOdds: number; otherCurrency: number };
  /** Which orders each part was built from, so a backtest can follow exactly those. */
  basis: { open: string[]; held: string[] };
};

const amountOf = (m: Money | null, currency: string | null): number | null => {
  if (!m || !currency || m.currency !== currency) return null;
  const units = parseAmount(m.amount);
  return units === null ? null : Number(units) / 1_000_000;
};

/** Standard normal by Box–Muller, from the seeded generator. */
const normal = (next: () => number) => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

const pick = <T>(xs: readonly T[], next: () => number) => xs[Math.floor(next() * xs.length)]!;

export function forecastCash(input: CashInput, { merchantLags = new Map(), simulations = SIMULATIONS, seed = DEFAULT_SEED }: CashOptions = {}): CashForecast {
  const { asOf, currency } = input;
  const day0 = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const weeks: Week[] = Array.from({ length: WEEKS }, (_, k) => ({
    from: new Date(day0 + 7 * k * DAY_MS).toISOString().slice(0, 10),
    to: new Date(day0 + (7 * k + 6) * DAY_MS).toISOString().slice(0, 10),
  }));
  const horizon = WEEKS * 7;
  const weekOf = (daysFromNow: number) => (daysFromNow < 0 ? 0 : Math.floor(daysFromNow / 7));

  const basisOf = (payer: string): { basis: PayoutBasis; reason: string | null } => {
    const c = input.payoutCycles.get(payer);
    if (c?.measured) return { basis: "measured", reason: null };
    if (merchantLags.has(payer)) return { basis: "merchant", reason: "your estimate" };
    return { basis: "unknown", reason: c?.reason ?? "no settlement has been recorded for its parcels" };
  };

  // COD per order from its Courierify parcels.
  const codByOrder = new Map<string, { amount: number; payer: string; otherCurrency: boolean }>();
  for (const p of input.parcels) {
    const a = amountOf(p.cod, currency);
    const e = codByOrder.get(p.orderId) ?? { amount: 0, payer: p.payer, otherCurrency: false };
    if (a === null && p.cod) e.otherCurrency = true;
    else if (a !== null) e.amount += a;
    codByOrder.set(p.orderId, e);
  }

  // A parcel delivered by asOf is held COD below, whatever its order reads as.
  const deliveredOrders = new Set(input.parcels.filter((p) => p.deliveredAt).map((p) => p.orderId));

  type Open = { orderId: string; payer: string; courier: string; amount: number; p: number; sd: number; days: number[] };
  const open: Open[] = [];
  const untracked: Array<{ amount: number; p: number; sd: number }> = [];
  const excluded = { noOdds: 0, otherCurrency: 0 };
  for (const o of input.rows) {
    if (!OPEN.has(o.outcome) || !o.createdAt || deliveredOrders.has(o.orderId)) continue;
    const age = Math.max(0, daysBetween(o.createdAt, asOf));
    const odds = input.odds.at(o.courier, o.city, age);
    if (!odds) {
      excluded.noOdds += 1;
      continue;
    }
    // Smoothed (one extra of each outcome) so odds of exactly 0 or 1 still carry their sampling error.
    const ps = (odds.pDelivered * odds.n + 1) / (odds.n + 2);
    const sd = Math.sqrt((ps * (1 - ps)) / odds.n);
    const cod = codByOrder.get(o.orderId);
    if (o.parcelCount > 0 && cod) {
      if (cod.otherCurrency) excluded.otherCurrency += 1;
      if (cod.amount <= 0) continue;
      const days = input.deliveryTimes.remaining(o.courier, o.city, age)?.days;
      if (days) open.push({ orderId: o.orderId, payer: cod.payer, courier: courierKey(o.courier), amount: cod.amount, p: odds.pDelivered, sd, days });
      else untracked.push({ amount: cod.amount, p: odds.pDelivered, sd });
    } else {
      const placed = amountOf(o.placed, currency);
      if (placed === null) excluded.otherCurrency += 1;
      else if (placed > 0) untracked.push({ amount: placed, p: odds.pDelivered, sd });
    }
  }

  // COD already delivered and not paid by asOf.
  type Held = { orderId: string; payer: string; amount: number; ageDays: number };
  const held: Held[] = [];
  for (const p of input.parcels) {
    if (!p.deliveredAt || p.settledAt) continue;
    const a = amountOf(p.cod, currency);
    if (a && a > 0) held.push({ orderId: p.orderId, payer: p.payer, amount: a, ageDays: daysBetween(p.deliveredAt, asOf) });
  }

  const payers = [...new Set([...open.map((o) => o.payer), ...held.map((h) => h.payer)])].sort();
  const idx = new Map(payers.map((p, i) => [p, i]));
  const bases = new Map(payers.map((p) => [p, basisOf(p)]));

  // Lags still possible for held COD, and overdue COD (older than every measured lag).
  const overdue = new Map<string, { amount: number; parcels: number }>();
  const heldTimed: Array<{ i: number; amount: number; lags: number[] | null; fixed: number | null }> = [];
  const untimedHeld = new Map<string, { amount: number; parcels: number }>();
  for (const h of held) {
    const b = bases.get(h.payer)!;
    if (b.basis === "unknown") {
      const e = untimedHeld.get(h.payer) ?? { amount: 0, parcels: 0 };
      untimedHeld.set(h.payer, { amount: e.amount + h.amount, parcels: e.parcels + 1 });
    } else if (b.basis === "merchant") {
      heldTimed.push({ i: idx.get(h.payer)!, amount: h.amount, lags: null, fixed: Math.max(0, merchantLags.get(h.payer)! - h.ageDays) });
    } else {
      const rest = input.payoutCycles.get(h.payer)!.lags.filter((l) => l > h.ageDays).map((l) => l - h.ageDays);
      if (rest.length) heldTimed.push({ i: idx.get(h.payer)!, amount: h.amount, lags: rest, fixed: null });
      else {
        const e = overdue.get(h.payer) ?? { amount: 0, parcels: 0 };
        overdue.set(h.payer, { amount: e.amount + h.amount, parcels: e.parcels + 1 });
      }
    }
  }

  const P = payers.length;
  const dueDraws = Array.from({ length: P * WEEKS }, () => new Float64Array(simulations));
  const paidDraws = Array.from({ length: P * WEEKS }, () => new Float64Array(simulations));
  const untimedExpected = Array.from({ length: P }, () => new Float64Array(simulations));
  const untrackedDraws = new Float64Array(simulations);
  const next = rng(seed);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));

  const couriers = [...new Set(open.map((o) => o.courier))];
  const spreads = new Map(couriers.map((c) => [c, input.spreads.of(c) ?? { odds: 0, days: 0 }]));

  for (let s = 0; s < simulations; s++) {
    const z = normal(next);
    const shock = new Map(couriers.map((c) => [c, { odds: normal(next) * spreads.get(c)!.odds, days: normal(next) * spreads.get(c)!.days }]));
    for (const o of open) {
      const k = shock.get(o.courier)!;
      if (next() >= clamp(o.p + z * o.sd + k.odds)) continue;
      const d = Math.max(0, pick(o.days, next) + k.days);
      if (d >= horizon) continue;
      const i = idx.get(o.payer)!;
      dueDraws[i * WEEKS + weekOf(d)]![s]! += o.amount;
      const b = bases.get(o.payer)!;
      if (b.basis === "unknown") {
        untimedExpected[i]![s]! += o.amount;
        continue;
      }
      const lag = b.basis === "merchant" ? merchantLags.get(o.payer)! : pick(input.payoutCycles.get(o.payer)!.lags, next);
      if (d + lag < horizon) paidDraws[i * WEEKS + weekOf(d + lag)]![s]! += o.amount;
    }
    for (const h of heldTimed) {
      const lag = h.fixed ?? pick(h.lags!, next);
      if (lag < horizon) paidDraws[h.i * WEEKS + weekOf(lag)]![s]! += h.amount;
    }
    for (const u of untracked) if (next() < clamp(u.p + z * u.sd)) untrackedDraws[s]! += u.amount;
  }

  const sumRows = (draws: Float64Array[], rows: number[]) => {
    const out = new Float64Array(simulations);
    for (const r of rows) for (let s = 0; s < simulations; s++) out[s]! += draws[r]![s]!;
    return out;
  };
  const range = (d: Float64Array) => rangeOf(Array.from(d)) ?? { low: 0, likely: 0, high: 0 };
  const weekRows = (i: number) => Array.from({ length: WEEKS }, (_, k) => i * WEEKS + k);
  const allRows = (k: number) => payers.map((_, i) => i * WEEKS + k);
  const everything = payers.flatMap((_, i) => weekRows(i));

  return {
    asOf: asOf.toISOString(),
    currency,
    weeks,
    due: {
      byPayer: payers
        .map((payer, i) => ({
          payer,
          orders: open.filter((o) => o.payer === payer).length,
          weeks: weekRows(i).map((r) => range(dueDraws[r]!)),
          total: range(sumRows(dueDraws, weekRows(i))),
        }))
        .filter((p) => p.orders > 0),
      weeks: Array.from({ length: WEEKS }, (_, k) => range(sumRows(dueDraws, allRows(k)))),
      total: range(sumRows(dueDraws, everything)),
    },
    paid: {
      byPayer: payers
        .map((payer, i) => ({
          payer,
          ...bases.get(payer)!,
          weeks: weekRows(i).map((r) => range(paidDraws[r]!)),
          total: range(sumRows(paidDraws, weekRows(i))),
        }))
        .filter((p) => p.basis !== "unknown"),
      weeks: Array.from({ length: WEEKS }, (_, k) => range(sumRows(paidDraws, allRows(k)))),
      total: range(sumRows(paidDraws, everything)),
    },
    untimed: payers
      .filter((p) => bases.get(p)!.basis === "unknown")
      .map((payer) => ({
        payer,
        ...bases.get(payer)!,
        deliveredUnpaid: untimedHeld.get(payer)?.amount ?? 0,
        deliveredParcels: untimedHeld.get(payer)?.parcels ?? 0,
        expected: range(untimedExpected[idx.get(payer)!]!),
      })),
    overdue: [...overdue.entries()].map(([payer, e]) => ({ payer, ...e })).sort((a, b) => b.amount - a.amount),
    notTracked: { orders: untracked.length, expected: range(untrackedDraws) },
    excluded,
    basis: { open: open.map((o) => o.orderId), held: [...new Set(held.map((h) => h.orderId))] },
  };
}

export type CashGrain = "payer_week" | "store_week" | "payer_total";

/**
 * The forecast's figures for the backtest, keyed `due|payer|week` and
 * `paid|payer|week` (measured payers only); with `store_week` the payer is
 * `all`, with `payer_total` the week is `all`.
 */
export function cashFigures(f: CashForecast, grain: CashGrain = "payer_week"): Figure[] {
  const measured = f.paid.byPayer.filter((p) => p.basis === "measured");
  if (grain === "payer_total")
    return [...f.due.byPayer.map((p) => ({ key: `due|${p.payer}|all`, range: p.total })), ...measured.map((p) => ({ key: `paid|${p.payer}|all`, range: p.total }))];
  if (grain === "store_week")
    return [
      ...f.due.weeks.map((range, k) => ({ key: `due|all|${k}`, range })),
      ...(measured.length ? f.paid.weeks.map((range, k) => ({ key: `paid|all|${k}`, range })) : []),
    ];
  return [
    ...f.due.byPayer.flatMap((p) => p.weeks.map((range, k) => ({ key: `due|${p.payer}|${k}`, range }))),
    ...measured.flatMap((p) => p.weeks.map((range, k) => ({ key: `paid|${p.payer}|${k}`, range }))),
  ];
}

/** Actuals keyed `part|payer|week`, rolled up to the grain the figures use. */
export function rollUp(actual: ReadonlyMap<string, number>, grain: CashGrain): Map<string, number> {
  if (grain === "payer_week") return new Map(actual);
  const out = new Map<string, number>();
  for (const [key, v] of actual) {
    const [part, payer, week] = key.split("|");
    const k = grain === "store_week" ? `${part}|all|${week}` : `${part}|${payer}|all`;
    out.set(k, (out.get(k) ?? 0) + v);
  }
  return out;
}

/**
 * What then happened to the orders a forecast made at `f.asOf` was built
 * from, read from today's data: COD delivered, and COD paid, per payer and
 * week. Payments are counted only for payers whose cycle was measured then,
 * because only those were forecast by week.
 *
 * A delivery is dated by the order's outcome time when the courier or 3PL
 * timed it, the clock the delivery times were learned on, else by the
 * parcel's own delivered (or first seen delivered) time.
 */
export function cashActuals(f: CashForecast, now: { parcels: readonly Parcel[]; rows: readonly RollupOrder[] }, currency: string | null): Map<string, number> {
  const T = Date.parse(f.asOf);
  const day0 = Date.UTC(new Date(T).getUTCFullYear(), new Date(T).getUTCMonth(), new Date(T).getUTCDate());
  const weekOf = (d: Date) => {
    const k = Math.floor((d.getTime() - day0) / (7 * DAY_MS));
    return k >= 0 && k < WEEKS ? k : null;
  };
  const timedAt = new Map(
    now.rows
      .filter((o) => (o.outcome === "delivered" || o.outcome === "partially_delivered") && (o.outcomeTiming?.basis === "happened_on" || o.outcomeTiming?.basis === "reported_by_3pl"))
      .map((o) => [o.orderId, o.outcomeTiming!.at]),
  );
  const measured = new Set(f.paid.byPayer.filter((p) => p.basis === "measured").map((p) => p.payer));
  const open = new Set(f.basis.open);
  const held = new Set(f.basis.held);
  const out = new Map<string, number>();
  const add = (key: string, a: number) => out.set(key, (out.get(key) ?? 0) + a);
  for (const p of now.parcels) {
    const a = amountOf(p.cod, currency);
    if (!a || a <= 0 || !p.deliveredAt) continue;
    const deliveredBefore = p.deliveredAt.getTime() < day0;
    if (open.has(p.orderId) && !deliveredBefore) {
      const k = weekOf(timedAt.get(p.orderId) ?? p.deliveredAt);
      if (k !== null) add(`due|${p.payer}|${k}`, a);
    }
    if (!measured.has(p.payer) || !p.settledAt || !(open.has(p.orderId) || (held.has(p.orderId) && deliveredBefore))) continue;
    if (p.settledAt.getTime() < T) continue;
    const k = weekOf(p.settledAt);
    if (k !== null) add(`paid|${p.payer}|${k}`, a);
  }
  return out;
}
