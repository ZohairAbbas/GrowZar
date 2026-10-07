/**
 * Matrices and funnels (Phase 4b, D4). Pure, over grain rows.
 *
 * Each is a breakdown, so each states its sample and leaves a cell without a
 * rate below MIN_DECIDED_TO_RATE decided orders (pack §2.5).
 */
import { MIN_DECIDED_TO_RATE } from "./compare";
import { formatAmount, parseAmount, type Money } from "./money";
import { byCity, type RollupOrder } from "./rollups";
import type { OrderAttribution } from "./campaigns";

const DECIDED = ["delivered", "returned"];
const SHIPPED = ["delivered", "returned", "partially_delivered", "in_transit"];
const CANCELLED = ["order_cancelled", "shipment_cancelled"];
const pct = (n: number, d: number) => Math.round((1000 * n) / d) / 10;
const units = (m: Money | null | undefined, currency: string) => (m && m.currency === currency ? parseAmount(m.amount)! : 0n);
const money = (u: bigint, currency: string): Money => ({ amount: formatAmount(u), currency });

// ── Product economics ──────────────────────────────────────────────────────

/**
 * Margin on decided orders, per variant (D4's product matrix).
 *
 *   delivered line value − delivered line cost − ad spend × decided ÷ live
 *
 * Only orders that reached an outcome count. Ad spend is Financify's
 * per-variant allocation over the period, charged in proportion to the
 * decided share of the variant's live (not cancelled) orders: ads buy every
 * order at once, but revenue arrives only on delivery, so charging all of it
 * to the decided few would make every young period read as a loss.
 *
 * A return earns nothing and its cost comes back, so a variant that returns
 * half its parcels shows it here, which "if every order were delivered"
 * hides. Lines are the variant's own value and order-time cost (rule #14);
 * returns are by order (rule #29).
 */
export type ProductPoint = {
  variantId: string;
  title: string | null;
  orders: number;
  decided: number;
  delivered: number;
  returned: number;
  /** returned ÷ decided, percent. */
  returnRate: number;
  deliveredUnits: number;
  deliveredValue: Money;
  deliveredCost: Money;
  /** Allocated ad spend charged to decided orders; null when ad spend is not complete. */
  adSpend: Money | null;
  margin: Money;
  /** margin ÷ delivered value, percent; null with no delivered value. */
  marginPct: number | null;
  /** The same, as if every live order had been delivered: what the product "looks like". */
  marginIfAllDeliveredPct: number | null;
  /** Delivered lines of this variant with no cost in Financify. */
  linesWithoutCost: number;
  deliveredLines: number;
  /** Enough decided orders and costed lines to place on the matrix. */
  plotted: boolean;
};

/** Share of delivered lines that must carry a cost for a margin to be drawn. */
export const MIN_COSTED_LINE_SHARE = 0.9;

export function productEconomics(
  rows: readonly RollupOrder[],
  currency: string,
  adByVariant: Record<string, Money[]> | null,
): { products: ProductPoint[]; storeReturnRate: number | null; withAds: boolean } {
  const domestic = rows.filter((o) => o.currency === currency);
  const decidedAll = domestic.filter((o) => DECIDED.includes(o.outcome));
  const byVariant = new Map<string, RollupOrder[]>();
  for (const o of domestic) {
    for (const v of new Set(o.lines.map((l) => l.variantId).filter((v): v is string => !!v))) {
      byVariant.set(v, [...(byVariant.get(v) ?? []), o]);
    }
  }
  const products = [...byVariant.entries()].map(([variantId, mine]): ProductPoint => {
    const lines = (list: RollupOrder[]) => list.flatMap((o) => o.lines.filter((l) => l.variantId === variantId));
    const live = mine.filter((o) => !CANCELLED.includes(o.outcome));
    const decided = mine.filter((o) => DECIDED.includes(o.outcome));
    const delivered = mine.filter((o) => o.outcome === "delivered");
    const dLines = lines(delivered);
    const sum = (ls: typeof dLines, f: "value" | "cost") => ls.reduce((a, l) => a + units(l[f], currency), 0n);
    const dv = sum(dLines, "value");
    const dc = sum(dLines, "cost");
    const pLines = lines(live);
    const pv = sum(pLines, "value");
    const pc = sum(pLines, "cost");
    const adsAll = adByVariant ? (adByVariant[variantId] ?? []).reduce((a, m) => a + units(m, currency), 0n) : null;
    const adsDecided = adsAll === null ? null : live.length ? (adsAll * BigInt(decided.length)) / BigInt(live.length) : 0n;
    const margin = dv - dc - (adsDecided ?? 0n);
    const withoutCost = dLines.filter((l) => !l.cost).length;
    const title = (() => {
      const l = pLines.find((x) => x.title) ?? dLines.find((x) => x.title);
      if (!l?.title) return null;
      return l.variantTitle && l.variantTitle !== "Default Title" ? `${l.title} — ${l.variantTitle}` : l.title;
    })();
    return {
      variantId,
      title,
      orders: mine.length,
      decided: decided.length,
      delivered: delivered.length,
      returned: decided.length - delivered.length,
      returnRate: decided.length ? pct(decided.length - delivered.length, decided.length) : 0,
      deliveredUnits: dLines.reduce((n, l) => n + l.quantity, 0),
      deliveredValue: money(dv, currency),
      deliveredCost: money(dc, currency),
      adSpend: adsDecided === null ? null : money(adsDecided, currency),
      margin: money(margin, currency),
      marginPct: dv > 0n ? Number((margin * 1000n) / dv) / 10 : null,
      marginIfAllDeliveredPct: pv > 0n ? Number(((pv - pc - (adsAll ?? 0n)) * 1000n) / pv) / 10 : null,
      linesWithoutCost: withoutCost,
      deliveredLines: dLines.length,
      plotted:
        decided.length >= MIN_DECIDED_TO_RATE &&
        dv > 0n &&
        dLines.length - withoutCost >= MIN_COSTED_LINE_SHARE * dLines.length,
    };
  });
  const returned = decidedAll.filter((o) => o.outcome === "returned").length;
  return {
    products: products.sort((a, b) => b.delivered - a.delivered || a.variantId.localeCompare(b.variantId)),
    storeReturnRate: decidedAll.length >= MIN_DECIDED_TO_RATE ? pct(returned, decidedAll.length) : null,
    withAds: adByVariant !== null,
  };
}

// ── City × courier ─────────────────────────────────────────────────────────

export type MatrixCell = { orders: number; decided: number; delivered: number; rate: number | null };

export type CityCourierMatrix = {
  couriers: string[];
  cities: Array<{ city: string; orders: number; cells: Record<string, MatrixCell> }>;
  /** Cities beyond the rows shown, and their orders. */
  moreCities: { cities: number; orders: number };
};

/**
 * Delivery rate by city and courier, over orders that have a courier (only a
 * courier booking names one). Rows are `cityKeys` when given — the city
 * table's own rows, so both views list the same cities — else the
 * `maxCities` busiest. A cell under MIN_DECIDED_TO_RATE decided orders keeps
 * its counts and has no rate.
 */
export function cityCourierMatrix(rows: readonly RollupOrder[], cityKeys?: readonly string[], maxCities = 12): CityCourierMatrix {
  const cityOf = (o: RollupOrder) => byCity(o)[0]!;
  const withCourier = rows.filter((o) => o.courier && (cityKeys ? true : o.city));
  const count = (key: (o: RollupOrder) => string) => {
    const m = new Map<string, number>();
    for (const o of withCourier) m.set(key(o), (m.get(key(o)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const cityCounts = count(cityOf);
  const shown = cityKeys ? cityKeys.map((k) => [k, cityCounts.find(([c]) => c === k)?.[1] ?? 0] as const) : cityCounts.slice(0, maxCities);
  const keys = new Set(shown.map(([c]) => c));
  // Only couriers with an order in a row shown: an empty column says nothing.
  const couriers = count((o) => (keys.has(cityOf(o)) ? o.courier! : "")).map(([c]) => c).filter(Boolean);
  const rest = cityCounts.filter(([c]) => !keys.has(c));
  return {
    couriers,
    cities: shown.map(([city, orders]) => ({
      city,
      orders,
      cells: Object.fromEntries(
        couriers.map((courier) => {
          const mine = withCourier.filter((o) => cityOf(o) === city && o.courier === courier);
          const delivered = mine.filter((o) => o.outcome === "delivered").length;
          const decided = mine.filter((o) => DECIDED.includes(o.outcome)).length;
          return [courier, { orders: mine.length, decided, delivered, rate: decided >= MIN_DECIDED_TO_RATE ? pct(delivered, decided) : null }];
        }),
      ),
    })),
    moreCities: {
      cities: rest.length,
      orders: rest.reduce((n, [, c]) => n + c, 0),
    },
  };
}

// ── Channel × courier ──────────────────────────────────────────────────────

/**
 * The channel an order came from: the ad platform Financify tied it to,
 * "affiliate", "none" (no campaign: organic, direct or untagged) or
 * "unknown" (Financify has no attribution record for it yet).
 */
export const channelOf = (a: OrderAttribution | undefined): string =>
  !a || a.method === null ? "unknown" : a.platform ? a.platform : a.method === "affiliate" ? "affiliate" : "none";

export type ChannelCourierMatrix = {
  couriers: string[];
  channels: Array<{ channel: string; orders: number; all: MatrixCell; cells: Record<string, MatrixCell> }>;
};

function rateOf(list: readonly RollupOrder[]): MatrixCell {
  const delivered = list.filter((o) => o.outcome === "delivered").length;
  const decided = list.filter((o) => DECIDED.includes(o.outcome)).length;
  return { orders: list.length, decided, delivered, rate: decided >= MIN_DECIDED_TO_RATE ? pct(delivered, decided) : null };
}

/**
 * Delivery rate by channel and courier: does a courier deliver one
 * channel's buyers worse than another's? Every channel is a row, busiest
 * first; `all` is the channel over every order, with a courier or not.
 * Null without any attribution, since every row would be "unknown".
 */
export function channelCourierMatrix(rows: readonly RollupOrder[], attribution: ReadonlyMap<string, OrderAttribution>): ChannelCourierMatrix | null {
  if (!rows.some((o) => attribution.has(o.orderId))) return null;
  const by = new Map<string, RollupOrder[]>();
  for (const o of rows) {
    const c = channelOf(attribution.get(o.orderId));
    by.set(c, [...(by.get(c) ?? []), o]);
  }
  const perCourier = new Map<string, number>();
  for (const o of rows) if (o.courier) perCourier.set(o.courier, (perCourier.get(o.courier) ?? 0) + 1);
  const couriers = [...perCourier.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  return {
    couriers,
    channels: [...by.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([channel, list]) => ({
        channel,
        orders: list.length,
        all: rateOf(list),
        cells: Object.fromEntries(couriers.map((c) => [c, rateOf(list.filter((o) => o.courier === c))])),
      })),
  };
}

// ── Payout ageing ──────────────────────────────────────────────────────────

export const AGE_BUCKETS = [
  { key: "0-7", label: "0–7 days", min: 0, max: 7 },
  { key: "8-14", label: "8–14 days", min: 8, max: 14 },
  { key: "15-30", label: "15–30 days", min: 15, max: 30 },
  { key: "31-60", label: "31–60 days", min: 31, max: 60 },
  { key: "61+", label: "Over 60 days", min: 61, max: Infinity },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]["key"] | "unknown";
/** A filter value, not a bucket: every age (an untracked courier's whole COD). */
export type AgeFilter = AgeBucket | "any";

export type Unpaid = {
  courier: string | null;
  /** Who pays the COD: the 3PL that booked it (Orio), else the courier — I4's `payerOf`. */
  payer?: string | null;
  deliveredAt: Date | null;
  amount: Money;
};
const payerKey = (u: Unpaid) => (u.payer ?? u.courier ?? "unknown").toLowerCase();

export const ageOf = (deliveredAt: Date | null, asOf: Date): AgeBucket => {
  if (!deliveredAt) return "unknown";
  const days = Math.floor((asOf.getTime() - deliveredAt.getTime()) / 86_400_000);
  return AGE_BUCKETS.find((b) => days >= b.min && days <= b.max)?.key ?? "0-7";
};

export type PayoutAgeing = {
  currency: string;
  buckets: Array<{ key: AgeBucket; label: string }>;
  couriers: Array<{
    courier: string;
    /** Who pays this courier's COD when it is not the courier itself (a 3PL such as Orio). */
    paidBy: string | null;
    total: Money;
    orders: number;
    cells: Record<string, { amount: Money; orders: number }>;
  }>;
  /** Tracked couriers only: their payouts are visible, so unpaid means owed. */
  total: Money;
  orders: number;
  /**
   * Couriers with no settlement ever recorded: their delivered COD, listed
   * apart, never as owed (`outcome-sources.ts`).
   */
  /** Keyed by payer: a 3PL's parcels are its own to pay, whichever courier carried them. */
  untracked: Array<{ courier: string; total: Money; orders: number }>;
  /** COD in another currency, not added in (rule #4). */
  otherCurrencies: Money[];
};

/**
 * COD delivered and not yet paid, by courier and by how long ago it was
 * delivered (the visual counterpart of I4). As of today, any order date.
 */
export function payoutAgeing(
  unpaid: readonly Unpaid[],
  currency: string,
  asOf: Date,
  /** Couriers with a settlement on record; null treats every courier as tracked. */
  tracked: ReadonlySet<string> | null = null,
): PayoutAgeing {
  const inCurrency = unpaid.filter((u) => u.amount.currency === currency);
  const isTracked = (u: Unpaid) => tracked === null || tracked.has(payerKey(u));
  const mine = inCurrency.filter(isTracked);
  const apart = new Map<string, Unpaid[]>();
  for (const u of inCurrency.filter((x) => !isTracked(x))) apart.set(payerKey(u), [...(apart.get(payerKey(u)) ?? []), u]);
  const hasUnknown = mine.some((u) => !u.deliveredAt);
  const buckets: Array<{ key: AgeBucket; label: string }> = [
    ...AGE_BUCKETS.map((b) => ({ key: b.key as AgeBucket, label: b.label })),
    ...(hasUnknown ? [{ key: "unknown" as AgeBucket, label: "No delivery date" }] : []),
  ];
  const byCourier = new Map<string, Unpaid[]>();
  for (const u of mine) byCourier.set(u.courier ?? "unknown", [...(byCourier.get(u.courier ?? "unknown") ?? []), u]);
  const sum = (list: readonly Unpaid[]) => list.reduce((a, u) => a + parseAmount(u.amount.amount)!, 0n);
  const others = new Map<string, bigint>();
  for (const u of unpaid) {
    if (u.amount.currency !== currency) others.set(u.amount.currency, (others.get(u.amount.currency) ?? 0n) + parseAmount(u.amount.amount)!);
  }
  return {
    currency,
    buckets,
    couriers: [...byCourier.entries()]
      .map(([courier, list]) => ({
        courier,
        paidBy: (() => {
          const payers = new Set(list.map(payerKey));
          const only = [...payers][0];
          return payers.size === 1 && only && only !== courier.toLowerCase() ? only : null;
        })(),
        total: money(sum(list), currency),
        orders: list.length,
        cells: Object.fromEntries(
          buckets.map((b) => {
            const inB = list.filter((u) => ageOf(u.deliveredAt, asOf) === b.key);
            return [b.key, { amount: money(sum(inB), currency), orders: inB.length }];
          }),
        ),
      }))
      .sort((a, b) => (parseAmount(b.total.amount)! > parseAmount(a.total.amount)! ? 1 : -1)),
    total: money(sum(mine), currency),
    orders: mine.length,
    untracked: [...apart.entries()]
      .map(([courier, list]) => ({ courier, total: money(sum(list), currency), orders: list.length }))
      .sort((a, b) => b.orders - a.orders),
    otherCurrencies: [...others.entries()].map(([c, u]) => money(u, c)),
  };
}

// ── Confirmation funnel ────────────────────────────────────────────────────

/** Courierify's confirmation statuses, grouped the way a merchant reads them. */
const CONFIRMATION_GROUP: Record<string, string> = {
  confirmed: "confirmed",
  declined: "declined",
  cancelled: "declined",
  timed_out: "no_answer",
  expired: "no_answer",
  ambiguous: "unclear",
  sent: "awaiting",
  pending: "awaiting",
  send_failed: "not_delivered",
};
export const CONFIRMATION_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  declined: "Declined",
  no_answer: "No answer",
  unclear: "Unclear reply",
  awaiting: "Awaiting reply",
  not_delivered: "Message not delivered",
  not_sent: "Not sent for confirmation",
};
/** The raw statuses in a group, for a database filter; "not_sent" is a null confirmation. */
export const statusesOf = (group: string): string[] | null =>
  group === "not_sent" ? null : Object.entries(CONFIRMATION_GROUP).filter(([, g]) => g === group).map(([s]) => s);
export const isConfirmationGroup = (v: string | null): v is string => v !== null && v in CONFIRMATION_LABELS;
export const confirmationGroup = (c: string | null) => (c === null ? "not_sent" : (CONFIRMATION_GROUP[c] ?? "unclear"));

export type ConfirmationFunnel = {
  steps: Array<{ key: string; label: string; orders: number }>;
  states: ConfirmationRow[];
  /** Every order placed in the period, in the same shape as a state. */
  total: ConfirmationRow;
};

export type ConfirmationRow = {
  state: string;
  label: string;
  orders: number;
  shipped: number;
  delivered: number;
  decided: number;
  returned: number;
  /** returned ÷ decided, percent; null under the minimum. */
  returnRate: number | null;
};

function confirmationRow(state: string, label: string, list: readonly RollupOrder[]): ConfirmationRow {
  const decided = list.filter((o) => DECIDED.includes(o.outcome));
  const returned = decided.filter((o) => o.outcome === "returned").length;
  return {
    state,
    label,
    orders: list.length,
    shipped: list.filter((o) => SHIPPED.includes(o.outcome)).length,
    delivered: decided.length - returned,
    decided: decided.length,
    returned,
    returnRate: decided.length >= MIN_DECIDED_TO_RATE ? pct(returned, decided.length) : null,
  };
}

/**
 * Placed → sent for confirmation → confirmed → shipped → delivered →
 * returned, with the return rate of each confirmation state beside it
 * (the evidence behind I8). Counts are of orders placed in the period.
 */
export function confirmationFunnel(rows: readonly RollupOrder[]): ConfirmationFunnel {
  const confirmed = rows.filter((o) => o.confirmation === "confirmed");
  const groups = new Map<string, RollupOrder[]>();
  for (const o of rows) {
    const g = confirmationGroup(o.confirmation);
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  return {
    steps: [
      { key: "placed", label: "Placed", orders: rows.length },
      { key: "attempted", label: "Sent for confirmation", orders: rows.filter((o) => o.confirmation !== null).length },
      { key: "confirmed", label: "Confirmed", orders: confirmed.length },
      { key: "shipped", label: "Shipped", orders: rows.filter((o) => SHIPPED.includes(o.outcome)).length },
      { key: "delivered", label: "Delivered", orders: rows.filter((o) => o.outcome === "delivered").length },
      { key: "returned", label: "Returned", orders: rows.filter((o) => o.outcome === "returned").length },
    ],
    states: Object.keys(CONFIRMATION_LABELS)
      .filter((state) => groups.has(state))
      .map((state) => confirmationRow(state, CONFIRMATION_LABELS[state]!, groups.get(state)!)),
    total: confirmationRow("all", "All orders", rows),
  };
}
