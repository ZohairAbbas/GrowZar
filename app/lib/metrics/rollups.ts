/**
 * Roll-ups of the order grain (G-GZR2-3): by day, product, city, courier.
 *
 * Rolled from order grain, never recomputed from source (pack G-GZR2-3).
 * Every bucket keeps the order ids it was built from, so any figure can be
 * drilled back to orders, and each order to its source rows (`explain`).
 *
 * Pure. The server loads grain rows and ad spend; this adds them up.
 */
import { coverageVerdict, MIN_TIMED_PARCELS_PER_COURIER } from "../shipments/events";
import { parseAmount, formatAmount, sumByCurrency, type Money } from "./money";
import type { OrderGrain, Outcome } from "./order-grain";

/** The grain fields a roll-up reads. */
export type RollupOrder = Pick<
  OrderGrain,
  | "orderId"
  | "localDay"
  | "createdAt"
  | "currency"
  | "placed"
  | "delivered"
  | "refunded"
  | "collected"
  | "uncollected"
  | "cogs"
  | "cogsComplete"
  | "courierFee"
  | "outcome"
  | "outcomeTiming"
  | "financifyOutcome"
  | "parcelCount"
  | "courier"
  | "fulfilledVia"
  | "city"
  | "cityRaw"
  | "lines"
  | "confirmation"
  | "customerId"
>;

const OPEN: Outcome[] = ["in_transit", "booked", "not_shipped"];
const CANCELLED: Outcome[] = ["order_cancelled", "shipment_cancelled"];
/** Outcomes where a parcel went out, so a courier fee was incurred. */
const SHIPPED: Outcome[] = ["delivered", "returned", "partially_delivered", "in_transit"];

/**
 * Rule #8, as a type: a delivery rate never travels without the count still
 * in transit beside it, so a young week cannot be read as a good week.
 * `rate` is delivered ÷ (delivered + returned), by order; null with no
 * decided orders.
 */
export type DeliveryRate = {
  rate: number | null;
  delivered: number;
  returned: number;
  /** In transit, booked, or not shipped yet: no outcome. */
  stillOpen: number;
  /** Some parcels delivered, some returned; in neither side of the rate. */
  partial: number;
};

export type Bucket = {
  key: string;
  orders: number;
  orderIds: string[];
  /** Rule #2: never summed with one another. Rule #4: one total per currency. */
  placed: Money[];
  deliveredRevenue: Money[];
  returnedValue: Money[];
  refunded: Money[];
  collected: Money[];
  cancelled: number;
  deliveryRate: DeliveryRate;
  /** COGS of delivered orders only (a returned item comes back). */
  cogsDelivered: Money[];
  cogsIncompleteOrders: number;
  /** Courier fees where known, and how many shipped orders lack one. */
  courierFees: Money[];
  shippedOrders: number;
  shippedOrdersWithoutFee: number;
};

function emptyBucket(key: string): Bucket {
  return {
    key,
    orders: 0,
    orderIds: [],
    placed: [],
    deliveredRevenue: [],
    returnedValue: [],
    refunded: [],
    collected: [],
    cancelled: 0,
    deliveryRate: { rate: null, delivered: 0, returned: 0, stillOpen: 0, partial: 0 },
    cogsDelivered: [],
    cogsIncompleteOrders: 0,
    courierFees: [],
    shippedOrders: 0,
    shippedOrdersWithoutFee: 0,
  };
}

/** Roll orders into buckets. `keysOf` may put one order in several (products). */
export function rollup(
  orders: readonly RollupOrder[],
  keysOf: (o: RollupOrder) => string[],
): Bucket[] {
  const collect = new Map<string, RollupOrder[]>();
  for (const o of orders) {
    for (const key of new Set(keysOf(o))) {
      const list = collect.get(key);
      if (list) list.push(o);
      else collect.set(key, [o]);
    }
  }
  return [...collect.entries()]
    .map(([key, list]) => bucketOf(key, list))
    .sort((a, b) => b.orders - a.orders || a.key.localeCompare(b.key));
}

export function bucketOf(key: string, list: readonly RollupOrder[]): Bucket {
  const b = emptyBucket(key);
  const delivered = list.filter((o) => o.outcome === "delivered");
  const returned = list.filter((o) => o.outcome === "returned");
  const shipped = list.filter((o) => SHIPPED.includes(o.outcome));

  b.orders = list.length;
  b.orderIds = list.map((o) => o.orderId);
  b.placed = sumByCurrency(list.map((o) => o.placed));
  b.deliveredRevenue = sumByCurrency(delivered.map((o) => o.delivered));
  b.returnedValue = sumByCurrency(returned.map((o) => o.placed));
  b.refunded = sumByCurrency(list.map((o) => o.refunded));
  b.collected = sumByCurrency(list.map((o) => o.collected));
  b.cancelled = list.filter((o) => CANCELLED.includes(o.outcome)).length;

  const decided = delivered.length + returned.length;
  b.deliveryRate = {
    rate: decided ? delivered.length / decided : null,
    delivered: delivered.length,
    returned: returned.length,
    stillOpen: list.filter((o) => OPEN.includes(o.outcome)).length,
    partial: list.filter((o) => o.outcome === "partially_delivered").length,
  };

  b.cogsDelivered = sumByCurrency(delivered.map((o) => o.cogs));
  b.cogsIncompleteOrders = delivered.filter((o) => o.cogsComplete !== true).length;
  b.courierFees = sumByCurrency(shipped.map((o) => o.courierFee));
  b.shippedOrders = shipped.length;
  b.shippedOrdersWithoutFee = shipped.filter((o) => !o.courierFee).length;
  return b;
}

/**
 * Average order value (rule #3), derived from #1 and #2: placed revenue ÷ the
 * orders that have a placed total, per currency, rounded half-up to the cent.
 * An order with no total (Courierify-only, rule #2) is not counted as zero,
 * which would drag the average down by the stores that lack Financify.
 */
export function averageOrderValue(orders: readonly RollupOrder[]): Money[] {
  const by = new Map<string, { units: bigint; n: bigint }>();
  for (const o of orders) {
    if (!o.placed) continue;
    const e = by.get(o.placed.currency) ?? { units: 0n, n: 0n };
    e.units += parseAmount(o.placed.amount)!;
    e.n += 1n;
    by.set(o.placed.currency, e);
  }
  const CENT = 10_000n; // millionths per cent
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, { units, n }]) => {
      const cents = (units / CENT * 2n + n) / (2n * n); // half-up, in cents
      return { amount: formatAmount(cents * CENT), currency };
    });
}

// ── Keys ────────────────────────────────────────────────────────────────────

export const byDay = (o: RollupOrder) => [o.localDay ?? "unknown day"];

/** Rule #12, cities: Courierify's canonical name, or "unmapped" — never a raw spelling. */
/** Canonical city; a spelling neither app could place is "unmapped", never a city of its own (rule #12). */
export const byCity = (o: RollupOrder) => [o.city ?? (o.parcelCount || o.cityRaw ? "unmapped" : "no city")];

export const byCourier = (o: RollupOrder) => [o.courier ?? "unknown"];

/** Rule #30: the variant id, never the SKU. */
export const byVariant = (o: RollupOrder) =>
  o.lines.map((l) => l.variantId ?? `product:${l.productId ?? "unknown"}`);

// ── Profit after returns ────────────────────────────────────────────────────

/**
 * Profit after returns, courier fees, COGS and ad spend, in one currency.
 *
 *   delivered revenue − COGS of delivered orders − courier fees of shipped
 *   orders − ad spend
 *
 * **Not Financify's "net profit"** (rule #15): Financify's figure depends on
 * five per-store settings. This one has a single fixed definition, and says
 * so. Only the named currency is counted; orders in any other currency are
 * listed as excluded rather than converted (G-GZR2-4 does conversion).
 *
 * `complete` is false whenever something that should be subtracted is not
 * known, and `missing` says what. A figure with 79% of courier fees missing
 * is a ceiling, not a profit, and must read as one.
 */
export type Profit = {
  amount: string;
  currency: string;
  complete: boolean;
  missing: string[];
  parts: {
    deliveredRevenue: string;
    cogsDelivered: string;
    courierFees: string;
    adSpend: string | null;
  };
};

export function profitAfterReturns(
  b: Bucket,
  currency: string,
  adSpend: Money[] | null,
): Profit {
  const pick = (list: Money[]) => parseAmount(list.find((m) => m.currency === currency)?.amount ?? "0")!;
  const revenue = pick(b.deliveredRevenue);
  const cogs = pick(b.cogsDelivered);
  const fees = pick(b.courierFees);
  const ads = adSpend ? pick(adSpend) : null;

  const missing: string[] = [];
  if (b.deliveryRate.stillOpen) missing.push(`${b.deliveryRate.stillOpen} order(s) still open`);
  if (b.deliveryRate.partial) missing.push(`${b.deliveryRate.partial} partially delivered order(s) counted as nothing`);
  if (b.shippedOrdersWithoutFee) missing.push(`courier fee unknown on ${b.shippedOrdersWithoutFee} of ${b.shippedOrders} shipped order(s)`);
  if (b.cogsIncompleteOrders) missing.push(`COGS incomplete on ${b.cogsIncompleteOrders} delivered order(s)`);
  if (ads === null) missing.push("ad spend not available");
  const otherCurrencies = b.placed.filter((m) => m.currency !== currency).map((m) => m.currency);
  if (otherCurrencies.length) missing.push(`orders in ${otherCurrencies.join(", ")} excluded, not converted`);
  if (adSpend?.some((m) => m.currency !== currency)) missing.push("ad spend in another currency excluded");

  return {
    amount: formatAmount(revenue - cogs - fees - (ads ?? 0n)),
    currency,
    complete: missing.length === 0,
    missing,
    parts: {
      deliveredRevenue: formatAmount(revenue),
      cogsDelivered: formatAmount(cogs),
      courierFees: formatAmount(fees),
      adSpend: ads === null ? null : formatAmount(ads),
    },
  };
}

/**
 * ROAS (rule #16): **delivered revenue ÷ ad spend**, in one currency.
 *
 * The rule as written says "ad spend ÷ delivered revenue", which is the
 * inverse (cost per rupee of delivered revenue). Implemented the way ROAS is
 * universally read, with the discrepancy reported rather than silently
 * "fixed" in the rule text. Null without spend.
 */
export function roas(b: Bucket, adSpend: Money[], currency: string): number | null {
  const spend = Number(adSpend.find((m) => m.currency === currency)?.amount ?? 0);
  if (!spend) return null;
  return Number(b.deliveredRevenue.find((m) => m.currency === currency)?.amount ?? 0) / spend;
}

// ── Products (rules #28, #29, #30) ──────────────────────────────────────────

export type ProductLine = {
  variantId: string;
  /** Rule #28: units ordered (Financify's `quantityBasis: "ordered"`). */
  units: number;
  /** Line value, the line's own price less its own discount. */
  lineValue: Money[];
  /** Order-time cost of the units (rule #14). */
  lineCost: Money[];
  /**
   * Rule #29: orders containing the variant, by outcome. An order is the unit
   * — its return is a return of every line in it — because no source records
   * which line of a returned order came back.
   */
  deliveryRate: DeliveryRate;
  orders: number;
};

export function productLines(orders: readonly RollupOrder[]): ProductLine[] {
  const buckets = rollup(orders, byVariant);
  const byId = new Map(orders.map((o) => [o.orderId, o]));
  return buckets.map((b) => {
    const lines = b.orderIds.flatMap((id) =>
      byId.get(id)!.lines.filter((l) => (l.variantId ?? `product:${l.productId ?? "unknown"}`) === b.key),
    );
    return {
      variantId: b.key,
      units: lines.reduce((n, l) => n + l.quantity, 0),
      lineValue: sumByCurrency(lines.map((l) => l.value)),
      lineCost: sumByCurrency(lines.map((l) => l.cost)),
      deliveryRate: b.deliveryRate,
      orders: b.orders,
    };
  });
}

// ── Courier timing (rule #9, gated) ─────────────────────────────────────────

export type CourierTiming =
  | {
      courier: string;
      verdict: "ok";
      timedOrders: number;
      medianDaysToDeliver: number;
      /**
       * Whose times the median is over. "courier": times the courier gave.
       * "reported_by_3pl": no courier gave enough, so the 3PL's observed
       * times (about five minutes behind the courier), named in `reportedBy`.
       * Never mixed in one median.
       */
      basis: "courier" | "reported_by_3pl";
      reportedBy?: string;
    }
  | {
      courier: string;
      verdict: "not_enough_data";
      /**
       * Why, most specific first (G-GZR3-2):
       *  - `not_via_courierify`: a carrier only Financify names; no parcel
       *    went through Courierify, so there is no event log at all;
       *  - `shipped_via_3pl`: most delivered orders were booked through a
       *    3PL (`via`), whose status Courierify mirrors from Shopify with no
       *    courier times;
       *  - `no_courier_history` / `too_few_parcels`: the coverage verdict.
       * None of these is "slow", and no screen may read them as such.
       */
      reason: "not_via_courierify" | "shipped_via_3pl" | "no_courier_history" | "too_few_parcels";
      timedOrders: number;
      /** For `shipped_via_3pl`: the 3PL, and how many delivered orders it booked. */
      via?: { name: string; orders: number; delivered: number };
    };

/**
 * Median days from order to delivery, per courier — only from deliveries the
 * courier timed ("happened on"). Four couriers have no history at all; a
 * courier with none would otherwise look like one that never delivers, so
 * below the floor this returns "not enough data", never a number.
 */
function untimedBecause(
  courier: string,
  orders: readonly RollupOrder[],
  fallback: "no_courier_history" | "too_few_parcels",
): Pick<Extract<CourierTiming, { verdict: "not_enough_data" }>, "reason" | "via"> {
  if (courier.startsWith("financify:")) return { reason: "not_via_courierify" };
  const delivered = orders.filter((o) => o.courier === courier && o.outcome === "delivered");
  const via = new Map<string, number>();
  for (const o of delivered) if (o.fulfilledVia) via.set(o.fulfilledVia, (via.get(o.fulfilledVia) ?? 0) + 1);
  const [name, n] = [...via.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  // Most of the courier's deliveries, not merely some: a courier with its
  // own timed parcels plus a few via a 3PL is short of data, not "via Orio".
  if (n * 2 > delivered.length) return { reason: "shipped_via_3pl", via: { name, orders: n, delivered: delivered.length } };
  return { reason: fallback };
}

/** Median days from order to the timed delivery. */
function medianDays(timed: readonly RollupOrder[]): number {
  const days = timed.map((o) => (o.outcomeTiming!.at.getTime() - o.createdAt!.getTime()) / 86_400_000).sort((x, y) => x - y);
  const mid = Math.floor(days.length / 2);
  return days.length % 2 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2;
}

export function courierTiming(
  orders: readonly RollupOrder[],
  minimum = MIN_TIMED_PARCELS_PER_COURIER,
): CourierTiming[] {
  const out: CourierTiming[] = [];
  for (const b of rollup(orders.filter((o) => o.courier), byCourier)) {
    const timed = orders.filter(
      (o) =>
        o.courier === b.key &&
        o.outcome === "delivered" &&
        o.outcomeTiming?.basis === "happened_on" &&
        o.createdAt,
    );
    const verdict = coverageVerdict(timed.length, minimum);
    if (verdict.verdict !== "ok") {
      // Not enough courier times: a 3PL's own times, if there are enough of
      // them, and labelled as the 3PL's (Courierify G-CFY3-1).
      const by3pl = orders.filter(
        (o) => o.courier === b.key && o.outcome === "delivered" && o.outcomeTiming?.basis === "reported_by_3pl" && o.createdAt,
      );
      if (coverageVerdict(by3pl.length, minimum).verdict === "ok") {
        const via = new Map<string, number>();
        for (const o of by3pl) if (o.fulfilledVia) via.set(o.fulfilledVia, (via.get(o.fulfilledVia) ?? 0) + 1);
        const [reportedBy] = [...via.entries()].sort((x, y) => y[1] - x[1])[0] ?? ["the 3PL"];
        out.push({ courier: b.key, verdict: "ok", timedOrders: by3pl.length, medianDaysToDeliver: medianDays(by3pl), basis: "reported_by_3pl", reportedBy });
        continue;
      }
      out.push({ courier: b.key, verdict: "not_enough_data", timedOrders: timed.length, ...untimedBecause(b.key, orders, verdict.reason) });
      continue;
    }
    out.push({ courier: b.key, verdict: "ok", timedOrders: timed.length, medianDaysToDeliver: medianDays(timed), basis: "courier" });
  }
  return out;
}
