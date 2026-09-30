import { prisma } from "../db.server";
import { localDayOf } from "./order-grain";
import { byCity, byCourier, courierTiming, rollup, type DeliveryRate } from "./rollups";
import { storeSummary, type StoreSummary } from "./summaries.server";
import { formatAmount, parseAmount, type Money } from "./money";

/**
 * View models for the read-only screens (G-GZR2-5).
 *
 * Every number here comes from `storeSummary` or the order grain — the same
 * layer Phase 3's detectors will read — so a screen cannot disagree with an
 * insight about the same figure. Nothing below adds up source rows.
 *
 * Periods are the store's own local days (rule #5), ending today.
 */

export const PERIODS = [7, 30, 90] as const;
export type PeriodDays = (typeof PERIODS)[number];

export function periodFrom(url: URL, timezone: string | null) {
  const asked = Number(url.searchParams.get("days"));
  const days: PeriodDays = (PERIODS as readonly number[]).includes(asked) ? (asked as PeriodDays) : 30;
  const tz = timezone ?? "UTC";
  const now = Date.now();
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

// ── Home: the funnel strip ─────────────────────────────────────────────────

export type HomeView = {
  funnel: Array<{ label: string; count: number | null; note?: string }>;
  deliveryRate: DeliveryRate;
  coverage: Coverage;
};

export function homeView(s: StoreSummary): HomeView {
  const rows = s.rows;
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
  };
}

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
  settings: StoreSummary["settings"];
};

export function financeView(s: StoreSummary): FinanceView {
  const b = s.orders;
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
    settings: s.settings,
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
};

const LIST_LIMIT = 50;

export async function ordersView(storeId: string, from: string, to: string): Promise<OrdersView> {
  const where = { storeId, localDay: { gte: from, lte: to } };
  const [total, groups, latest] = await Promise.all([
    prisma.orderGrain.count({ where }),
    prisma.orderGrain.groupBy({ by: ["outcome"], where, _count: { _all: true } }),
    prisma.orderGrain.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { orderId: "desc" }],
      take: LIST_LIMIT,
      select: {
        orderId: true, orderName: true, localDay: true, currency: true, placedAmount: true,
        outcome: true, outcomeAuthority: true, outcomeBasis: true, outcomeAt: true, confirmation: true,
        courier: true, city: true, refundedAmount: true, orderCancelled: true, shipmentCancelled: true,
      },
    }),
  ]);
  const money = (a: { toFixed(n: number): string } | null, c: string | null): Money | null =>
    a && c ? { amount: formatAmount(parseAmount(a.toFixed(6))!), currency: c } : null;
  return {
    total,
    byOutcome: groups.map((g) => ({ outcome: g.outcome, count: g._count._all })).sort((a, b) => b.count - a.count),
    rows: latest.map((r) => ({
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
    })),
    shown: latest.length,
  };
}

// ── Shipping: rules #7–12 ───────────────────────────────────────────────────

export type ShippingView = {
  deliveryRate: DeliveryRate;
  returnedValue: Money[];
  couriers: Array<{ courier: string; orders: number; deliveryRate: DeliveryRate; timing: string }>;
  cities: Array<{ city: string; orders: number; deliveryRate: DeliveryRate }>;
  coverage: Coverage;
};

export function shippingView(s: StoreSummary): ShippingView {
  const timing = new Map(courierTiming(s.rows).map((t) => [t.courier, t]));
  return {
    deliveryRate: s.orders.deliveryRate,
    returnedValue: s.orders.returnedValue,
    couriers: rollup(s.rows, byCourier).map((b) => {
      const t = timing.get(b.key);
      return {
        courier: b.key,
        orders: b.orders,
        deliveryRate: b.deliveryRate,
        timing: !t
          ? "—"
          : t.verdict === "ok"
            ? `${t.medianDaysToDeliver.toFixed(1)} days (median, ${t.timedOrders} timed)`
            : t.reason === "no_courier_history"
              ? "not enough data: no courier-timed deliveries"
              : `not enough data: ${t.timedOrders} timed deliveries`,
      };
    }),
    cities: rollup(s.rows, byCity).slice(0, 12).map((b) => ({ city: b.key, orders: b.orders, deliveryRate: b.deliveryRate })),
    coverage: coverage(s),
  };
}

// ── Customers: rules #19, #20, #22 ─────────────────────────────────────────

export type CustomersView = {
  customers: number;
  buyersInPeriod: number;
  repeatBuyers: number;
  top: Array<{
    customerId: string;
    name: string | null;
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
export async function customersView(storeId: string, s: StoreSummary): Promise<CustomersView> {
  const inPeriod = new Set(s.rows.map((r) => r.customerId).filter((c): c is string => !!c));
  const allTime = await prisma.orderGrain.findMany({
    where: { storeId, customerId: { in: [...inPeriod] } },
    select: { customerId: true },
  });
  const lifetimeOrders = new Map<string, number>();
  for (const r of allTime) lifetimeOrders.set(r.customerId!, (lifetimeOrders.get(r.customerId!) ?? 0) + 1);

  const buckets = rollup(s.rows.filter((r) => r.customerId), (r) => [r.customerId!]);
  const top = buckets
    .sort((a, b) => b.deliveryRate.delivered - a.deliveryRate.delivered || b.orders - a.orders)
    .slice(0, 10);
  const names = new Map(
    (await prisma.customer.findMany({ where: { id: { in: top.map((b) => b.key) } }, select: { id: true, displayName: true } }))
      .map((c) => [c.id, c.displayName]),
  );

  return {
    customers: await prisma.customer.count({ where: { storeId, mergedIntoId: null } }),
    buyersInPeriod: inPeriod.size,
    repeatBuyers: [...inPeriod].filter((c) => (lifetimeOrders.get(c) ?? 0) >= 2).length,
    top: top.map((b) => ({
      customerId: b.key,
      name: names.get(b.key) ?? null,
      orders: b.orders,
      deliveryRate: b.deliveryRate,
      deliveredRevenue: b.deliveredRevenue,
    })),
  };
}

