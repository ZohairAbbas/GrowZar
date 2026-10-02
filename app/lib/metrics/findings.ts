/**
 * Cross-app findings on Home (G-GZR3-1): a few plain cards, each with the
 * numbers behind it, shown while the insight framework (ranking, dismiss,
 * snooze, backtests) is built. They become detectors in G-GZR3-3.
 *
 * Pure, and read only the metric layer: grain rows, the period's bucket and
 * profit. Every finding
 *  - is gated, and absent rather than guessed when its gate fails;
 *  - names which app decided the outcomes it rests on, because "cross-app"
 *    is a claim about the data, not about the card;
 *  - carries the filter its "see the orders" link uses, and that filter is
 *    the same predicate the finding counted with, so a card and the list
 *    behind it cannot disagree;
 *  - shows measured money only. No "worth PKR X" estimate appears before a
 *    detector's backtest passes (PLAN.md §3, the money rule).
 */
import { parseAmount, sumByCurrency, type Money } from "./money";
import type { Outcome } from "./order-grain";
import { productLines, type Bucket, type Profit, type RollupOrder } from "./rollups";

/** A variant needs this many delivered-or-returned orders to be compared. */
export const MIN_DECIDED_PER_VARIANT = 30;
/** How far above the store's own return rate a variant must be, in points. */
export const MIN_RETURN_GAP_POINTS = 10;
/** Fewer material disagreements than this is noise, not a finding. */
export const MIN_DISAGREEMENTS = 5;
/**
 * The money card needs a period that has mostly resolved. Ad spend counts in
 * full from day one, but an order adds its revenue only once delivered, so a
 * young period reads as a loss: on the pilot store's last 7 days, ads were
 * "2,039% of delivered revenue" with 122 of 142 orders still open.
 */
export const MAX_OPEN_SHARE_FOR_MARGIN = 0.15;
/** I13: Courierify-booked shipped orders without a fee needed to say so. */
export const MIN_MISSING_FEES = 25;
/** Shipped orders needed before "Courierify stopped" is said at all. */
export const MIN_SHIPPED_FOR_COVERAGE = 20;

/** Orders whose outcome each app decided (rule #7): a parcel means Courierify. */
export type DecidedBy = { courierify: number; financify: number };

export type OrderFilter =
  | { kind: "variant"; variantId: string }
  | { kind: "disagree" }
  | { kind: "decided_by"; app: "financify" | "courierify" }
  | { kind: "fee_missing" };

export type MarginFinding = {
  kind: "margin";
  /** Profit after returns, which is a ceiling: see `notSubtracted`. */
  ceiling: Money;
  deliveredRevenue: Money;
  cogsDelivered: Money;
  adSpend: Money;
  knownCourierFees: Money;
  /** Ad spend as a share of delivered revenue, 0–100+, one decimal. */
  adsShareOfDelivered: number;
  delivered: number;
  returned: number;
  /** Not in the figure. Any that deliver add their revenue less their COGS. */
  stillOpen: { orders: number; placed: Money };
  feesUnknown: { orders: number; shipped: number };
  cogsIncompleteOrders: number;
  excludedCurrencies: string[];
  decidedBy: DecidedBy;
};

export type VariantRate = {
  variantId: string;
  title: string | null;
  returned: number;
  decided: number;
  stillOpen: number;
  /** returned ÷ decided, as a percentage with one decimal. */
  returnRate: number;
};

export type VariantReturnsFinding = {
  kind: "variant_returns";
  /** The store's own return rate over the same domestic orders. */
  store: { returned: number; decided: number; returnRate: number };
  flagged: VariantRate[];
  /** The best sellers that are not flagged, for comparison. */
  bestSellers: VariantRate[];
  internationalExcluded: number;
  decidedBy: DecidedBy;
};

export type DisagreementGroup = {
  /** What Financify says, then what the courier (via Courierify) says. */
  financify: Outcome;
  courier: Outcome;
  orders: number;
  placed: Money[];
};

export type DisagreementFinding = {
  kind: "disagreements";
  total: number;
  /** Largest first. */
  groups: DisagreementGroup[];
  /** Orders where both apps have a view, out of which `total` disagree. */
  bothApps: number;
  filter: OrderFilter;
};

export type CourierifyStoppedFinding = {
  kind: "courierify_stopped";
  /** The store's last order with a Courierify parcel, its local day. */
  lastParcelDay: string;
  shipped: number;
  withParcel: number;
  filter: OrderFilter;
};

export type MissingFeesFinding = {
  kind: "missing_fees";
  /** Shipped through Courierify, and Courierify records no cost for them. */
  missing: number;
  /** Shipped through Courierify in all, with or without a fee. */
  viaCourierify: number;
  /** Of `missing`, by courier, largest first. */
  byCourier: Array<{ courier: string; missing: number; shipped: number }>;
  /** Of `missing`, how many went through a 3PL (Courierify's `fulfilledVia`). */
  via3pl: number;
  /** Shipped outside Courierify: no fee source exists for them at all. */
  outsideCourierify: number;
  filter: OrderFilter;
};

export type Finding = MissingFeesFinding | MarginFinding | VariantReturnsFinding | DisagreementFinding | CourierifyStoppedFinding;

/**
 * Why a finding is absent (G-GZR3-3). "Not enough data" and "checked, nothing
 * found" are different answers, and the inbox shows which one it was rather
 * than an empty space.
 */
export type Skip = { kind: "skip"; status: "not_enough_data" | "nothing_found"; reason: string };
const notEnough = (reason: string): Skip => ({ kind: "skip", status: "not_enough_data", reason });
const nothing = (reason: string): Skip => ({ kind: "skip", status: "nothing_found", reason });
export const isSkip = (x: Finding | Skip): x is Skip => x.kind === "skip";

export type FindingsInput = {
  /** The store's own currency (rule #4); a finding about money needs it. */
  currency: string | null;
  rows: readonly RollupOrder[];
  orders: Bucket;
  profit: Profit | null;
  /** Ad spend with platform fees, only when every day of the period is fetched. */
  adSpend: Money[] | null;
  courierify: { connected: boolean; lastParcelDay: string | null };
};

const DECIDED: Outcome[] = ["delivered", "returned"];
const OPEN: Outcome[] = ["in_transit", "booked", "not_shipped"];
const SHIPPED: Outcome[] = ["delivered", "returned", "partially_delivered", "in_transit"];

const fromCourierify = (o: RollupOrder) => o.parcelCount > 0;

export function decidedBy(rows: readonly RollupOrder[]): DecidedBy {
  const courierify = rows.filter(fromCourierify).length;
  return { courierify, financify: rows.length - courierify };
}

/** Percentage with one decimal, from integers, never via a money float. */
const percent = (part: bigint, whole: bigint) => Number((part * 1000n) / whole) / 10;
const pct = (part: number, whole: number) => Math.round((1000 * part) / whole) / 10;

function pick(list: Money[], currency: string): Money {
  return list.find((m) => m.currency === currency) ?? { amount: "0.00", currency };
}

/**
 * Card (a): where the period's delivered revenue went. A ceiling, because
 * courier fees are unknown on most orders and no source records the cost of
 * a return; but open orders can still raise it, so it says that too.
 */
export function marginFinding(input: FindingsInput): MarginFinding | Skip {
  const { currency, profit, adSpend, orders, rows } = input;
  if (!currency || !profit) return notEnough("the store's currency has not been reported");
  if (!adSpend) return notEnough("ad spend is not fetched for every day of this period");
  const revenue = parseAmount(pick(orders.deliveredRevenue, currency).amount)!;
  if (revenue <= 0n) return notEnough("no delivered revenue in this period");
  const ads = pick(adSpend, currency);

  const inCurrency = rows.filter((o) => o.currency === currency);
  const open = inCurrency.filter((o) => OPEN.includes(o.outcome));
  if (open.length > MAX_OPEN_SHARE_FOR_MARGIN * inCurrency.length) {
    return notEnough(
      `${open.length} of ${inCurrency.length} orders are still open; this needs at most ${MAX_OPEN_SHARE_FOR_MARGIN * 100}%, so try a longer period`,
    );
  }
  return {
    kind: "margin",
    ceiling: { amount: profit.amount, currency },
    deliveredRevenue: pick(orders.deliveredRevenue, currency),
    cogsDelivered: pick(orders.cogsDelivered, currency),
    adSpend: ads,
    knownCourierFees: pick(orders.courierFees, currency),
    adsShareOfDelivered: percent(parseAmount(ads.amount)!, revenue),
    delivered: orders.deliveryRate.delivered,
    returned: orders.deliveryRate.returned,
    stillOpen: { orders: open.length, placed: pick(sumByCurrency(open.map((o) => o.placed)), currency) },
    feesUnknown: { orders: orders.shippedOrdersWithoutFee, shipped: orders.shippedOrders },
    cogsIncompleteOrders: orders.cogsIncompleteOrders,
    excludedCurrencies: orders.placed.filter((m) => m.currency !== currency).map((m) => m.currency),
    decidedBy: decidedBy(rows.filter((o) => DECIDED.includes(o.outcome))),
  };
}

/**
 * International orders never get a delivery outcome (report §6), so they are
 * left out of return rates rather than counted as pending.
 */
const domestic = (currency: string) => (o: RollupOrder) => o.currency === currency;

function variantTitle(rows: readonly RollupOrder[], variantId: string): string | null {
  for (const o of rows) {
    for (const l of o.lines) {
      if (l.variantId === variantId && l.title) {
        return l.variantTitle && l.variantTitle !== "Default Title" ? `${l.title} — ${l.variantTitle}` : l.title;
      }
    }
  }
  return null;
}

/**
 * Card (b): variants that come back far more often than the store's own
 * rate. By order (rule #29): no source says which line of a returned order
 * came back, so a returned order counts against every variant in it.
 */
export function variantReturnsFinding(input: FindingsInput): VariantReturnsFinding | Skip {
  const { currency } = input;
  if (!currency) return notEnough("the store's currency has not been reported");
  const rows = input.rows.filter(domestic(currency));
  const decided = rows.filter((o) => DECIDED.includes(o.outcome));
  const returned = decided.filter((o) => o.outcome === "returned").length;
  if (!decided.length) return notEnough("no delivered or returned orders in this period");
  const storeRate = pct(returned, decided.length);

  const rates: VariantRate[] = productLines(rows)
    .filter((p) => !p.variantId.startsWith("product:"))
    .map((p) => {
      const d = p.deliveryRate.delivered + p.deliveryRate.returned;
      return {
        variantId: p.variantId,
        title: variantTitle(rows, p.variantId),
        returned: p.deliveryRate.returned,
        decided: d,
        stillOpen: p.deliveryRate.stillOpen,
        returnRate: d ? pct(p.deliveryRate.returned, d) : 0,
      };
    })
    .filter((v) => v.decided >= MIN_DECIDED_PER_VARIANT)
    .sort((a, b) => b.decided - a.decided || a.variantId.localeCompare(b.variantId));

  const flagged = rates
    .filter((v) => v.returnRate - storeRate >= MIN_RETURN_GAP_POINTS)
    .sort((a, b) => b.returnRate - a.returnRate);
  if (!rates.length) return notEnough(`no product has ${MIN_DECIDED_PER_VARIANT} delivered or returned orders in this period`);
  if (!flagged.length) {
    return nothing(
      `none of ${rates.length} product(s) returns ${MIN_RETURN_GAP_POINTS}+ points above the store's ${storeRate.toFixed(1)}%`,
    );
  }

  const flaggedIds = new Set(flagged.map((v) => v.variantId));
  const behind = rows.filter((o) => DECIDED.includes(o.outcome) && o.lines.some((l) => l.variantId && flaggedIds.has(l.variantId)));
  return {
    kind: "variant_returns",
    store: { returned, decided: decided.length, returnRate: storeRate },
    flagged,
    bestSellers: rates.filter((v) => !flaggedIds.has(v.variantId)).slice(0, 2),
    internationalExcluded: input.rows.length - rows.length,
    decidedBy: decidedBy(behind),
  };
}

/**
 * A disagreement matters when either app says delivered or returned and the
 * other says something else. "Booked" against "pending" is two ways of
 * saying "not shipped yet", and is left out.
 */
export function disagrees(o: RollupOrder): boolean {
  if (!fromCourierify(o) || !o.financifyOutcome || o.financifyOutcome === o.outcome) return false;
  return DECIDED.includes(o.outcome) || DECIDED.includes(o.financifyOutcome);
}

/**
 * Card (c): orders where the courier (through Courierify) and Financify
 * disagree on what happened. Courierify decides (rule #7); the card shows
 * what Financify's own screens count differently.
 */
export function disagreementFinding(input: FindingsInput): DisagreementFinding | Skip {
  const both = input.rows.filter((o) => fromCourierify(o) && o.financifyOutcome);
  if (!both.length) return notEnough("no order in this period is known to both Courierify and Financify");
  const found = both.filter(disagrees);
  if (found.length < MIN_DISAGREEMENTS) {
    return nothing(`${found.length} material disagreement(s) among ${both.length} orders both apps know; it takes ${MIN_DISAGREEMENTS}`);
  }

  const groups = new Map<string, RollupOrder[]>();
  for (const o of found) {
    const key = `${o.financifyOutcome}|${o.outcome}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return {
    kind: "disagreements",
    total: found.length,
    groups: [...groups.entries()]
      .map(([key, list]) => {
        const [financify, courier] = key.split("|") as [Outcome, Outcome];
        return { financify, courier, orders: list.length, placed: sumByCurrency(list.map((o) => o.placed)) };
      })
      .sort((a, b) => b.orders - a.orders || a.financify.localeCompare(b.financify)),
    bothApps: both.length,
    filter: { kind: "disagree" },
  };
}

/**
 * Card (d): the store stopped booking through Courierify. Delivery outcomes
 * still arrive, from Financify, but courier times, city and courier fees do
 * not, and every other card loses its Courierify half.
 */
export function courierifyStoppedFinding(input: FindingsInput): CourierifyStoppedFinding | Skip {
  const { connected, lastParcelDay } = input.courierify;
  if (!connected) return nothing("Courierify is not connected");
  if (!lastParcelDay) return nothing("the store has never shipped through Courierify");
  const shipped = input.rows.filter((o) => SHIPPED.includes(o.outcome));
  const withParcel = shipped.filter(fromCourierify).length;
  if (shipped.length < MIN_SHIPPED_FOR_COVERAGE) {
    return notEnough(`${shipped.length} shipped order(s) in this period; it takes ${MIN_SHIPPED_FOR_COVERAGE}`);
  }
  if (withParcel / shipped.length >= 0.5) return nothing(`${withParcel} of ${shipped.length} shipped orders went through Courierify`);
  return {
    kind: "courierify_stopped",
    lastParcelDay,
    shipped: shipped.length,
    withParcel,
    filter: { kind: "decided_by", app: "financify" },
  };
}

const feeMissing = (o: RollupOrder) => fromCourierify(o) && SHIPPED.includes(o.outcome) && !o.courierFee;

/**
 * I13 (PLAN.md §4): shipped orders whose courier fee Courierify does not
 * record, so every profit after courier fees overstates. Courierify-booked
 * parcels only: those are the gap someone can close (the fee arrives through
 * Courierify's courier_costs metafield, rule #13). Orders shipped outside
 * Courierify have no fee source at all; they are counted, not the finding
 * (the "Courierify stopped" card covers them). Counts only: the median-fee
 * estimate waits for its backtest (the money rule).
 */
export function missingFeesFinding(input: FindingsInput): MissingFeesFinding | Skip {
  const shipped = input.rows.filter((o) => SHIPPED.includes(o.outcome));
  const via = shipped.filter(fromCourierify);
  const outsideCourierify = shipped.length - via.length;
  if (!via.length) {
    return notEnough(
      shipped.length
        ? `none of ${shipped.length} shipped order(s) went through Courierify, so there is no fee to be missing; they have no fee source at all`
        : "no shipped orders in this period",
    );
  }
  const missing = via.filter(feeMissing);
  if (missing.length < MIN_MISSING_FEES) {
    return nothing(`${missing.length} of ${via.length} orders shipped through Courierify lack a fee; it takes ${MIN_MISSING_FEES}`);
  }
  const couriers = new Map<string, { missing: number; shipped: number }>();
  for (const o of via) {
    const key = o.courier ?? "unknown";
    const c = couriers.get(key) ?? { missing: 0, shipped: 0 };
    c.shipped += 1;
    if (!o.courierFee) c.missing += 1;
    couriers.set(key, c);
  }
  return {
    kind: "missing_fees",
    missing: missing.length,
    viaCourierify: via.length,
    byCourier: [...couriers.entries()]
      .filter(([, c]) => c.missing)
      .map(([courier, c]) => ({ courier, ...c }))
      .sort((a, b) => b.missing - a.missing || a.courier.localeCompare(b.courier)),
    via3pl: missing.filter((o) => o.fulfilledVia).length,
    outsideCourierify,
    filter: { kind: "fee_missing" },
  };
}

/** Every finding that passes its gate. Ranking lives in app/lib/insights. */
export function findings(input: FindingsInput): Finding[] {
  return [
    disagreementFinding(input),
    variantReturnsFinding(input),
    marginFinding(input),
    courierifyStoppedFinding(input),
    missingFeesFinding(input),
  ].filter((f): f is Finding => !isSkip(f));
}

// ── Drill-down: the same predicates, for the Orders list ─────────────────────

export function parseOrderFilter(params: URLSearchParams): OrderFilter | null {
  const variant = params.get("variant");
  if (variant && /^\d+$/.test(variant)) return { kind: "variant", variantId: variant };
  if (params.get("disagree") === "1") return { kind: "disagree" };
  if (params.get("feeMissing") === "1") return { kind: "fee_missing" };
  const by = params.get("decidedBy");
  if (by === "financify" || by === "courierify") return { kind: "decided_by", app: by };
  return null;
}

export function orderFilterQuery(filter: OrderFilter): string {
  switch (filter.kind) {
    case "variant":
      return `variant=${filter.variantId}`;
    case "disagree":
      return "disagree=1";
    case "decided_by":
      return `decidedBy=${filter.app}`;
    case "fee_missing":
      return "feeMissing=1";
  }
}

/**
 * Whether an order belongs to a filter. `currency` is the store's: the
 * variant filter leaves out international orders exactly as the card does.
 */
export function matchesFilter(o: RollupOrder, filter: OrderFilter, currency: string | null): boolean {
  switch (filter.kind) {
    case "variant":
      return o.currency === currency && o.lines.some((l) => l.variantId === filter.variantId);
    case "disagree":
      return disagrees(o);
    case "decided_by":
      return filter.app === "courierify" ? fromCourierify(o) : !fromCourierify(o);
    case "fee_missing":
      return feeMissing(o);
  }
}
