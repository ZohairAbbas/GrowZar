/**
 * Orders in another currency, in the store's (rule #4, G-FIN2-1). Pure.
 *
 * Each money field of an order converts at the rate for the order's own
 * local day, before anything is added up, so every total, card and list
 * built from the orders agrees. The order keeps its own `currency`: that is
 * how an international order is still recognised and left out of return
 * rates. A field with no rate for its day stays in its own currency, and
 * totals then list it beside the converted total, as before.
 */
import { convertOne, type FxRate, type FxSource } from "./fx";
import { formatAmount, parseAmount, type Money } from "./money";
import type { RollupOrder } from "./rollups";

export function convertOrder(o: RollupOrder, base: string, source: FxSource): RollupOrder {
  const one = (m: Money | null) => (m && m.currency !== base ? (convertOne(m, base, o.localDay, source)?.money ?? m) : m);
  return {
    ...o,
    placed: one(o.placed),
    delivered: one(o.delivered),
    refunded: one(o.refunded),
    collected: one(o.collected),
    uncollected: one(o.uncollected),
    cogs: one(o.cogs),
    courierFee: one(o.courierFee),
    lines: o.lines.map((l) => ({ ...l, value: one(l.value), cost: one(l.cost) })),
  };
}

export type FxReport = {
  base: string;
  /** The earliest day the source has any rate for this base, if any. */
  ratesFrom: string | null;
  /** Orders in another currency that converted, per currency. */
  converted: Array<{ currency: string; orders: number; placed: Money; rates: FxRate[] }>;
  /** Orders whose day has no rate, per currency, with the days. */
  unconverted: Array<{ currency: string; orders: number; placed: Money; days: string[] }>;
};

/** What happened to the period's foreign orders. Null when there were none. */
export function fxReport(rows: readonly RollupOrder[], base: string, source: FxSource, ratesFrom: string | null): FxReport | null {
  const foreign = rows.filter((o) => o.placed && o.placed.currency !== base);
  if (!foreign.length) return null;
  const conv = new Map<string, { orders: number; units: bigint; rates: Map<string, FxRate> }>();
  const unconv = new Map<string, { orders: number; units: bigint; days: Set<string> }>();
  for (const o of foreign) {
    const m = o.placed!;
    const units = parseAmount(m.amount) ?? 0n;
    const done = convertOne(m, base, o.localDay, source);
    if (done?.rate) {
      const e = conv.get(m.currency) ?? { orders: 0, units: 0n, rates: new Map() };
      e.orders += 1;
      e.units += units;
      e.rates.set(done.rate.day, done.rate);
      conv.set(m.currency, e);
    } else {
      const e = unconv.get(m.currency) ?? { orders: 0, units: 0n, days: new Set() };
      e.orders += 1;
      e.units += units;
      if (o.localDay) e.days.add(o.localDay);
      unconv.set(m.currency, e);
    }
  }
  const sorted = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    base,
    ratesFrom,
    converted: sorted(conv).map(([currency, e]) => ({
      currency,
      orders: e.orders,
      placed: { amount: formatAmount(e.units), currency },
      rates: [...e.rates.values()].sort((a, b) => a.day.localeCompare(b.day)),
    })),
    unconverted: sorted(unconv).map(([currency, e]) => ({
      currency,
      orders: e.orders,
      placed: { amount: formatAmount(e.units), currency },
      days: [...e.days].sort(),
    })),
  };
}
