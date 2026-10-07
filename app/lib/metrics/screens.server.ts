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
import { resolveBuyer, retention, type Retention } from "./cohorts";
import {
  channelCourierMatrix,
  cityCourierMatrix,
  type ChannelCourierMatrix,
  payoutAgeing,
  productEconomics,
  statusesOf,
  type CityCourierMatrix,
  type PayoutAgeing,
  type ProductPoint,
} from "./matrices";
import { loadAdSpend } from "./rollups.server";
import { campaignOutcomes, campaignSpend, storeColumn, type CampaignOutcomes, type CampaignSpend, type CampaignSpendRow, type StoreColumn } from "./campaigns";
import { loadAttribution, loadCampaignNames } from "./campaigns.server";
import { loadCourierNotes, loadParcelFacts } from "./returns.server";
import { loadCatalog, loadPaymentSplit, type CatalogEntry, type PaymentSplit } from "./products.server";
import { profitTable, type ProfitDimension, type ProfitTable } from "./profit-table";
import { previousPeriod } from "./compare";
import { convertDated } from "./fx";
import { loadFxSource } from "./fx.server";
import { storeSummary, type StoreSummary } from "./summaries.server";
import { formatAmount, parseAmount, sumByCurrency, type Money } from "./money";
import { matchesFilter, orderFilterQuery, type OrderFilter } from "./findings";
import { toRollupOrder } from "./rollups.server";
import { loadPayerHistories } from "./settlements.server";
import { MIN_TIMED_PARCELS_PER_COURIER } from "../shipments/events";
import { trackedPayers } from "./outcome-sources";
import {
  cashTimeline,
  courierDeductions,
  deliveryOdds,
  expectedProfit,
  moneyBreakdown,
  type BreakdownLine,
  type CashTimeline,
  type DeductionRow,
  type ExpectedProfit,
} from "./cash";
import { loadStatements } from "./settlements.server";
import { loadSettledHistory } from "./summaries.server";
import {
  courierPerformance,
  outcomesByDay,
  returnsByCity,
  returnsView,
  type CourierNote,
  type CourierPerformance,
  type DayOutcome,
  type ParcelFacts,
  type ReturnsView,
} from "./returns";

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
export type Owed = {
  amounts: Money[];
  orders: number;
  /** Couriers with no settlement ever recorded: their delivered COD, apart, never owed. */
  untracked: Array<{ courier: string; amounts: Money[]; orders: number }>;
};

/**
 * Only couriers whose payouts Courierify records count as owing: for one
 * with no settlement ever, "not paid" and "paid, never recorded" look the
 * same (`outcome-sources.ts`).
 */
export async function owedToday(storeId: string): Promise<Owed> {
  const [groups, payers] = await Promise.all([
    prisma.orderGrain.groupBy({
      by: ["courier", "fulfilledVia", "uncollectedCurrency"],
      where: { storeId, outcome: "delivered", parcelCount: { gt: 0 }, uncollectedAmount: { gt: 0 } },
      _sum: { uncollectedAmount: true },
      _count: { _all: true },
    }),
    loadPayerHistories(storeId),
  ]);
  const tracked = trackedPayers(payers.map((p) => p.payer));
  // The payer, as I4 has it: the 3PL that booked the parcel, else the courier.
  const payer = (g: { courier: string | null; fulfilledVia: string | null }) => (g.fulfilledVia ?? g.courier ?? "unknown").toLowerCase();
  const isTracked = (g: { courier: string | null; fulfilledVia: string | null }) => tracked.has(payer(g));
  const amounts = (list: typeof groups) =>
    sumByCurrency(
      list
        .filter((g) => g.uncollectedCurrency && g._sum.uncollectedAmount)
        .map((g) => ({ amount: formatAmount(parseAmount(g._sum.uncollectedAmount!.toFixed(6))!), currency: g.uncollectedCurrency! })),
    );
  const owing = groups.filter(isTracked);
  const apart = new Map<string, typeof groups>();
  for (const g of groups.filter((x) => !isTracked(x))) apart.set(payer(g), [...(apart.get(payer(g)) ?? []), g]);
  return {
    amounts: amounts(owing),
    orders: owing.reduce((n, g) => n + g._count._all, 0),
    untracked: [...apart.entries()].map(([courier, list]) => ({
      courier,
      amounts: amounts(list),
      orders: list.reduce((n, g) => n + g._count._all, 0),
    })),
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
  confirmation: string | null = null,
): Promise<OrdersView> {
  // A confirmation state picked in the funnel narrows the list like an outcome chip.
  const statuses = confirmation ? statusesOf(confirmation) : undefined;
  const confirmationWhere = confirmation ? { confirmation: statuses === null ? null : { in: statuses } } : {};
  const where = { storeId, localDay: { gte: from, lte: to }, ...scopeWhere(scope), ...confirmationWhere };
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
    const cashFilter = filter.kind === "awaiting_payout" || filter.kind === "unpaid";
    const all = await prisma.orderGrain.findMany({
      where: cashFilter ? { storeId, outcome: "delivered", uncollectedAmount: { not: null }, ...scopeWhere(scope) } : where,
      orderBy: [{ createdAt: "desc" }, { orderId: "desc" }],
    });
    const ctx = { payers: filter.kind === "awaiting_payout" ? await loadPayerHistories(storeId) : [], asOf: new Date() };
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
  matrix: CityCourierMatrix;
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
  const cityRows = folded(cities, s.rows);
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
            ? t.basis === "reported_by_3pl"
              ? `${t.medianDaysToDeliver.toFixed(1)} days (median, ${t.timedOrders} reported by ${t.reportedBy === "orio" ? "Orio" : "the 3PL"}, not the courier)`
              : `${t.medianDaysToDeliver.toFixed(1)} days (median, ${t.timedOrders} timed)`
            : timingReason(t),
      };
    }),
    cities: cityRows,
    cityCount: cities.length,
    // The same rows as the city table, so its "by courier" view lists the same cities.
    matrix: cityCourierMatrix(s.rows, cityRows.filter((r) => r.folded === undefined).map((r) => r.key)),
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
  /** Cohorts and the repeat curve over all of the store's history (D3), within the filter. */
  retention: Retention;
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
export async function customersView(storeId: string, s: StoreSummary, prev: StoreSummary, canSeeMoney = false): Promise<CustomersView> {
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
    retention: await storeRetention(storeId, s.period.to, s.scope, s.store.currency, canSeeMoney),
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


/**
 * Every delivered order with a buyer, whatever its date: cohorts are built
 * over all of the history Growzar holds, filtered by courier and city like
 * the rest of the section. With the store's currency, each order also
 * carries its delivered revenue and, when fully costed, its product cost
 * (in that currency only, rule #4); the cost is left out for a role that
 * may not see Finance, so no gross profit reaches it.
 */
export async function storeRetention(
  storeId: string,
  asOf: string,
  scope: Scope,
  currency: string | null = null,
  canSeeMoney = false,
): Promise<Retention> {
  const [orders, merged, first] = await Promise.all([
    prisma.orderGrain.findMany({
      where: { storeId, outcome: "delivered", customerId: { not: null }, localDay: { not: null }, ...scopeWhere(scope) },
      select: { customerId: true, localDay: true, currency: true, deliveredAmount: true, cogsAmount: true, cogsCurrency: true, cogsComplete: true },
    }),
    prisma.customer.findMany({ where: { storeId, mergedIntoId: { not: null } }, select: { id: true, mergedIntoId: true } }),
    prisma.orderGrain.aggregate({ where: { storeId }, _min: { localDay: true } }),
  ]);
  const into = new Map(merged.map((c) => [c.id, c.mergedIntoId!]));
  const units = (d: { toFixed(n: number): string } | null) => (d === null ? null : parseAmount(d.toFixed(6)));
  const r = retention(
    orders.map((o) => ({
      customerId: resolveBuyer(o.customerId!, into),
      localDay: o.localDay!,
      ...(currency
        ? {
            revenue: o.currency === currency ? (units(o.deliveredAmount) ?? 0n) : null,
            cost: canSeeMoney && o.cogsComplete && o.cogsCurrency === currency ? units(o.cogsAmount) : null,
          }
        : {}),
    })),
    asOf,
    first._min.localDay,
  );
  return { ...r, currency };
}

// ── Finance: payout ageing (D4) ────────────────────────────────────────────

/**
 * Delivered Courierify COD no settlement covers yet, by courier and age, as
 * of today and whatever the order date: the rows `owedToday` and I4 read.
 */
export async function storePayoutAgeing(storeId: string, currency: string | null, scope: Scope): Promise<PayoutAgeing | null> {
  if (!currency) return null;
  const [rows, payers] = await Promise.all([
    prisma.orderGrain.findMany({
      where: { storeId, outcome: "delivered", parcelCount: { gt: 0 }, uncollectedAmount: { gt: 0 }, ...scopeWhere(scope) },
      select: { courier: true, fulfilledVia: true, outcomeAt: true, uncollectedAmount: true, uncollectedCurrency: true },
    }),
    loadPayerHistories(storeId),
  ]);
  return payoutAgeing(
    rows
      .filter((r) => r.uncollectedCurrency)
      .map((r) => ({
        courier: r.courier,
        payer: r.fulfilledVia ?? r.courier,
        deliveredAt: r.outcomeAt,
        amount: { amount: formatAmount(parseAmount(r.uncollectedAmount!.toFixed(6))!), currency: r.uncollectedCurrency! },
      })),
    currency,
    new Date(),
    trackedPayers(payers.map((p) => p.payer)),
  );
}

// ── Marketing: product matrix (D4) ─────────────────────────────────────────

export type MarketingView = {
  currency: string | null;
  products: ProductPoint[];
  storeReturnRate: number | null;
  /** Ad spend is subtracted only when every day of the period is fetched. */
  withAds: boolean;
  adDays: { fetched: number; inPeriod: number } | null;
  /** Spend per campaign (D5); null without Financify ad spend. */
  campaigns: CampaignSpend | null;
  /** Whether the previous period's ad spend is fetched in full, so campaign changes mean something. */
  campaignsCompared: boolean;
  /** What each campaign's orders did (G-FIN3-1); null without currency. */
  outcomes: CampaignOutcomes | null;
  /** Titles and images by variant, from Financify's catalogue. */
  catalog: Record<string, CatalogEntry>;
};

export async function marketingView(storeId: string, s: StoreSummary): Promise<MarketingView> {
  const cur = s.store.currency;
  if (!cur) return { currency: null, products: [], storeReturnRate: null, withAds: false, adDays: null, campaigns: null, campaignsCompared: false, outcomes: null, catalog: {} };
  const ads = s.adSpend && s.adSpend.daysFetched === s.adSpend.daysInPeriod ? await loadAdSpend(storeId, s.period.from, s.period.to) : null;
  const e = productEconomics(s.rows, cur, ads ? Object.fromEntries(ads.byVariant) : null);
  const before = previousPeriod(s.period.from, s.period.to);
  const [now, prev, prevDays] = s.adSpend
    ? await Promise.all([
        loadCampaignRows(storeId, s.period.from, s.period.to),
        loadCampaignRows(storeId, before.from, before.to),
        prisma.adSpend.count({ where: { storeId, level: "day", day: { gte: before.from, lte: before.to } } }),
      ])
    : [[], [], 0];
  const prevLength = s.adSpend?.daysInPeriod ?? 0;
  const campaignsCompared = prevLength > 0 && prevDays === prevLength;
  const campaigns = s.adSpend ? campaignSpend(now, campaignsCompared ? prev : [], cur) : null;
  const [attribution, names, catalog] = await Promise.all([
    loadAttribution(storeId, s.rows.map((o) => o.orderId)),
    loadCampaignNames(storeId),
    loadCatalog(storeId, e.products.slice(0, 25).map((p) => p.variantId)),
  ]);
  return {
    campaigns,
    campaignsCompared,
    outcomes: attribution.size ? campaignOutcomes(s.rows, attribution, campaigns, names, cur) : null,
    catalog: Object.fromEntries(catalog),
    currency: cur,
    products: e.products,
    storeReturnRate: e.storeReturnRate,
    withAds: e.withAds,
    adDays: s.adSpend ? { fetched: s.adSpend.daysFetched, inPeriod: s.adSpend.daysInPeriod } : null,
  };
}

/** Campaign-level ad spend for ad-platform days `from`…`to` (measured, not allocated). */
async function loadCampaignRows(storeId: string, from: string, to: string): Promise<CampaignSpendRow[]> {
  const rows = await prisma.adSpend.findMany({
    where: { storeId, level: "campaign", day: { gte: from, lte: to } },
    select: { day: true, key: true, platform: true, detail: true, spendAmount: true, feesAmount: true, currency: true },
  });
  const exact = (d: { toFixed(n: number): string }) => formatAmount(parseAmount(d.toFixed(6))!);
  return rows.map((r) => ({
    day: r.day,
    key: r.key,
    platform: r.platform,
    name: typeof (r.detail as Record<string, unknown> | null)?.campaignName === "string" ? ((r.detail as Record<string, string>).campaignName ?? null) : null,
    spend: { amount: exact(r.spendAmount), currency: r.currency },
    fees: { amount: exact(r.feesAmount), currency: r.currency },
  }));
}

// ── Store versus store (D5) ────────────────────────────────────────────────

export type StoreComparison = {
  base: string;
  days: number;
  columns: StoreColumn[];
};

/**
 * The same metrics for each store the viewer may see, side by side: each
 * store over its own local days, money in the organization's base currency
 * at each order day's rate, with the rates kept (rule #4, O-2).
 */
export async function storeComparison(
  stores: Array<{ id: string; displayName: string | null; shopDomain: string; timezone: string | null }>,
  base: string,
  url: URL,
): Promise<StoreComparison> {
  const columns: StoreColumn[] = [];
  let days = 30;
  for (const store of stores) {
    const period = periodFrom(url, store.timezone);
    days = period.days;
    const before = previousPeriod(period.from, period.to);
    const [s, prevCount] = await Promise.all([
      storeSummary(store.id, period.from, period.to),
      prisma.orderGrain.count({ where: { storeId: store.id, localDay: { gte: before.from, lte: before.to } } }),
    ]);
    const first = await prisma.orderGrain.aggregate({ where: { storeId: store.id }, _min: { localDay: true } });
    const fx = await loadFxSource(base, s.rows);
    const dated = (pick: (o: (typeof s.rows)[number]) => Money | null) =>
      s.rows.flatMap((o) => {
        const m = pick(o);
        return m && o.localDay ? [{ day: o.localDay, money: m }] : [];
      });
    columns.push(
      storeColumn({
        storeId: store.id,
        name: store.displayName ?? store.shopDomain,
        currency: s.store.currency,
        base,
        period: { from: period.from, to: period.to },
        orders: s.orders,
        previousOrders: first._min.localDay && first._min.localDay <= before.from ? prevCount : null,
        placed: s.rows.length ? convertDated(dated((o) => o.placed), base, fx.source) : null,
        deliveredRevenue: s.rows.length ? convertDated(dated((o) => (o.outcome === "delivered" ? o.delivered : null)), base, fx.source) : null,
        profit: s.profit,
        adSpend: s.adSpend?.spend ?? null,
        roas: s.roas,
        courierify: s.courierifyCoverage,
      }),
    );
  }
  return { base, days, columns };
}

// ── Finance depth (Phase 4c, A1–A4) ────────────────────────────────────────

export type FinanceDepth = {
  breakdown: BreakdownLine[];
  expected: ExpectedProfit | null;
  cash: CashTimeline;
  deductions: DeductionRow[];
  /** Statements the period's deductions are drawn from, counted by source. */
  statementSources: Record<string, number>;
  /** COD against prepaid for the period's orders (Financify's rule). */
  payment: PaymentSplit | null;
  /** Profit by product, city, courier and campaign; each adds up to the headline. */
  profitBy: Record<ProfitDimension, ProfitTable> | null;
  /** Display names for profit-table keys (product titles, campaign names), and product images. */
  labels: Record<string, string>;
  images: Record<string, string>;
};

/**
 * The breakdown, expected profit, cash timeline and courier deductions for a
 * Finance view, from the same summary its headline figures come from.
 */
export async function financeDepth(storeId: string, s: StoreSummary): Promise<FinanceDepth | null> {
  const cur = s.store.currency;
  if (!cur) return null;
  const [history, statements, payment] = await Promise.all([
    loadSettledHistory(storeId, s.period.to),
    loadStatements(storeId),
    loadPaymentSplit(storeId, s.rows.map((o) => o.orderId)),
  ]);
  // Ads count in the breakdown only when profit subtracts them (every day fetched).
  const ads = s.adSpend && s.adSpend.daysFetched === s.adSpend.daysInPeriod ? { spend: s.adSpend.spend, fees: s.adSpend.fees } : null;
  const mine = s.scope.courier ? statements.filter((x) => x.payer === s.scope.courier) : statements;
  const inPeriod = mine.filter((x) => x.day >= s.period.from && x.day <= s.period.to);
  return {
    breakdown: moneyBreakdown(s.rows, cur, s.profit, ads),
    expected: s.profit ? expectedProfit(s.rows, s.profit, deliveryOdds(history)) : null,
    cash: cashTimeline(s.rows, cur, trackedPayers(statements.map((x) => x.payer)), new Date()),
    deductions: courierDeductions(mine, s.period.from, s.period.to, cur),
    payment,
    ...(await profitTables(storeId, s)),
    statementSources: inPeriod.reduce<Record<string, number>>((m, x) => ({ ...m, [x.source]: (m[x.source] ?? 0) + 1 }), {}),
  };
}

// ── Shipping depth (Phase 4c, A5–A8) ───────────────────────────────────────

export type ShippingDepth = {
  outcomes: DayOutcome[];
  performance: CourierPerformance[];
  returns: ReturnsView | null;
  returnCities: ReturnType<typeof returnsByCity>;
  /** Null when Financify has tied no order in the period to a channel. */
  channels: ChannelCourierMatrix | null;
};

const moneyOf = (v: unknown): Money | null => {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  return typeof m.amount === "string" && typeof m.currency === "string" ? { amount: m.amount, currency: m.currency } : null;
};

/**
 * The period's parcel facts and courier notes, then the shipping depth
 * views. Parcels are read from Courierify's PARCEL rows (whether a return was
 * received, the fees it recorded) and notes from Growzar's own event log;
 * both are keyed to orders through the parcel's order id (rule #6).
 */
export async function shippingDepth(storeId: string, s: StoreSummary): Promise<ShippingDepth> {
  const ids = s.rows.filter((o) => o.parcelCount > 0).map((o) => o.orderId);
  const [parcels, notes, attribution] = await Promise.all([
    loadParcelFacts(storeId, ids),
    loadCourierNotes(storeId, ids),
    loadAttribution(storeId, s.rows.map((o) => o.orderId)),
  ]);
  const asOf = new Date();
  return {
    outcomes: outcomesByDay(s.rows, s.period.from, s.period.to),
    performance: courierPerformance(s.rows, notes, asOf),
    returns: s.store.currency ? returnsView(s.rows, parcels, notes, s.store.currency, asOf) : null,
    returnCities: returnsByCity(s.rows),
    channels: channelCourierMatrix(s.rows, attribution),
  };
}

/**
 * The four profit tables for a summary, sharing its ad spend exactly as the
 * headline subtracted it (`profit.parts.adSpend`, spend + fees, or none).
 */
async function profitTables(
  storeId: string,
  s: StoreSummary,
): Promise<Pick<FinanceDepth, "profitBy" | "labels" | "images">> {
  const cur = s.store.currency;
  if (!cur || !s.profit) return { profitBy: null, labels: {}, images: {} };
  const ads = s.profit.parts.adSpend !== null ? parseAmount(s.profit.parts.adSpend)! : null;
  const units = (m: Money) => (m.currency === cur ? parseAmount(m.amount)! : 0n);
  const [adData, campaignRows, attribution, names] = await Promise.all([
    ads !== null ? loadAdSpend(storeId, s.period.from, s.period.to) : Promise.resolve(null),
    ads !== null ? loadCampaignRows(storeId, s.period.from, s.period.to) : Promise.resolve([]),
    loadAttribution(storeId, s.rows.map((o) => o.orderId)),
    loadCampaignNames(storeId),
  ]);
  const adByVariant = new Map([...(adData?.byVariant ?? new Map<string, Money[]>())].map(([k, list]) => [k, list.reduce((a, m) => a + units(m), 0n)]));
  const adByCampaign = new Map<string, bigint>();
  for (const r of campaignRows) adByCampaign.set(r.key, (adByCampaign.get(r.key) ?? 0n) + units(r.spend) + units(r.fees));
  const input = {
    rows: s.rows,
    currency: cur,
    ads,
    adByVariant,
    adUnattributed: (adData?.unattributed ?? []).reduce((a, m) => a + units(m), 0n),
    adByCampaign,
    campaignOf: new Map([...attribution].map(([id, a]) => [id, a.campaignKey])),
  };
  const profitBy = Object.fromEntries(
    (["product", "city", "courier", "campaign"] as const).map((d) => [d, profitTable(d, input)]),
  ) as Record<ProfitDimension, ProfitTable>;

  // Names: catalogue titles (else the order line's title) and campaign names.
  const variants = profitBy.product.rows.filter((r) => r.kind === "row").map((r) => r.key);
  const catalog = await loadCatalog(storeId, variants);
  const labels: Record<string, string> = {};
  for (const o of s.rows) for (const l of o.lines) if (l.variantId && l.title && !labels[l.variantId]) labels[l.variantId] = l.variantTitle && l.variantTitle !== "Default Title" ? `${l.title} — ${l.variantTitle}` : l.title;
  for (const [k, c] of catalog) if (c.title) labels[k] = c.title;
  for (const [k, n] of names) if (n.name) labels[k] = n.name;
  labels.none = "Not tied to a campaign";
  const images: Record<string, string> = {};
  for (const [k, c] of catalog) if (c.imageUrl) images[k] = c.imageUrl;
  return { profitBy, labels, images };
}
