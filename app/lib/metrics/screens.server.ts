import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { localDayOf, type Outcome } from "./order-grain";
import { bucketOf, byCity, byCourier, courierTiming, rollup, type Bucket, type DeliveryRate } from "./rollups";
import {
  MIN_DECIDED_TO_RATE,
  countDelta,
  dailyCount,
  dailyMoney,
  foldThinRows,
  moneyDelta,
  rateDelta,
  weeklyDistinct,
  whenCovered,
  whenSettled,
  weeklyRate,
  type Delta,
  type Trend,
} from "./compare";
import { scopeWhere, type Scope } from "./scope";
import { storeSummary, type StoreSummary } from "./summaries.server";
import { formatAmount, parseAmount, type Money } from "./money";
import { matchesFilter, orderFilterQuery, type OrderFilter } from "./findings";
import { toRollupOrder } from "./rollups.server";
import { loadPayerHistories } from "./settlements.server";
import { MIN_TIMED_PARCELS_PER_COURIER } from "../shipments/events";

/**
 * View models for the read-only screens (G-GZR2-5).
 *
 * Every number here comes from `storeSummary` or the order grain — the same
 * layer Phase 3's detectors will read — so a screen cannot disagree with an
 * insight about the same figure. Nothing below adds up source rows.
 *
 * Periods are the store's own local days (rule #5), ending today.
 */

export const PERIODS = [7, 30, 60, 90] as const;
export type PeriodDays = (typeof PERIODS)[number];

export function periodFrom(url: URL, timezone: string | null, at: Date = new Date()) {
  const asked = Number(url.searchParams.get("days"));
  const days: PeriodDays = (PERIODS as readonly number[]).includes(asked) ? (asked as PeriodDays) : 30;
  const tz = timezone ?? "UTC";
  const now = at.getTime();
  return {
    days,
    from: localDayOf(new Date(now - (days - 1) * 86_400_000), tz),
    to: localDayOf(new Date(now), tz),
    timezone: tz,
    timezoneKnown: timezone !== null,
  };
}

const SHIPPED = ["delivered", "returned", "partially_delivered", "in_transit"];

type Coverage = { shippedOrders: number; withParcel: number; degraded: boolean };

function coverage(s: StoreSummary): Coverage {
  const { shippedOrders, withParcel } = s.courierifyCoverage;
  // Below half is where a store has, in effect, stopped booking through
  // Courierify (0dscam-qn: 92% in August, 0% in September).
  return { shippedOrders, withParcel, degraded: shippedOrders > 0 && withParcel / shippedOrders < 0.5 };
}

/**
 * A headline number with its comparison and trend (D2). `good` is which way
 * is better for the merchant, so a screen can colour the change without
 * knowing what the number is.
 */
export type Headline = { delta: Delta; trend: Trend | null; good: "up" | "down" };

const headline = (delta: Delta, trend: Trend | null, good: "up" | "down" = "up"): Headline => ({ delta, trend, good });

// ── Home: the funnel strip ─────────────────────────────────────────────────

export type HomeView = {
  funnel: Array<{ label: string; count: number | null; note?: string }>;
  deliveryRate: DeliveryRate;
  coverage: Coverage;
  /** Delivered orders per local day the order was placed on, oldest first. */
  daily: Array<{ day: string; delivered: number }>;
  /** Null for a role that may not see Finance: Home then shows counts only. */
  money: {
    deliveredRevenue: Money[];
    profit: StoreSummary["profit"];
  } | null;
  /** The store's currency (it leads), and what happened to orders in others. */
  base: string | null;
  fx: StoreSummary["fx"];
  compare: { delivered: Headline; deliveryRate: Headline; profit: Headline | null };
};

/**
 * COD a courier still owes as of today, whatever the order date: delivered
 * Courierify parcels no settlement covers yet. The same rows I4 reads, before
 * it judges which payers are late, so Home and the insight never disagree on
 * what is outstanding.
 */
export async function owedToday(storeId: string): Promise<{ amounts: Money[]; orders: number }> {
  const groups = await prisma.orderGrain.groupBy({
    by: ["uncollectedCurrency"],
    where: { storeId, outcome: "delivered", parcelCount: { gt: 0 }, uncollectedAmount: { gt: 0 } },
    _sum: { uncollectedAmount: true },
    _count: { _all: true },
  });
  return {
    amounts: groups
      .filter((g) => g.uncollectedCurrency && g._sum.uncollectedAmount)
      .map((g) => ({ amount: g._sum.uncollectedAmount!.toString(), currency: g.uncollectedCurrency! })),
    orders: groups.reduce((n, g) => n + g._count._all, 0),
  };
}

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export function homeView(s: StoreSummary, prev: StoreSummary, canSeeMoney: boolean): HomeView {
  const rows = s.rows;
  const deliveredByDay = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome === "delivered" && r.localDay) deliveredByDay.set(r.localDay, (deliveredByDay.get(r.localDay) ?? 0) + 1);
  }
  const anyConfirmation = rows.some((r) => r.confirmation);
  return {
    funnel: [
      { label: "Orders", count: rows.length },
      {
        label: "Confirmed",
        count: anyConfirmation ? rows.filter((r) => r.confirmation === "confirmed").length : null,
        note: anyConfirmation ? undefined : "no confirmations from Courierify in this period",
      },
      { label: "Shipped", count: rows.filter((r) => SHIPPED.includes(r.outcome)).length },
      { label: "Delivered", count: s.orders.deliveryRate.delivered },
      { label: "Returned", count: s.orders.deliveryRate.returned },
      { label: "Collected", count: rows.filter((r) => r.collected).length, note: "paid by courier" },
    ],
    deliveryRate: s.orders.deliveryRate,
    coverage: coverage(s),
    daily: eachDay(s.period.from, s.period.to).map((day) => ({ day, delivered: deliveredByDay.get(day) ?? 0 })),
    money: canSeeMoney
      ? {
          deliveredRevenue: s.orders.deliveredRevenue,
          profit: s.profit,
        }
      : null,
    base: s.store.currency,
    fx: canSeeMoney ? s.fx : null,
    compare: {
      delivered: canSeeMoney
        ? headline(settled(moneyDelta(s.orders.deliveredRevenue, prev.orders.deliveredRevenue, s.store.currency), s, prev), dailyMoney(rows, s.period.from, s.period.to, s.store.currency, (o) => (o.outcome === "delivered" ? o.delivered : null)))
        : headline(settled(countDelta(s.orders.deliveryRate.delivered, prev.orders.deliveryRate.delivered), s, prev), dailyCount(rows, s.period.from, s.period.to, (o) => o.outcome === "delivered")),
      deliveryRate: headline(rateDelta(s.orders.deliveryRate, prev.orders.deliveryRate), weeklyRate(rows, s.period.from, s.period.to)),
      profit: canSeeMoney && s.profit ? headline(settled(moneyDelta(profitMoney(s), profitMoney(prev), s.store.currency), s, prev), null) : null,
    },
  };
}

const maturity = (s: StoreSummary) => ({ orders: s.orders.orders, stillOpen: s.orders.deliveryRate.stillOpen });
/** An outcome-dependent delta, withdrawn while either period is still settling. */
const settled = (d: Delta, s: StoreSummary, prev: StoreSummary) => whenSettled(d, maturity(s), maturity(prev));
const feeCoverage = (s: StoreSummary) => ({ have: s.orders.shippedOrders - s.orders.shippedOrdersWithoutFee, of: s.orders.shippedOrders });
const cogsCoverage = (s: StoreSummary) => ({ have: s.orders.deliveryRate.delivered - s.orders.cogsIncompleteOrders, of: s.orders.deliveryRate.delivered });

const profitMoney = (s: StoreSummary) => (s.profit ? { amount: s.profit.amount, currency: s.profit.currency } : null);

// ── Finance: rules #4, #13–17 ──────────────────────────────────────────────

export type FinanceView = {
  placed: Money[];
  deliveredRevenue: Money[];
  paidByCourier: Money[];
  refunded: Money[];
  cogsDelivered: Money[];
  cogsIncompleteOrders: number;
  courierFees: Money[];
  shippedOrders: number;
  shippedOrdersWithoutFee: number;
  adSpend: StoreSummary["adSpend"];
  profit: StoreSummary["profit"];
  roas: number | null;
  /** Orders with no outcome yet: their revenue arrives when they deliver. */
  stillOpen: number;
  settings: StoreSummary["settings"];
  base: string | null;
  fx: StoreSummary["fx"];
  /** Set when a courier or city is picked: ad spend is store-wide and left out. */
  scoped: boolean;
  compare: Record<"placed" | "deliveredRevenue" | "paidByCourier" | "cogsDelivered" | "courierFees" | "adSpend" | "profit", Headline>;
};

export function financeView(s: StoreSummary, prev: StoreSummary): FinanceView {
  const b = s.orders;
  const p = prev.orders;
  const cur = s.store.currency;
  const { from, to } = s.period;
  const money = (pick: (o: StoreSummary["rows"][number]) => Money | null) => dailyMoney(s.rows, from, to, cur, pick);
  return {
    placed: b.placed,
    deliveredRevenue: b.deliveredRevenue,
    paidByCourier: b.collected,
    refunded: b.refunded,
    cogsDelivered: b.cogsDelivered,
    cogsIncompleteOrders: b.cogsIncompleteOrders,
    courierFees: b.courierFees,
    shippedOrders: b.shippedOrders,
    shippedOrdersWithoutFee: b.shippedOrdersWithoutFee,
    adSpend: s.adSpend,
    profit: s.profit,
    roas: s.roas,
    stillOpen: b.deliveryRate.stillOpen,
    settings: s.settings,
    base: s.store.currency,
    fx: s.fx,
    scoped: s.scope.courier !== null || s.scope.city !== null,
    compare: {
      placed: headline(moneyDelta(b.placed, p.placed, cur), money((o) => o.placed)),
      deliveredRevenue: headline(settled(moneyDelta(b.deliveredRevenue, p.deliveredRevenue, cur), s, prev), money((o) => (o.outcome === "delivered" ? o.delivered : null))),
      paidByCourier: headline(settled(moneyDelta(b.collected, p.collected, cur), s, prev), money((o) => o.collected)),
      cogsDelivered: headline(
        whenCovered(settled(moneyDelta(b.cogsDelivered, p.cogsDelivered, cur), s, prev), "Product cost", cogsCoverage(s), cogsCoverage(prev)),
        null,
        "down",
      ),
      courierFees: headline(whenCovered(moneyDelta(b.courierFees, p.courierFees, cur), "Courier fees", feeCoverage(s), feeCoverage(prev)), null, "down"),
      adSpend: headline(moneyDelta(s.adSpend?.spend ?? null, prev.adSpend?.spend ?? null, cur), null, "down"),
      profit: headline(
        whenCovered(
          whenCovered(settled(moneyDelta(profitMoney(s), profitMoney(prev), cur), s, prev), "Courier fees", feeCoverage(s), feeCoverage(prev)),
          "Product cost",
          cogsCoverage(s),
          cogsCoverage(prev),
        ),
        null,
      ),
    },
  };
}

// ── Orders: rules #1, #6–11, #21, #25 ──────────────────────────────────────

export type OrderRow = {
  orderId: string;
  orderName: string | null;
  localDay: string | null;
  placed: Money | null;
  outcome: string;
  authority: string;
  timing: { basis: string; at: string } | null;
  confirmation: string | null;
  courier: string | null;
  city: string | null;
  refunded: Money | null;
  orderCancelled: boolean;
  shipmentCancelled: boolean;
};

export type OrdersView = {
  total: number;
  byOutcome: Array<{ outcome: string; count: number }>;
  rows: OrderRow[];
  shown: number;
  /** Set when the list is a finding's evidence (G-GZR3-1). */
  filter: OrderFilter | null;
  /** The filter as a query string, so outcome links keep it. Empty when none. */
  filterQuery: string;
  /** One outcome picked from the chips, or null for every outcome. */
  outcome: Outcome | null;
  /** Orders before the outcome pick: what the "All" chip counts. */
  allTotal: number;
  /** Financify's own outcome per shown order, for the disagreement list. */
  financifySays: Record<string, string | null>;
  /** Orders in the period against the previous one, and per day (D2). */
  compare: Headline;
};

const LIST_LIMIT = 50;
/** A filtered list is a finding's evidence, so it shows more of it. */
const FILTERED_LIST_LIMIT = 200;

const ORDER_ROW_SELECT = {
  orderId: true, orderName: true, localDay: true, currency: true, placedAmount: true,
  outcome: true, outcomeAuthority: true, outcomeBasis: true, outcomeAt: true, confirmation: true,
  courier: true, city: true, refundedAmount: true, orderCancelled: true, shipmentCancelled: true,
} as const;

/** Every outcome a chip can pick (the grain's vocabulary). */
const OUTCOMES: readonly Outcome[] = [
  "delivered", "returned", "partially_delivered", "in_transit", "booked",
  "shipment_cancelled", "order_cancelled", "not_shipped", "unknown",
];

export function parseOutcome(params: URLSearchParams): Outcome | null {
  const asked = params.get("outcome");
  return (OUTCOMES as readonly string[]).includes(asked ?? "") ? (asked as Outcome) : null;
}

export async function ordersView(
  storeId: string,
  from: string,
  to: string,
  filter: OrderFilter | null = null,
  outcome: Outcome | null = null,
  scope: Scope = { courier: null, city: null },
  previous: { from: string; to: string } | null = null,
): Promise<OrdersView> {
  const where = { storeId, localDay: { gte: from, lte: to }, ...scopeWhere(scope) };
  // The comparison counts the same slice, before any outcome pick.
  const [prevTotal, perDay] = await Promise.all([
    previous ? prisma.orderGrain.count({ where: { storeId, localDay: { gte: previous.from, lte: previous.to }, ...scopeWhere(scope) } }) : Promise.resolve(null),
    prisma.orderGrain.groupBy({ by: ["localDay"], where, _count: { _all: true } }),
  ]);
  const days = new Map(perDay.map((d) => [d.localDay, d._count._all]));
  const trend = dailyCount([], from, to, () => false);
  if (trend) for (const p of trend.points) p.value = days.get(p.label) ?? 0;
  const filterQuery = filter ? orderFilterQuery(filter) : "";
  const money = (a: { toFixed(n: number): string } | null, c: string | null): Money | null =>
    a && c ? { amount: formatAmount(parseAmount(a.toFixed(6))!), currency: c } : null;
  type Row = Prisma.OrderGrainGetPayload<{ select: typeof ORDER_ROW_SELECT }>;
  const toRow = (r: Row): OrderRow => ({
    orderId: r.orderId,
    orderName: r.orderName,
    localDay: r.localDay,
    placed: money(r.placedAmount, r.currency),
    outcome: r.outcome,
    authority: r.outcomeAuthority,
    timing: r.outcomeBasis && r.outcomeAt ? { basis: r.outcomeBasis, at: r.outcomeAt.toISOString() } : null,
    confirmation: r.confirmation,
    courier: r.courier,
    city: r.city,
    refunded: money(r.refundedAmount, r.currency),
    orderCancelled: r.orderCancelled,
    shipmentCancelled: r.shipmentCancelled,
  });
  const countOutcomes = (outcomes: string[]) =>
    [...outcomes.reduce((m, o) => m.set(o, (m.get(o) ?? 0) + 1), new Map<string, number>())]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count);

  if (filter) {
    // The same predicate the Home card counted with, applied to the same
    // grain rows, so the list is exactly the card's evidence.
    const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { currency: true } });
    // Cash held is today's state (I4): any order date, so no period here.
    const cashFilter = filter.kind === "awaiting_payout";
    const all = await prisma.orderGrain.findMany({
      where: cashFilter ? { storeId, outcome: "delivered", uncollectedAmount: { not: null }, ...scopeWhere(scope) } : where,
      orderBy: [{ createdAt: "desc" }, { orderId: "desc" }],
    });
    const ctx = { payers: cashFilter ? await loadPayerHistories(storeId) : [], asOf: new Date() };
    const hit = all.filter((r) => matchesFilter(toRollupOrder(r), filter, store.currency, ctx));
    const picked = outcome ? hit.filter((r) => r.outcome === outcome) : hit;
    const shown = picked.slice(0, FILTERED_LIST_LIMIT);
    return {
      total: picked.length,
      allTotal: hit.length,
      byOutcome: countOutcomes(hit.map((r) => r.outcome)),
      rows: shown.map(toRow),
      shown: shown.length,
      filter,
      filterQuery,
      outcome,
      financifySays: Object.fromEntries(shown.map((r) => [r.orderId, r.financifyOutcome])),
      compare: headline(countDelta(hit.length, null), null),
    };
  }

  const picked = outcome ? { ...where, outcome } : where;
  const [total, groups, latest] = await Promise.all([
    prisma.orderGrain.count({ where: picked }),
    prisma.orderGrain.groupBy({ by: ["outcome"], where, _count: { _all: true } }),
    prisma.orderGrain.findMany({
      where: picked,
      orderBy: [{ createdAt: "desc" }, { orderId: "desc" }],
      take: LIST_LIMIT,
      select: ORDER_ROW_SELECT,
    }),
  ]);
  return {
    total,
    allTotal: groups.reduce((sum, g) => sum + g._count._all, 0),
    byOutcome: groups.map((g) => ({ outcome: g.outcome, count: g._count._all })).sort((a, b) => b.count - a.count),
    rows: latest.map(toRow),
    shown: latest.length,
    filter: null,
    filterQuery,
    outcome,
    financifySays: {},
    compare: headline(countDelta(groups.reduce((sum, g) => sum + g._count._all, 0), prevTotal), trend),
  };
}

// ── Shipping: rules #7–12 ───────────────────────────────────────────────────

export type BreakdownRow = {
  /** The roll-up key, which is also the filter value; "other" for folded rows. */
  key: string;
  orders: number;
  deliveryRate: DeliveryRate;
  /** For the folded row: how many rows it holds. */
  folded?: number;
};

export type ShippingView = {
  deliveryRate: DeliveryRate;
  returnedValue: Money[];
  couriers: Array<BreakdownRow & { timing: string }>;
  cities: BreakdownRow[];
  /** Cities with orders in the period, before folding. */
  cityCount: number;
  coverage: Coverage;
  minDecided: number;
  compare: { deliveryRate: Headline; returnedValue: Headline; returned: Headline };
};

/** Rows under MIN_DECIDED_TO_RATE decided orders become one "other" row (pack §2.5). */
function folded(buckets: Bucket[], rows: StoreSummary["rows"]): BreakdownRow[] {
  const byId = new Map(rows.map((o) => [o.orderId, o]));
  const out = foldThinRows(buckets, MIN_DECIDED_TO_RATE, (thin) =>
    bucketOf("other", thin.flatMap((t) => t.orderIds.map((id) => byId.get(id)!))),
  );
  return out.rows.map((b, i) => ({
    key: b.key,
    orders: b.orders,
    deliveryRate: b.deliveryRate,
    // The fold is always last.
    ...(out.folded && i === out.rows.length - 1 ? { folded: out.folded } : {}),
  }));
}

/**
 * Never "slow" (G-GZR3-2). Why a courier has no times is the coverage page's
 * to say (D1); the table states only the sample it has.
 */
function timingReason(t: Extract<ReturnType<typeof courierTiming>[number], { verdict: "not_enough_data" }>): string {
  return t.reason === "too_few_parcels" ? `${t.timedOrders} timed, needs ${MIN_TIMED_PARCELS_PER_COURIER}` : "—";
}

export function shippingView(s: StoreSummary, prev: StoreSummary): ShippingView {
  const timing = new Map(courierTiming(s.rows).map((t) => [t.courier, t]));
  const cities = rollup(s.rows, byCity);
  return {
    deliveryRate: s.orders.deliveryRate,
    returnedValue: s.orders.returnedValue,
    couriers: folded(rollup(s.rows, byCourier), s.rows).map((b) => {
      const t = timing.get(b.key);
      return {
        ...b,
        timing: !t
          ? "—"
          : t.verdict === "ok"
            ? `${t.medianDaysToDeliver.toFixed(1)} days (median, ${t.timedOrders} timed)`
            : timingReason(t),
      };
    }),
    cities: folded(cities, s.rows),
    cityCount: cities.length,
    coverage: coverage(s),
    minDecided: MIN_DECIDED_TO_RATE,
    compare: {
      deliveryRate: headline(rateDelta(s.orders.deliveryRate, prev.orders.deliveryRate), weeklyRate(s.rows, s.period.from, s.period.to)),
      returnedValue: headline(settled(moneyDelta(s.orders.returnedValue, prev.orders.returnedValue, s.store.currency), s, prev), null, "down"),
      returned: headline(settled(countDelta(s.orders.deliveryRate.returned, prev.orders.deliveryRate.returned), s, prev), dailyCount(s.rows, s.period.from, s.period.to, (o) => o.outcome === "returned"), "down"),
    },
  };
}

// ── Customers: rules #19, #20, #22 ─────────────────────────────────────────

export type CustomersView = {
  customers: number;
  buyersInPeriod: number;
  repeatBuyers: number;
  compare: { buyers: Headline; repeatShare: Headline };
  top: Array<{
    customerId: string;
    name: string | null;
    /** Last four digits of the buyer's phone, for a buyer with no name. */
    phoneTail: string | null;
    orders: number;
    deliveryRate: DeliveryRate;
    deliveredRevenue: Money[];
  }>;
};

/**
 * Buyers are Growzar's own customer record (rule #19): one person however
 * they spell their number. Lifetime figures (rule #20) come from every order
 * in the grain, not just the period's.
 */
export async function customersView(storeId: string, s: StoreSummary, prev: StoreSummary): Promise<CustomersView> {
  const inPeriod = new Set(s.rows.map((r) => r.customerId).filter((c): c is string => !!c));
  const inPrev = new Set(prev.rows.map((r) => r.customerId).filter((c): c is string => !!c));
  // Orders up to each period's end, so the previous period's repeat share is
  // what it was then, not what it is now.
  const history = await prisma.orderGrain.findMany({
    where: { storeId, customerId: { in: [...new Set([...inPeriod, ...inPrev])] } },
    select: { customerId: true, localDay: true },
  });
  const ordersBy = (to: string) => {
    const m = new Map<string, number>();
    for (const r of history) if (r.localDay && r.localDay <= to) m.set(r.customerId!, (m.get(r.customerId!) ?? 0) + 1);
    return m;
  };
  const lifetimeOrders = ordersBy(s.period.to);
  const prevOrders = ordersBy(prev.period.to);
  const repeat = [...inPeriod].filter((c) => (lifetimeOrders.get(c) ?? 0) >= 2).length;
  const prevRepeat = [...inPrev].filter((c) => (prevOrders.get(c) ?? 0) >= 2).length;
  const share = (n: number, d: number) => (d >= MIN_DECIDED_TO_RATE ? Math.round((1000 * n) / d) / 10 : null);
  const repeatShare = share(repeat, inPeriod.size);
  const prevShare = share(prevRepeat, inPrev.size);

  const buckets = rollup(s.rows.filter((r) => r.customerId), (r) => [r.customerId!]);
  const top = buckets
    .sort((a, b) => b.deliveryRate.delivered - a.deliveryRate.delivered || b.orders - a.orders)
    .slice(0, 10);
  const people = await prisma.customer.findMany({
    where: { id: { in: top.map((b) => b.key) } },
    select: { id: true, displayName: true, identities: { where: { kind: "PHONE" }, select: { value: true }, take: 1 } },
  });
  const names = new Map(people.map((c) => [c.id, c.displayName]));
  const tails = new Map(people.map((c) => [c.id, c.identities[0]?.value.replace(/\D/g, "").slice(-4) || null]));

  return {
    customers: await prisma.customer.count({ where: { storeId, mergedIntoId: null } }),
    buyersInPeriod: inPeriod.size,
    repeatBuyers: repeat,
    compare: {
      buyers: headline(countDelta(inPeriod.size, inPrev.size), weeklyDistinct(s.rows, s.period.from, s.period.to, (o) => o.customerId)),
      repeatShare: headline(
        {
          current: repeatShare,
          previous: prevShare,
          change: repeatShare !== null && prevShare !== null ? Math.round((repeatShare - prevShare) * 10) / 10 : null,
          direction: repeatShare === null || prevShare === null ? null : repeatShare > prevShare ? "up" : repeatShare < prevShare ? "down" : "flat",
          unit: "points",
        },
        null,
      ),
    },
    top: top.map((b) => ({
      customerId: b.key,
      name: names.get(b.key) ?? null,
      phoneTail: tails.get(b.key) ?? null,
      orders: b.orders,
      deliveryRate: b.deliveryRate,
      deliveredRevenue: b.deliveredRevenue,
    })),
  };
}

