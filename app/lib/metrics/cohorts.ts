/**
 * Cohort retention and the repeat-purchase curve (Phase 4b, D3). Pure.
 *
 * Buyers are Growzar's own customer record (rule #19): one person however
 * they wrote their number. Only **delivered** orders count, for the first
 * order and for every later one: a parcel that came back is not a purchase.
 *
 * "First" means first in the history Growzar holds for the store. A buyer
 * who bought before that history starts is counted as new in its first
 * month, which is why the screen states when the history starts.
 */

import { formatAmount } from "./money";

/** Buyers a cohort needs before its cells show a share. */
export const MIN_COHORT_BUYERS = 20;
/** Buyers a repeat-curve point needs before it is drawn. */
export const MIN_ELIGIBLE_BUYERS = 20;
export const REPEAT_WINDOWS = [7, 14, 30, 45, 60, 90] as const;

export type DeliveredOrder = {
  customerId: string;
  localDay: string;
  /** Delivered revenue in the store's currency, millionths; null in another currency. */
  revenue?: bigint | null;
  /** Product cost in the store's currency, millionths; null when not fully costed. */
  cost?: bigint | null;
};

/** Share of a cell's delivered revenue that must carry a product cost before it shows a gross profit. */
export const MIN_COSTED_REVENUE_SHARE = 0.9;

/** What a cohort's buyers spent in one month after their first (offset 0 is the first month itself). */
export type CohortMoneyCell = {
  offset: number;
  /** Decimal string, store currency. */
  revenue: string;
  /** Revenue less product cost over the costed orders; null under MIN_COSTED_REVENUE_SHARE. */
  profit: string | null;
  partial: boolean;
};

export type CohortMoney = {
  cells: CohortMoneyCell[];
  revenue: string;
  profit: string | null;
  /** Revenue ÷ the cohort's buyers. */
  perBuyer: string;
};

export type CohortCell = {
  /** Months after the cohort's first month, from 1. */
  offset: number;
  /** Buyers from the cohort with a delivered order in that month. */
  buyers: number;
  /** buyers ÷ cohort size, percent with one decimal; null on a thin cohort. */
  share: number | null;
  /** The month is the current one, so still filling. */
  partial: boolean;
};

export type CohortRow = {
  /** YYYY-MM of the buyers' first delivered order. */
  month: string;
  buyers: number;
  /** The first month is the one history starts in, so it began mid-month. */
  partialFirstMonth: boolean;
  cells: CohortCell[];
  /** Null when no order carries revenue in the store's currency. */
  money: CohortMoney | null;
};

export type RepeatPoint = {
  days: number;
  /** Buyers whose first delivered order is at least `days` old. */
  eligible: number;
  /** Of those, how many had a second delivered order on a later day within `days`. */
  repeated: number;
  share: number | null;
};

export type Retention = {
  historyFrom: string | null;
  asOf: string;
  buyers: number;
  cohorts: CohortRow[];
  maxOffset: number;
  repeat: RepeatPoint[];
  /** Median days from first to second delivered order, among buyers with one; null under the minimum. */
  medianDaysToSecond: number | null;
  secondOrders: number;
  /** Delivered orders left out of the money views for being in another currency. */
  otherCurrencyOrders: number;
  /** The currency of the money views; null without them. */
  currency: string | null;
  /** Percent of all delivered revenue with a product cost; null without revenue. */
  costedRevenueShare: number | null;
};

const monthOf = (day: string) => day.slice(0, 7);
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const atDay = (d: string) => Date.parse(`${d}T00:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((atDay(b) - atDay(a)) / 86_400_000);
const pct = (n: number, d: number) => Math.round((1000 * n) / d) / 10;

/**
 * Follow `mergedIntoId` to the surviving record, so two records later found
 * to be one person count once.
 */
export function resolveBuyer(id: string, mergedInto: ReadonlyMap<string, string>): string {
  let at = id;
  for (let hops = 0; hops < 10 && mergedInto.has(at); hops++) at = mergedInto.get(at)!;
  return at;
}

export function retention(orders: readonly DeliveredOrder[], asOf: string, historyFrom: string | null): Retention {
  const days = new Map<string, string[]>();
  for (const o of orders) {
    const list = days.get(o.customerId);
    if (list) list.push(o.localDay);
    else days.set(o.customerId, [o.localDay]);
  }
  for (const list of days.values()) list.sort();

  const nowMonth = monthIndex(monthOf(asOf));
  const byCohort = new Map<string, Array<Set<number>>>();
  for (const list of days.values()) {
    const first = monthOf(list[0]!);
    const offsets = new Set(list.slice(1).map((d) => monthIndex(monthOf(d)) - monthIndex(first)).filter((n) => n > 0));
    const members = byCohort.get(first) ?? [];
    members.push(offsets);
    byCohort.set(first, members);
  }

  // Money per cohort × month offset, offset 0 included.
  type Sum = { revenue: bigint; costedRevenue: bigint; cost: bigint };
  const firstMonth = new Map([...days.entries()].map(([id, list]) => [id, monthOf(list[0]!)]));
  const sums = new Map<string, Map<number, Sum>>();
  let otherCurrencyOrders = 0;
  let allRevenue = 0n;
  let allCosted = 0n;
  for (const o of orders) {
    if (o.revenue === undefined) continue;
    if (o.revenue === null) {
      otherCurrencyOrders += 1;
      continue;
    }
    const first = firstMonth.get(o.customerId)!;
    const offset = monthIndex(monthOf(o.localDay)) - monthIndex(first);
    const row = sums.get(first) ?? new Map<number, Sum>();
    const sum = row.get(offset) ?? { revenue: 0n, costedRevenue: 0n, cost: 0n };
    sum.revenue += o.revenue;
    allRevenue += o.revenue;
    if (o.cost !== null && o.cost !== undefined) {
      allCosted += o.revenue;
      sum.costedRevenue += o.revenue;
      sum.cost += o.cost;
    }
    row.set(offset, sum);
    sums.set(first, row);
  }
  const profitOf = (x: Sum) =>
    x.revenue > 0n && Number(x.costedRevenue) >= MIN_COSTED_REVENUE_SHARE * Number(x.revenue) ? formatAmount(x.costedRevenue - x.cost) : null;
  const moneyOf = (month: string, span: number, buyers: number): CohortMoney | null => {
    const row = sums.get(month);
    if (!row) return null;
    const empty: Sum = { revenue: 0n, costedRevenue: 0n, cost: 0n };
    const total = { ...empty };
    const cells = Array.from({ length: span + 1 }, (_, offset) => {
      const x = row.get(offset) ?? empty;
      total.revenue += x.revenue;
      total.costedRevenue += x.costedRevenue;
      total.cost += x.cost;
      return { offset, revenue: formatAmount(x.revenue), profit: x.revenue ? profitOf(x) : "0.00", partial: offset === span };
    });
    return { cells, revenue: formatAmount(total.revenue), profit: profitOf(total), perBuyer: formatAmount(total.revenue / BigInt(Math.max(1, buyers))) };
  };

  let maxOffset = 0;
  const cohorts: CohortRow[] = [...byCohort.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, members]) => {
      const span = nowMonth - monthIndex(month);
      maxOffset = Math.max(maxOffset, span);
      const thin = members.length < MIN_COHORT_BUYERS;
      return {
        month,
        buyers: members.length,
        partialFirstMonth: historyFrom !== null && monthOf(historyFrom) === month && historyFrom.slice(8) !== "01",
        cells: Array.from({ length: span }, (_, i) => {
          const offset = i + 1;
          const buyers = members.filter((m) => m.has(offset)).length;
          return { offset, buyers, share: thin ? null : pct(buyers, members.length), partial: offset === span };
        }),
        money: moneyOf(month, span, members.length),
      };
    });

  // Repeat curve: right-censored, so a buyer counts toward a window only once
  // they have had that long to come back.
  const firstAndSecond = [...days.values()].map((list) => ({
    first: list[0]!,
    second: list.find((d) => d > list[0]!) ?? null,
  }));
  const repeat = REPEAT_WINDOWS.map((window) => {
    const eligible = firstAndSecond.filter((b) => daysBetween(b.first, asOf) >= window);
    const repeated = eligible.filter((b) => b.second && daysBetween(b.first, b.second) <= window).length;
    return {
      days: window,
      eligible: eligible.length,
      repeated,
      share: eligible.length >= MIN_ELIGIBLE_BUYERS ? pct(repeated, eligible.length) : null,
    };
  });

  const gaps = firstAndSecond
    .filter((b) => b.second)
    .map((b) => daysBetween(b.first, b.second!))
    .sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return {
    historyFrom,
    asOf,
    buyers: days.size,
    cohorts,
    maxOffset,
    repeat,
    medianDaysToSecond:
      gaps.length >= MIN_ELIGIBLE_BUYERS ? (gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2) : null,
    secondOrders: gaps.length,
    otherCurrencyOrders,
    currency: null,
    costedRevenueShare: allRevenue > 0n ? Number((1000n * allCosted) / allRevenue) / 10 : null,
  };
}
