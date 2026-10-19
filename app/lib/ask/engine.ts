/**
 * The general breakdown (Phase 10, agreed 2026-10-19): any metric the metric
 * layer computes, by any dimension it can group by, whether or not a screen
 * shows that view. Pure.
 *
 * Nothing here defines a figure afresh. Counts, rates and order money come
 * from `bucketOf` (the roll-up every screen reads); profit, ad spend and the
 * money of a product row come from Finance's profit tables (`profitTable`),
 * which add up to the headline to the cent. This module only chooses the
 * grouping, adds groups across stores of one currency, and says which pairs
 * cannot be answered.
 */
import { MIN_DECIDED_TO_RATE } from "../metrics/compare";
import { channelOf } from "../metrics/matrices";
import { formatAmount, parseAmount, type Money } from "../metrics/money";
import type { ProfitDimension, ProfitTable } from "../metrics/profit-table";
import { bucketOf, byCity, byCourier, byDay, byVariant, type Profit, type RollupOrder } from "../metrics/rollups";
import type { OrderAttribution } from "../metrics/campaigns";
import { payerName } from "../insights/summary";
import type { Cell, Column } from "./types";

// ── Catalogue ──────────────────────────────────────────────────────────────

export const DIMENSIONS = ["none", "day", "week", "month", "city", "courier", "variant", "product", "campaign", "channel", "buyer_type"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const METRICS = [
  "orders",
  "delivered",
  "returned",
  "still_open",
  "cancelled",
  "delivery_rate",
  "return_rate",
  "units",
  "buyers",
  "placed_revenue",
  "delivered_revenue",
  "aov",
  "returned_value",
  "refunded",
  "collected",
  "courier_fees",
  "product_cost",
  "other_costs",
  "ad_spend",
  "profit",
  "margin",
] as const;
export type Metric = (typeof METRICS)[number];

type MoneyKey = "placed" | "delivered" | "returnedValue" | "refunded" | "collected" | "courierFees" | "productCost" | "otherCosts" | "adSpend" | "profit";

export type MetricDef = {
  label: string;
  kind: Column["kind"];
  /** Money: shown only to a viewer who may see Finance. */
  money: boolean;
  /**
   * Grows for weeks after a period ends (delivered revenue, returns, profit),
   * so a young period is not compared with a mature one (`whenSettled`).
   */
  outcomeDependent: boolean;
  /** The definition, for "How this was computed". */
  rule: string;
};

export const METRIC_DEFS: Record<Metric, MetricDef> = {
  orders: { label: "Orders", kind: "count", money: false, outcomeDependent: false, rule: "Orders placed on the store's own local days (rule #5)." },
  delivered: { label: "Delivered", kind: "count", money: false, outcomeDependent: true, rule: "Orders delivered, as the delivery authority reports (Courierify first, rule #7)." },
  returned: { label: "Returned", kind: "count", money: false, outcomeDependent: true, rule: "Orders returned; a refund is not a return (rule #10)." },
  still_open: { label: "Still open", kind: "count", money: false, outcomeDependent: false, rule: "Orders in transit, booked or not shipped yet: no outcome." },
  cancelled: { label: "Cancelled", kind: "count", money: false, outcomeDependent: false, rule: "Orders or shipments cancelled." },
  delivery_rate: {
    label: "Delivery rate",
    kind: "percent",
    money: false,
    outcomeDependent: false,
    rule: `Delivery rate = delivered ÷ (delivered + returned), by order, always with the orders still open beside it; no rate under ${MIN_DECIDED_TO_RATE} decided orders (rule #8).`,
  },
  return_rate: {
    label: "Return rate",
    kind: "percent",
    money: false,
    outcomeDependent: false,
    rule: `Return rate = returned ÷ (delivered + returned), by order; no rate under ${MIN_DECIDED_TO_RATE} decided orders.`,
  },
  units: { label: "Units ordered", kind: "count", money: false, outcomeDependent: false, rule: "Units ordered (rule #28); by product, the product's own lines." },
  buyers: { label: "Buyers", kind: "count", money: false, outcomeDependent: false, rule: "Distinct buyers, Growzar's own customer record (rule #19)." },
  placed_revenue: {
    label: "Placed revenue",
    kind: "money",
    money: true,
    outcomeDependent: false,
    rule: "Placed revenue: order totals when placed. Placed, delivered and collected revenue are never added together (rule #2). By product, the product's line value before order-level discounts.",
  },
  delivered_revenue: { label: "Delivered revenue", kind: "money", money: true, outcomeDependent: true, rule: "Delivered revenue: the value of delivered orders (rule #2). By product, split by line value." },
  aov: { label: "Average order value", kind: "money", money: true, outcomeDependent: false, rule: "Average order value = placed revenue ÷ orders that have a total (rule #3)." },
  returned_value: { label: "Returned value", kind: "money", money: true, outcomeDependent: true, rule: "The placed value of returned orders." },
  refunded: { label: "Refunded", kind: "money", money: true, outcomeDependent: true, rule: "Money given back to buyers (rule #10)." },
  collected: { label: "Collected", kind: "money", money: true, outcomeDependent: true, rule: "Money the courier has paid out for the orders (rule #2)." },
  courier_fees: { label: "Courier fees", kind: "money", money: true, outcomeDependent: false, rule: "Courier fees of shipped orders, where the courier recorded one." },
  product_cost: { label: "Product cost", kind: "money", money: true, outcomeDependent: true, rule: "Order-time product cost of delivered orders (rule #14); a returned item comes back." },
  other_costs: { label: "Other costs", kind: "money", money: true, outcomeDependent: false, rule: "Financify's per-order costs: payment fees, taxes, custom rules, and its shipping estimate where no courier fee is recorded." },
  ad_spend: { label: "Ad spend", kind: "money", money: true, outcomeDependent: false, rule: "Ad spend plus platform fees, shared out as Finance's profit tabs share it (by product: Financify's allocation; by city or courier: by share of delivered revenue)." },
  profit: {
    label: "Profit after returns",
    kind: "money",
    money: true,
    outcomeDependent: true,
    rule: "Profit after returns = delivered revenue − product cost of delivered orders − courier fees − ad spend − other costs; the rows add up to the headline.",
  },
  margin: { label: "Margin", kind: "percent", money: true, outcomeDependent: true, rule: `Margin = profit ÷ delivered revenue; none under ${MIN_DECIDED_TO_RATE} decided orders.` },
};

export const DIMENSION_LABELS: Record<Dimension, string> = {
  none: "Total",
  day: "Day",
  week: "Week",
  month: "Month",
  city: "City",
  courier: "Courier",
  variant: "Product variant",
  product: "Product",
  campaign: "Campaign",
  channel: "Channel",
  buyer_type: "First or repeat order",
};

const PRODUCT_DIMS: ReadonlySet<Dimension> = new Set(["variant", "product"]);
/** Dimensions Finance's profit tabs split ad spend and profit by. */
const PROFIT_DIMS: ReadonlySet<Dimension> = new Set(["none", "variant", "product", "city", "courier", "campaign"]);
/** Money a product row cannot carry: no source says which line of an order was refunded, collected or returned. */
const NOT_BY_PRODUCT: ReadonlySet<Metric> = new Set(["aov", "returned_value", "refunded", "collected"]);
export const TIME_DIMS: ReadonlySet<Dimension> = new Set(["day", "week", "month"]);

/** Why a metric cannot be broken down by a dimension, or null when it can. */
export function unsupported(metric: Metric, dimension: Dimension): string | null {
  if (PRODUCT_DIMS.has(dimension) && NOT_BY_PRODUCT.has(metric)) {
    return `${METRIC_DEFS[metric].label} is per order, and no source says which product in an order it belongs to`;
  }
  if ((metric === "ad_spend" || metric === "profit" || metric === "margin") && !PROFIT_DIMS.has(dimension)) {
    return `${METRIC_DEFS[metric].label} is split only by product, city, courier or campaign (ad platforms report spend by their own day and campaign, not by ${DIMENSION_LABELS[dimension].toLowerCase()})`;
  }
  return null;
}

// ── Input ──────────────────────────────────────────────────────────────────

/** One store's loaded period: the summary's rows and what the dimension needs. */
export type StoreSlice = {
  storeId: string;
  /** The store's currency: every money figure of its rows is in it (converted at each order's own day's rate). */
  currency: string | null;
  period: { from: string; to: string };
  rows: readonly RollupOrder[];
  /** The headline profit, for the "none" dimension. */
  profit: Profit | null;
  /** Finance's profit tables, every row unfolded; null without currency or profit. */
  profitBy?: Record<ProfitDimension, ProfitTable> | null;
  /** Campaign and channel dimensions. */
  attribution?: ReadonlyMap<string, OrderAttribution>;
  /** Buyer type: each buyer's first order, by created time. */
  firstOrderAt?: ReadonlyMap<string, Date>;
  /** Display names by key (product titles, campaign names), from the profit tables and the catalogue. */
  labels?: Readonly<Record<string, string>>;
};

// ── Keys ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** 7-day blocks ending on `to`, as the weekly trend lines are drawn; the first may be partial. */
export function weekOf(from: string, to: string): (localDay: string) => string {
  return (d) => {
    const back = Math.floor((at(to) - at(d)) / DAY_MS / 7);
    const end = at(to) - back * 7 * DAY_MS;
    const start = Math.max(end - 6 * DAY_MS, at(from));
    return `${day(start)} to ${day(end)}`;
  };
}

const productKey = (l: RollupOrder["lines"][number]) => (l.productId ? `product:${l.productId}` : `product:unknown`);

export function keysOf(dimension: Dimension, slice: StoreSlice): (o: RollupOrder) => string[] {
  switch (dimension) {
    case "none":
      return () => ["total"];
    case "day":
      return byDay;
    case "week": {
      const week = weekOf(slice.period.from, slice.period.to);
      return (o) => [o.localDay ? week(o.localDay) : "unknown day"];
    }
    case "month":
      return (o) => [o.localDay ? o.localDay.slice(0, 7) : "unknown day"];
    case "city":
      return byCity;
    case "courier":
      return byCourier;
    case "variant":
      return byVariant;
    case "product":
      return (o) => o.lines.map(productKey);
    case "campaign":
      return (o) => {
        const a = slice.attribution?.get(o.orderId);
        return [a?.campaignKey ?? (a && a.method !== null ? "none" : "unknown")];
      };
    case "channel":
      return (o) => [channelOf(slice.attribution?.get(o.orderId))];
    case "buyer_type":
      return (o) => {
        if (!o.customerId) return ["no_buyer"];
        const first = slice.firstOrderAt?.get(o.customerId);
        return [!first || !o.createdAt || o.createdAt.getTime() <= first.getTime() ? "first" : "repeat"];
      };
  }
}

// ── Raw sums (addable across stores) ───────────────────────────────────────

export type Raw = {
  orders: number;
  delivered: number;
  returned: number;
  stillOpen: number;
  cancelled: number;
  units: number;
  buyers: Set<string>;
  /** Orders with a placed total in the currency, for the average (rule #3). */
  placedOrders: number;
  /** In millionths of the slice's currency; absent where the dimension cannot carry it. */
  money: Partial<Record<MoneyKey, bigint>>;
  /** Thin profit-table rows ("ad spend not tied to a product") carry money only. */
  moneyOnly?: boolean;
};

const emptyRaw = (): Raw => ({ orders: 0, delivered: 0, returned: 0, stillOpen: 0, cancelled: 0, units: 0, buyers: new Set(), placedOrders: 0, money: {} });

const units = (list: readonly Money[], currency: string | null) =>
  currency ? parseAmount(list.find((m) => m.currency === currency)?.amount ?? "0")! : 0n;
const one = (m: Money | null | undefined, currency: string | null) => (m && currency && m.currency === currency ? parseAmount(m.amount)! : 0n);

/** One store's groups for a dimension, keyed as the dimension keys them. */
export function rawGroups(slice: StoreSlice, dimension: Dimension): Map<string, Raw> {
  const keys = keysOf(dimension, slice);
  const cur = slice.currency;
  const groups = new Map<string, RollupOrder[]>();
  for (const o of slice.rows) {
    for (const k of new Set(keys(o))) groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const product = PRODUCT_DIMS.has(dimension);
  const out = new Map<string, Raw>();
  for (const [key, list] of groups) {
    const b = bucketOf(key, list);
    const r = emptyRaw();
    r.orders = b.orders;
    r.delivered = b.deliveryRate.delivered;
    r.returned = b.deliveryRate.returned;
    r.stillOpen = b.deliveryRate.stillOpen;
    r.cancelled = b.cancelled;
    for (const o of list) if (o.customerId) r.buyers.add(`${slice.storeId}:${o.customerId}`);
    const mine = (l: RollupOrder["lines"][number]) => (dimension === "variant" ? (l.variantId ?? `product:${l.productId ?? "unknown"}`) : productKey(l)) === key;
    const lines = list.flatMap((o) => (product ? o.lines.filter(mine) : o.lines));
    r.units = lines.reduce((n, l) => n + l.quantity, 0);
    if (cur) {
      if (product) {
        r.money.placed = lines.reduce((a, l) => a + one(l.value, cur), 0n);
      } else {
        const placed = list.filter((o) => o.placed && o.placed.currency === cur);
        r.placedOrders = placed.length;
        r.money.placed = units(b.placed, cur);
        r.money.delivered = units(b.deliveredRevenue, cur);
        r.money.returnedValue = units(b.returnedValue, cur);
        r.money.refunded = units(b.refunded, cur);
        r.money.collected = units(b.collected, cur);
        r.money.courierFees = units(b.courierFees, cur);
        r.money.productCost = units(b.cogsDelivered, cur);
        const oc = b.otherCosts;
        r.money.otherCosts = units(oc.payment, cur) + units(oc.shipping, cur) + units(oc.taxes, cur) + units(oc.custom, cur);
      }
    }
    out.set(key, r);
  }
  if (cur) addProfit(out, slice, dimension);
  return out;
}

/** Profit, ad spend and (by product) the split money, from Finance's profit tables. */
function addProfit(out: Map<string, Raw>, slice: StoreSlice, dimension: Dimension) {
  if (dimension === "none") {
    const p = slice.profit;
    const total = out.get("total");
    if (p && total) {
      total.money.profit = parseAmount(p.amount)!;
      if (p.parts.adSpend !== null) total.money.adSpend = parseAmount(p.parts.adSpend)!;
    }
    return;
  }
  const tab: ProfitDimension | null =
    dimension === "variant" || dimension === "product" ? "product" : dimension === "city" || dimension === "courier" || dimension === "campaign" ? dimension : null;
  const table = tab ? slice.profitBy?.[tab] : null;
  if (!table) return;
  // Variant → product, from the period's own order lines.
  const productOf = new Map<string, string>();
  for (const o of slice.rows) for (const l of o.lines) productOf.set(l.variantId ?? `product:${l.productId ?? "unknown"}`, productKey(l));
  const u = (m: Money) => parseAmount(m.amount)!;
  for (const row of table.rows) {
    const key = row.kind === "ads" ? `ads:${row.key}` : dimension === "product" ? (productOf.get(row.key) ?? "product:unknown") : row.key;
    let r = out.get(key);
    if (!r) {
      r = emptyRaw();
      if (row.kind === "ads") r.moneyOnly = true;
      out.set(key, r);
    }
    const add = (k: MoneyKey, v: bigint) => (r!.money[k] = (r!.money[k] ?? 0n) + v);
    add("profit", u(row.profit));
    add("adSpend", u(row.ads));
    if (PRODUCT_DIMS.has(dimension)) {
      // A product's share of each order's money, split by line value as Finance splits it.
      add("delivered", u(row.revenue));
      add("productCost", u(row.productCost));
      add("courierFees", u(row.courierFees));
      add("otherCosts", u(row.otherCosts));
    }
  }
}

/** Groups of several stores added together, by key. Money only when every store is in `currency`. */
export function mergeRaws(groups: ReadonlyArray<Map<string, Raw>>, keepMoney: boolean): Map<string, Raw> {
  const out = new Map<string, Raw>();
  for (const g of groups) {
    for (const [key, r] of g) {
      const seen = out.get(key);
      const m = seen ?? emptyRaw();
      m.orders += r.orders;
      m.delivered += r.delivered;
      m.returned += r.returned;
      m.stillOpen += r.stillOpen;
      m.cancelled += r.cancelled;
      m.units += r.units;
      m.placedOrders += r.placedOrders;
      for (const b of r.buyers) m.buyers.add(b);
      if (keepMoney) {
        for (const [k, v] of Object.entries(r.money) as Array<[MoneyKey, bigint]>) m.money[k] = (m.money[k] ?? 0n) + v;
      }
      m.moneyOnly = seen ? Boolean(seen.moneyOnly && r.moneyOnly) : r.moneyOnly;
      out.set(key, m);
    }
  }
  return out;
}

// ── Values ─────────────────────────────────────────────────────────────────

const pct1 = (n: number, d: number) => Math.round((1000 * n) / d) / 10;
/** Millionths → a number in major units, cut to the cent as the screens print it (`format.ts`). */
export const toMajor = (v: bigint) => Number(formatAmount(v).replace(/^(-?\d+\.\d{2})\d*$/, "$1"));

const MONEY_OF: Partial<Record<Metric, MoneyKey>> = {
  placed_revenue: "placed",
  delivered_revenue: "delivered",
  returned_value: "returnedValue",
  refunded: "refunded",
  collected: "collected",
  courier_fees: "courierFees",
  product_cost: "productCost",
  other_costs: "otherCosts",
  ad_spend: "adSpend",
  profit: "profit",
};

/** A metric's value for one group; null means "not enough data" or "not available", never zero. */
export function valueOf(metric: Metric, r: Raw): number | null {
  const decided = r.delivered + r.returned;
  if (r.moneyOnly && !METRIC_DEFS[metric].money) return null;
  switch (metric) {
    case "orders":
      return r.orders;
    case "delivered":
      return r.delivered;
    case "returned":
      return r.returned;
    case "still_open":
      return r.stillOpen;
    case "cancelled":
      return r.cancelled;
    case "delivery_rate":
      return decided >= MIN_DECIDED_TO_RATE ? pct1(r.delivered, decided) : null;
    case "return_rate":
      return decided >= MIN_DECIDED_TO_RATE ? pct1(r.returned, decided) : null;
    case "units":
      return r.units;
    case "buyers":
      return r.buyers.size;
    case "aov": {
      const placed = r.money.placed;
      if (placed === undefined || !r.placedOrders) return null;
      // Half-up to the cent, as `averageOrderValue` rounds.
      const cents = ((placed / 10_000n) * 2n + BigInt(r.placedOrders)) / (2n * BigInt(r.placedOrders));
      return toMajor(cents * 10_000n);
    }
    case "margin": {
      const profit = r.money.profit;
      const revenue = r.money.delivered;
      if (profit === undefined || !revenue || decided < MIN_DECIDED_TO_RATE) return null;
      return Number((profit * 1000n) / revenue) / 10;
    }
    default: {
      const v = r.money[MONEY_OF[metric]!];
      return v === undefined ? null : toMajor(v);
    }
  }
}

// ── Labels ─────────────────────────────────────────────────────────────────

const PLATFORMS: Record<string, string> = { facebook: "Facebook", tiktok: "TikTok", google: "Google", snapchat: "Snapchat", instagram: "Instagram" };
const BUYER_TYPES: Record<string, string> = { first: "First order", repeat: "Repeat order", no_buyer: "No buyer record" };
const SPECIAL: Record<string, string> = {
  unknown: "Unknown",
  "unknown day": "Unknown day",
  unmapped: "Unmapped city",
  "no city": "No city",
  none: "Not tied to a campaign",
  affiliate: "Affiliate",
  "product:unknown": "Unknown product",
};

export function labelOf(dimension: Dimension, key: string, labels: Readonly<Record<string, string>>): string {
  if (key.startsWith("ads:")) return key.slice(4);
  if (dimension === "none") return "Total";
  if (dimension === "buyer_type") return BUYER_TYPES[key] ?? key;
  if (labels[key]) return labels[key]!;
  if (SPECIAL[key]) return SPECIAL[key]!;
  // Financify's own spelling of a carrier it alone knows ("financify:trax").
  if (dimension === "courier") return payerName(key.replace(/^financify:/, ""));
  if (dimension === "channel") return PLATFORMS[key] ?? payerName(key);
  if (dimension === "variant") return `Variant ${key}`;
  if (dimension === "product") return `Product ${key.replace(/^product:/, "")}`;
  return key;
}

/** Product titles from the period's own order lines (catalogue titles override them where known). */
export function lineLabels(rows: readonly RollupOrder[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const o of rows) {
    for (const l of o.lines) {
      if (!l.title) continue;
      const v = l.variantId ?? `product:${l.productId ?? "unknown"}`;
      if (!labels[v]) labels[v] = l.variantTitle && l.variantTitle !== "Default Title" ? `${l.title} — ${l.variantTitle}` : l.title;
      const p = productKey(l);
      if (!labels[p]) labels[p] = l.title;
    }
  }
  return labels;
}

// ── The table ──────────────────────────────────────────────────────────────

export type BreakdownTable = {
  columns: Column[];
  rows: Array<Record<string, Cell>>;
  /** Groups before the limit. */
  total: number;
  notes: string[];
};

export function breakdownTable(input: {
  groups: Map<string, Raw>;
  dimension: Dimension;
  metrics: readonly Metric[];
  currency: string | null;
  labels: Readonly<Record<string, string>>;
  sort: "top" | "bottom" | "time";
  limit: number;
}): BreakdownTable {
  const { groups, dimension, metrics, currency } = input;
  const first = metrics[0]!;
  const notes: string[] = [];
  const entries = [...groups.entries()].map(([key, raw]) => ({ key, raw, value: valueOf(first, raw) }));

  if (input.sort === "time") {
    entries.sort((a, b) => a.key.localeCompare(b.key));
  } else {
    // A row with no value (too few decided orders to rate) is never ranked.
    const sign = input.sort === "top" ? -1 : 1;
    entries.sort((a, b) =>
      a.value === null && b.value === null
        ? b.raw.orders - a.raw.orders
        : a.value === null
          ? 1
          : b.value === null
            ? -1
            : sign * (a.value - b.value) || b.raw.orders - a.raw.orders,
    );
  }
  const unranked = entries.filter((e) => e.value === null && !e.key.startsWith("ads:")).length;
  if (input.sort !== "time" && unranked) {
    notes.push(
      METRIC_DEFS[first].kind === "percent"
        ? `${unranked} row(s) have under ${MIN_DECIDED_TO_RATE} decided orders, so no ${METRIC_DEFS[first].label.toLowerCase()} and no rank`
        : `${unranked} row(s) have no ${METRIC_DEFS[first].label.toLowerCase()} and are listed last`,
    );
  }
  if (entries.some((e) => e.key.startsWith("ads:"))) {
    notes.push("Ad spend no row could take is its own row, so the rows add up to the headline profit");
  }
  const shown = entries.slice(0, input.limit);
  const columns: Column[] = [
    ...(dimension === "none" ? [] : [{ key: "key", label: "Key", kind: "text" as const }, { key: "label", label: DIMENSION_LABELS[dimension], kind: "text" as const }]),
    ...metrics.map((m) => ({
      key: m,
      label: METRIC_DEFS[m].label,
      kind: METRIC_DEFS[m].kind,
      ...(METRIC_DEFS[m].kind === "money" && currency ? { currency } : {}),
      ...(METRIC_DEFS[m].money ? { money: true } : {}),
    })),
  ];
  // Rates travel with their sample (rule #8).
  const rated = metrics.some((m) => m === "delivery_rate" || m === "return_rate" || m === "margin");
  if (rated) {
    columns.push({ key: "decided", label: "Decided orders", kind: "count" });
    if (!metrics.includes("still_open")) columns.push({ key: "still_open", label: "Still open", kind: "count" });
  }
  const rows = shown.map(({ key, raw }) => {
    const row: Record<string, Cell> = dimension === "none" ? {} : { key, label: labelOf(dimension, key, input.labels) };
    for (const m of metrics) row[m] = valueOf(m, raw);
    if (rated) {
      row.decided = raw.moneyOnly ? null : raw.delivered + raw.returned;
      row.still_open = raw.moneyOnly ? null : raw.stillOpen;
    }
    return row;
  });
  return { columns, rows, total: entries.length, notes };
}
