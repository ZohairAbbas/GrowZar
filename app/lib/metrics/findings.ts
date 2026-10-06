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
import { AGE_BUCKETS, ageOf, type AgeFilter } from "./matrices";
import { formatAmount, isPositive, parseAmount, sumByCurrency, type Money } from "./money";
import type { Outcome } from "./order-grain";
import { productLines, type Bucket, type Profit, type RollupOrder } from "./rollups";
import type { PayerHistory } from "./settlements";
import { times, type ReturnCost } from "./return-cost";

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
/** I8 (PLAN.md §4): decided orders needed in each group compared. */
export const MIN_DECIDED_PER_CONFIRMATION_GROUP = 100;
/** I8: how much more often unanswered orders must come back, in points. */
export const MIN_CONFIRMATION_GAP_POINTS = 5;
/**
 * I8: an unanswered order still worth a call was placed this recently. Older
 * ones that never shipped are abandoned, not waiting (on 0dscam-qn, 22 of 43
 * "not shipped" unanswered orders in 90 days were over a week old).
 */
export const WAITING_MAX_AGE_DAYS = 7;
/** I8: declined-but-shipped orders needed before their line is shown. */
export const MIN_DECLINED_SHIPPED = 10;

/** I2 (PLAN.md §4): decided orders a product needs, and the loss per 30 days worth saying. */
export const MIN_DECIDED_FOR_PRODUCT_LOSS = 30;
export const MIN_PRODUCT_LOSS_PER_30_DAYS = 15_000n * 1_000_000n;
/** I12 (PLAN.md §4): decided orders a city needs, and how far above the rest it must return. */
export const MIN_DECIDED_FOR_CITY = 100;
export const MIN_CITY_GAP_POINTS = 10;

/** I1 (PLAN.md §4): delivered-or-returned orders a route needs in a city. */
export const MIN_DECIDED_PER_ROUTE = 50;
/** I1: the smallest gap worth saying, in points (PLAN.md §4). */
export const MIN_ROUTE_GAP_POINTS = 3;
/**
 * I1: the gap must also be unlikely to be chance: a two-proportion z-test at
 * 95%. PLAN's 3 points alone is too loose at these sizes: on 0dscam-qn,
 * 80.4% of 163 against 72.4% of 123 in Karachi is z = 1.6, within chance.
 */
export const MIN_ROUTE_Z = 1.96;

/** I4 (PLAN.md §4): outstanding COD above this, or a payout this many days late. */
export const CASH_HELD_MIN_PKR = 50_000n * 1_000_000n;
export const CASH_HELD_LATE_DAYS = 7;
/** Days past a payer's own gap before a delivery counts as "should be paid by now". */
export const CASH_HELD_GRACE_DAYS = 3;
/** Shipped orders needed before "Courierify stopped" is said at all. */
export const MIN_SHIPPED_FOR_COVERAGE = 20;

/** Orders whose outcome each app decided (rule #7): a parcel means Courierify. */
export type DecidedBy = { courierify: number; financify: number };

export type OrderFilter =
  | { kind: "variant"; variantId: string }
  | { kind: "disagree" }
  | { kind: "decided_by"; app: "financify" | "courierify" }
  | { kind: "fee_missing" }
  | { kind: "awaiting_payout"; payer: string }
  | { kind: "unanswered_waiting" }
  | { kind: "city_route"; city: string; courier: string; via: string }
  | { kind: "city"; city: string }
  /** D4's payout ageing cell: unpaid delivered COD of one courier, of one age. */
  | { kind: "unpaid"; courier: string; age: AgeFilter };

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
  /** Flagged products only: returns beyond the store's own rate, and their courier charges. */
  excessReturns?: number;
  cost?: CostEstimate | null;
};

/**
 * Courier charges on returns, estimated from the store's measured cost of a
 * return (return-cost.ts). Approved for cards on 2026-10-06; I1 waits for a
 * backtest that can be checked.
 */
export type CostEstimate = { total: Money; perReturn: Money; returns: number; pricedReturns: number };

function returnsCost(n: number, rc: ReturnCost | null | undefined): CostEstimate | null {
  if (!rc || n <= 0) return null;
  return { total: times(rc.perReturn, n), perReturn: rc.perReturn, returns: n, pricedReturns: rc.priced };
}

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
  /** missing × the median known fee on the same period's Courierify orders; null below 30 priced. */
  estimate: { total: Money; medianFee: Money; pricedOrders: number } | null;
  filter: OrderFilter;
};

export type CashHeldFinding = {
  kind: "cash_held";
  /** Who pays: the 3PL when there is one, else the courier. */
  payer: string;
  /** Delivered orders past the payer's own gap with no payout recorded. */
  orders: number;
  /** Their COD, per currency (rule #4). */
  cod: Money[];
  oldestDay: string | null;
  lastPaidDay: string;
  medianGapDays: number;
  /** An order counts once delivered this many days ago: the gap plus grace. */
  dueAfterDays: number;
  /** Days since the last payout, beyond the payer's own gap. */
  daysLate: number;
  disputed: number;
  asOf: string;
  /** Payers with delivered, unpaid orders but too few payouts to judge. */
  notJudged: Array<{ payer: string; orders: number }>;
  filter: OrderFilter;
};

export type ProductLossFinding = {
  kind: "product_loss";
  variantId: string;
  title: string | null;
  /** Domestic orders in the period containing it (what its link lists). */
  orders: number;
  decided: number;
  returned: number;
  returnRate: number;
  stillOpen: number;
  /** Financify's allocation of ad spend to this product, before platform fees. */
  adSpend: Money;
  /** Had every order been delivered: placed line value − its cost − ads. */
  ifAllDelivered: Money;
  /** As delivered: delivered line value − its cost − ads. A ceiling. */
  ceiling: Money;
  deliveredValue: Money;
  deliveredCost: Money;
  /** The ceiling scaled to 30 days of this period. */
  per30Days: Money;
  periodDays: number;
  /** Delivered lines with no cost: not subtracted, so the ceiling flatters. */
  linesWithoutCost: number;
};

export type CityReturnsFinding = {
  kind: "city_returns";
  city: string;
  decided: number;
  returned: number;
  returnRate: number;
  /** The rest of the store, over the same period, for comparison. */
  rest: { decided: number; returned: number; returnRate: number };
  z: number;
  lastDay: string;
  /** Orders in the city (what its link lists). */
  orders: number;
};

/** A courier as booked: directly, or through a 3PL ("orio"). */
export type Route = { courier: string; via: string };

export type RouteRate = Route & { decided: number; delivered: number; rate: number; firstDay: string; lastDay: string };

export type CourierCityFinding = {
  kind: "courier_for_city";
  city: string;
  best: RouteRate;
  /** Routes significantly worse than `best` in this city, worst first. */
  worse: Array<RouteRate & { gapPoints: number; z: number }>;
  /** The latest order day compared: city is known only for Courierify-booked orders. */
  lastDay: string;
};

export type ConfirmationGroup = { orders: number; returned: number; decided: number; returnRate: number };

export type UnconfirmedFinding = {
  kind: "unconfirmed_returns";
  confirmed: ConfirmationGroup;
  /** Asked over WhatsApp and never answered (timed out or expired). */
  unanswered: ConfirmationGroup;
  /** Declined, shipped anyway; null below MIN_DECLINED_SHIPPED decided. */
  declinedShipped: ConfirmationGroup | null;
  /** Unanswered and not yet with the courier: the ones a call can still save. */
  waiting: number;
  /** Returns among unanswered orders beyond what the confirmed rate would give. */
  excessReturns: number;
  /** Their courier charges at the store's measured cost of a return. */
  cost: CostEstimate | null;
  /** Orders with no WhatsApp confirmation record (voice is not synced): left out. */
  noRecord: number;
  /** Who decided the outcomes compared (rule #7). */
  decidedBy: DecidedBy;
  filter: OrderFilter;
};

export type Finding = ProductLossFinding | CityReturnsFinding | CourierCityFinding | UnconfirmedFinding | CashHeldFinding | MissingFeesFinding | MarginFinding | VariantReturnsFinding | DisagreementFinding | CourierifyStoppedFinding;

/**
 * Why a finding is absent (G-GZR3-3). "Not enough data" and "checked, nothing
 * found" are different answers, and the inbox shows which one it was rather
 * than an empty space.
 */
export type Skip = { kind: "skip"; status: "not_enough_data" | "nothing_found"; reason: string };
const notEnough = (reason: string): Skip => ({ kind: "skip", status: "not_enough_data", reason });
const nothing = (reason: string): Skip => ({ kind: "skip", status: "nothing_found", reason });
export const isSkip = (x: Finding | Skip): x is Skip => x.kind === "skip";

/**
 * I4's input: store-wide, as of now, not the chosen period. Cash a courier
 * holds is today's state, whenever the order was placed.
 */
export type CashInput = {
  asOf: Date;
  payers: PayerHistory[];
  /** Delivered orders through Courierify whose COD no settlement covers (any date). */
  awaiting: RollupOrder[];
};

export type FindingsInput = {
  /** The store's own currency (rule #4); a finding about money needs it. */
  currency: string | null;
  rows: readonly RollupOrder[];
  orders: Bucket;
  profit: Profit | null;
  /** Ad spend with platform fees, only when every day of the period is fetched. */
  adSpend: Money[] | null;
  courierify: { connected: boolean; lastParcelDay: string | null };
  /** I4 only; absent where it was not loaded. */
  cash?: CashInput;
  /** "Now", for anything judged by age (I8's waiting orders). */
  asOf?: Date;
  /**
   * I2: Financify's ad spend allocated per variant over the period (before
   * platform fees), only when every day of the period is fetched.
   */
  adByVariant?: Record<string, Money[]>;
  periodDays?: number;
  /** The store's measured courier charge on a return (return-cost.ts); null when not enough is known. */
  returnCost?: ReturnCost | null;
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
    .sort((a, b) => b.returnRate - a.returnRate)
    .map((v) => {
      // Returns beyond what the store's own rate would give, and their courier charges.
      const excessReturns = Math.max(0, v.returned - Math.round((v.decided * storeRate) / 100));
      return { ...v, excessReturns, cost: returnsCost(excessReturns, input.returnCost) };
    });
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
 * (the "Courierify stopped" card covers them). The estimate (approved
 * 2026-10-06) is missing × the median fee known on the same period's
 * Courierify orders, and only with 30 of them priced.
 */
/** Priced orders needed before the median fee is used for an estimate. */
export const MIN_PRICED_FOR_FEE_ESTIMATE = 30;

function medianFeeEstimate(via: readonly RollupOrder[], missing: number, currency: string | null): MissingFeesFinding["estimate"] {
  if (!currency) return null;
  const fees = via
    .map((o) => (o.courierFee && o.courierFee.currency === currency ? parseAmount(o.courierFee.amount) : null))
    .filter((f): f is bigint => f !== null && f > 0n)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (fees.length < MIN_PRICED_FOR_FEE_ESTIMATE) return null;
  const mid = Math.floor(fees.length / 2);
  const median = fees.length % 2 ? fees[mid]! : (fees[mid - 1]! + fees[mid]!) / 2n;
  const medianFee = asMoney(median, currency);
  return { total: times(medianFee, missing), medianFee, pricedOrders: fees.length };
}

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
    estimate: medianFeeEstimate(via, missing.length, input.currency),
    filter: { kind: "fee_missing" },
  };
}

const routeOf = (o: RollupOrder): Route => ({ courier: o.courier ?? "unknown", via: o.fulfilledVia ?? "direct" });
const inCityRoute = (o: RollupOrder, city: string, r: Route) =>
  fromCourierify(o) && o.city === city && routeOf(o).courier === r.courier && routeOf(o).via === r.via;

/** Two-proportion z for p1 > p2 (pooled). */
function zScore(d1: number, n1: number, d2: number, n2: number): number {
  const p = (d1 + d2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se ? (d1 / n1 - d2 / n2) / se : 0;
}

/**
 * I1: a better route (courier, and whether booked directly or through a 3PL)
 * for a city, by delivery rate (rule #8, by order). Only Courierify-booked
 * orders have a city (rule #12), so the card says when its data ends. Fees
 * are not compared: they are recorded on only part of these orders (I13).
 * No money: PLAN's impact formula waits for its backtest.
 */
export function courierCityFindings(input: FindingsInput): CourierCityFinding[] | Skip {
  if (!input.currency) return notEnough("the store's currency has not been reported");
  const rows = input.rows.filter((o) => fromCourierify(o) && o.city && o.currency === input.currency);
  if (!rows.length) {
    return notEnough("no order in this period shipped through Courierify with a city: routes need to know how a parcel was booked, which only Courierify says");
  }
  const cities = new Map<string, Map<string, RollupOrder[]>>();
  for (const o of rows) {
    const r = routeOf(o);
    const key = `${r.courier}|${r.via}`;
    const byRoute = cities.get(o.city!) ?? new Map<string, RollupOrder[]>();
    byRoute.set(key, [...(byRoute.get(key) ?? []), o]);
    cities.set(o.city!, byRoute);
  }
  const out: CourierCityFinding[] = [];
  let comparable = 0;
  for (const [city, byRoute] of cities) {
    const rates: RouteRate[] = [...byRoute.entries()]
      .map(([key, list]) => {
        const [courier, via] = key.split("|") as [string, string];
        const decided = list.filter((o) => DECIDED.includes(o.outcome));
        const delivered = decided.filter((o) => o.outcome === "delivered").length;
        const days = list.map((o) => o.localDay ?? "").filter(Boolean).sort();
        return { courier, via, decided: decided.length, delivered, rate: decided.length ? pct(delivered, decided.length) : 0, firstDay: days[0] ?? "", lastDay: days.at(-1) ?? "" };
      })
      .filter((r) => r.decided >= MIN_DECIDED_PER_ROUTE)
      .sort((a, b) => b.rate - a.rate || b.decided - a.decided);
    if (rates.length < 2) continue;
    comparable += 1;
    const best = rates[0]!;
    const worse = rates
      .slice(1)
      .map((r) => ({ ...r, gapPoints: Math.round((best.rate - r.rate) * 10) / 10, z: Math.round(zScore(best.delivered, best.decided, r.delivered, r.decided) * 100) / 100 }))
      .filter((r) => r.gapPoints >= MIN_ROUTE_GAP_POINTS && r.z >= MIN_ROUTE_Z)
      .sort((a, b) => b.gapPoints - a.gapPoints);
    if (!worse.length) continue;
    out.push({ kind: "courier_for_city", city, best, worse, lastDay: [best, ...worse].map((r) => r.lastDay).sort().at(-1)! });
  }
  if (!out.length) {
    return comparable
      ? nothing(`in ${comparable} city(ies) with two routes of ${MIN_DECIDED_PER_ROUTE}+ orders, no gap of ${MIN_ROUTE_GAP_POINTS}+ points that is unlikely to be chance`)
      : notEnough(`no city has two routes with ${MIN_DECIDED_PER_ROUTE} delivered or returned orders each in this period`);
  }
  return out.sort((a, b) => b.worse[0]!.gapPoints - a.worse[0]!.gapPoints || a.city.localeCompare(b.city));
}

const units = (m: Money | null | undefined, currency: string) => (m && m.currency === currency ? parseAmount(m.amount)! : 0n);
const asMoney = (u: bigint, currency: string): Money => ({ amount: formatAmount(u), currency });

/**
 * I2: a product that would be profitable if every order were delivered, and
 * is not, as delivered. One-sided on purpose: the "as delivered" figure is a
 * ceiling (no courier fees, no return costs, ads before platform fees, lines
 * without a cost not subtracted), so a negative ceiling is a loss whatever
 * the missing numbers turn out to be. Lines carry their own value and
 * order-time cost (rule #14); returns are by order (rule #29).
 */
export function productLossFindings(input: FindingsInput): ProductLossFinding[] | Skip {
  const currency = input.currency;
  if (!currency) return notEnough("the store's currency has not been reported");
  if (!input.adByVariant || !input.periodDays) return notEnough("ad spend per product is not fetched for every day of this period");
  const rows = input.rows.filter(domestic(currency));
  const out: ProductLossFinding[] = [];
  let compared = 0;
  for (const p of productLines(rows)) {
    if (p.variantId.startsWith("product:")) continue;
    const decided = p.deliveryRate.delivered + p.deliveryRate.returned;
    if (decided < MIN_DECIDED_FOR_PRODUCT_LOSS) continue;
    const mine = rows.filter((o) => o.lines.some((l) => l.variantId === p.variantId));
    const live = mine.filter((o) => !["order_cancelled", "shipment_cancelled"].includes(o.outcome));
    // Ads count in full from day one, revenue only on delivery: a young
    // period reads as a loss (the margin card's rule, for the same reason).
    if (p.deliveryRate.stillOpen > MAX_OPEN_SHARE_FOR_MARGIN * live.length) continue;
    compared += 1;
    const lines = (list: RollupOrder[]) => list.flatMap((o) => o.lines.filter((l) => l.variantId === p.variantId));
    const placedLines = lines(live);
    const deliveredLines = lines(mine.filter((o) => o.outcome === "delivered"));
    const ads = (input.adByVariant[p.variantId] ?? []).reduce((a, m) => a + units(m, currency), 0n);
    const sum = (ls: typeof placedLines, f: "value" | "cost") => ls.reduce((a, l) => a + units(l[f], currency), 0n);
    const ifAll = sum(placedLines, "value") - sum(placedLines, "cost") - ads;
    const ceiling = sum(deliveredLines, "value") - sum(deliveredLines, "cost") - ads;
    const per30 = (ceiling * 30n) / BigInt(input.periodDays);
    if (!(ifAll > 0n && ceiling < 0n && -per30 >= MIN_PRODUCT_LOSS_PER_30_DAYS)) continue;
    out.push({
      kind: "product_loss",
      variantId: p.variantId,
      title: variantTitle(rows, p.variantId),
      orders: mine.length,
      decided,
      returned: p.deliveryRate.returned,
      returnRate: pct(p.deliveryRate.returned, decided),
      stillOpen: p.deliveryRate.stillOpen,
      adSpend: asMoney(ads, currency),
      ifAllDelivered: asMoney(ifAll, currency),
      ceiling: asMoney(ceiling, currency),
      deliveredValue: asMoney(sum(deliveredLines, "value"), currency),
      deliveredCost: asMoney(sum(deliveredLines, "cost"), currency),
      per30Days: asMoney(per30, currency),
      periodDays: input.periodDays,
      linesWithoutCost: deliveredLines.filter((l) => !l.cost).length,
    });
  }
  if (!out.length) {
    return compared
      ? nothing(`none of ${compared} product(s) with ${MIN_DECIDED_FOR_PRODUCT_LOSS}+ decided orders loses money as delivered while looking profitable as placed`)
      : notEnough(`no product has ${MIN_DECIDED_FOR_PRODUCT_LOSS} delivered or returned orders with most of its orders resolved`);
  }
  return out.sort((a, b) => parseAmount(a.ceiling.amount)! < parseAmount(b.ceiling.amount)! ? -1 : 1);
}

/**
 * I12: a city whose orders come back far more often than the rest of the
 * store's. Profit per city is not computed: ad spend is not allocated by
 * city, and courier fees and return costs are mostly unrecorded, so the
 * PLAN's "negative profit" cannot be shown honestly; the return rate can.
 * City exists only for Courierify-booked orders (rule #12).
 */
export function cityReturnsFindings(input: FindingsInput): CityReturnsFinding[] | Skip {
  const currency = input.currency;
  if (!currency) return notEnough("the store's currency has not been reported");
  const rows = input.rows.filter(domestic(currency));
  const decidedAll = rows.filter((o) => DECIDED.includes(o.outcome));
  // Courierify's city, or Financify's in Courierify's names (G-FIN2-2).
  const withCity = rows.filter((o) => o.city);
  if (!withCity.length) return notEnough("no order in this period has a city");
  const cities = [...new Set(withCity.map((o) => o.city!))];
  const out: CityReturnsFinding[] = [];
  let compared = 0;
  for (const city of cities) {
    const mine = withCity.filter((o) => o.city === city);
    const dec = mine.filter((o) => DECIDED.includes(o.outcome));
    if (dec.length < MIN_DECIDED_FOR_CITY) continue;
    compared += 1;
    const ret = dec.filter((o) => o.outcome === "returned").length;
    const restDec = decidedAll.filter((o) => o.city !== city);
    const restRet = restDec.filter((o) => o.outcome === "returned").length;
    if (!restDec.length) continue;
    const rate = pct(ret, dec.length);
    const restRate = pct(restRet, restDec.length);
    const z = Math.round(zScore(ret, dec.length, restRet, restDec.length) * 100) / 100;
    if (rate - restRate < MIN_CITY_GAP_POINTS || z < MIN_ROUTE_Z) continue;
    out.push({
      kind: "city_returns",
      city,
      decided: dec.length,
      returned: ret,
      returnRate: rate,
      rest: { decided: restDec.length, returned: restRet, returnRate: restRate },
      z,
      lastDay: mine.map((o) => o.localDay ?? "").sort().at(-1) ?? "",
      orders: mine.length,
    });
  }
  if (!out.length) {
    return compared
      ? nothing(`none of ${compared} city(ies) with ${MIN_DECIDED_FOR_CITY}+ decided orders returns ${MIN_CITY_GAP_POINTS}+ points above the rest of the store`)
      : notEnough(`no city has ${MIN_DECIDED_FOR_CITY} delivered or returned orders in this period`);
  }
  return out.sort((a, b) => b.returnRate - a.returnRate);
}

const UNANSWERED = ["timed_out", "expired"];
const isUnanswered = (o: RollupOrder) => !!o.confirmation && UNANSWERED.includes(o.confirmation);
/** Not yet with the courier, so a call can still stop or fix it. */
const NOT_YET_SHIPPED: Outcome[] = ["not_shipped", "booked"];
const unansweredWaiting = (o: RollupOrder, asOf: Date) =>
  isUnanswered(o) &&
  NOT_YET_SHIPPED.includes(o.outcome) &&
  !!o.createdAt &&
  asOf.getTime() - o.createdAt.getTime() <= WAITING_MAX_AGE_DAYS * 86_400_000;

function group(list: readonly RollupOrder[]): ConfirmationGroup {
  const decided = list.filter((o) => DECIDED.includes(o.outcome));
  const returned = decided.filter((o) => o.outcome === "returned").length;
  return { orders: list.length, returned, decided: decided.length, returnRate: decided.length ? pct(returned, decided.length) : 0 };
}

/**
 * I8: orders the buyer never answered on WhatsApp come back more often than
 * confirmed ones. Confirmation from Courierify, outcome by rule #7. Only
 * WhatsApp confirmations are synced, so an order with no record is unknown
 * (a voice call may have confirmed it), never counted as unconfirmed.
 * Counts only: "× cost of a return" waits for its backtest.
 */
export function unconfirmedFinding(input: FindingsInput): UnconfirmedFinding | Skip {
  if (!input.currency) return notEnough("the store's currency has not been reported");
  const rows = input.rows.filter(domestic(input.currency));
  const confirmed = group(rows.filter((o) => o.confirmation === "confirmed"));
  const unanswered = group(rows.filter(isUnanswered));
  const min = MIN_DECIDED_PER_CONFIRMATION_GROUP;
  if (confirmed.decided < min || unanswered.decided < min) {
    return notEnough(
      `${confirmed.decided} confirmed and ${unanswered.decided} unanswered orders delivered or returned; each needs ${min}`,
    );
  }
  const gap = unanswered.returnRate - confirmed.returnRate;
  if (gap < MIN_CONFIRMATION_GAP_POINTS) {
    return nothing(
      `unanswered orders return ${unanswered.returnRate.toFixed(1)}% against ${confirmed.returnRate.toFixed(1)}% confirmed; it takes ${MIN_CONFIRMATION_GAP_POINTS} points`,
    );
  }
  const declined = group(rows.filter((o) => o.confirmation === "declined"));
  const excessReturns = Math.max(0, unanswered.returned - Math.round((unanswered.decided * confirmed.returnRate) / 100));
  return {
    kind: "unconfirmed_returns",
    confirmed,
    unanswered,
    declinedShipped: declined.decided >= MIN_DECLINED_SHIPPED ? declined : null,
    waiting: rows.filter((o) => unansweredWaiting(o, input.asOf ?? new Date())).length,
    excessReturns,
    cost: returnsCost(excessReturns, input.returnCost),
    noRecord: rows.filter((o) => !o.confirmation).length,
    decidedBy: decidedBy(rows.filter((o) => DECIDED.includes(o.outcome) && (o.confirmation === "confirmed" || isUnanswered(o)))),
    filter: { kind: "unanswered_waiting" },
  };
}

/** The 3PL that booked it if there was one (it pays), else the courier. */
export const payerOf = (o: RollupOrder) => o.fulfilledVia ?? o.courier ?? "unknown";

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Should this order's COD have been paid by now? Delivered (by the time the
 * status was seen) longer ago than the payer's own gap plus a grace period.
 */
export function isDue(o: RollupOrder, h: PayerHistory, asOf: Date): boolean {
  // Nothing to collect (a prepaid parcel's COD is 0.00) is never "owed".
  if (h.medianGapDays === null || !isPositive(o.uncollected)) return false;
  const at = o.outcomeTiming?.at ?? o.createdAt;
  if (!at) return false;
  return asOf.getTime() - at.getTime() > (h.medianGapDays + CASH_HELD_GRACE_DAYS) * 86_400_000;
}

/**
 * I4: COD a courier or 3PL has not paid, judged against its own payout
 * rhythm on this store. Courierify data alone (D-47's exception).
 * "Not recorded as paid" is what the data shows; whether the money arrived
 * elsewhere (a 3PL paying outside Courierify) is for the card to say.
 */
export function cashHeldFindings(input: FindingsInput): CashHeldFinding[] | Skip {
  const cash = input.cash;
  if (!cash) return notEnough("settlement history is not loaded");
  const owed = cash.awaiting.filter((o) => isPositive(o.uncollected));
  if (!owed.length) return nothing("every delivered order through Courierify with COD to collect has a payout recorded");
  const asOf = dayOf(cash.asOf);
  const history = new Map(cash.payers.map((h) => [h.payer, h]));
  const byPayer = new Map<string, RollupOrder[]>();
  for (const o of owed) byPayer.set(payerOf(o), [...(byPayer.get(payerOf(o)) ?? []), o]);

  const notJudged = [...byPayer.entries()]
    .filter(([payer]) => history.get(payer)?.medianGapDays == null)
    .map(([payer, list]) => ({ payer, orders: list.length }))
    .sort((a, b) => b.orders - a.orders || a.payer.localeCompare(b.payer));

  const out: CashHeldFinding[] = [];
  for (const [payer, list] of byPayer) {
    const h = history.get(payer);
    if (!h || h.medianGapDays === null || !h.lastPaidDay) continue;
    const due = list.filter((o) => isDue(o, h, cash.asOf));
    if (!due.length) continue;
    const cod = sumByCurrency(due.map((o) => o.uncollected));
    // Calendar days, last payout day to today: not hours rounded to days.
    const sinceLast = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${h.lastPaidDay}T00:00:00Z`)) / 86_400_000);
    const daysLate = Math.max(0, sinceLast - h.medianGapDays);
    const pkr = parseAmount(cod.find((m) => m.currency === "PKR")?.amount ?? "0")!;
    if (pkr <= CASH_HELD_MIN_PKR && daysLate <= CASH_HELD_LATE_DAYS) continue;
    const days = due.map((o) => (o.outcomeTiming?.at ?? o.createdAt)!).sort((a, b) => a.getTime() - b.getTime());
    out.push({
      kind: "cash_held",
      payer,
      orders: due.length,
      cod,
      oldestDay: days[0] ? dayOf(days[0]) : null,
      lastPaidDay: h.lastPaidDay,
      medianGapDays: h.medianGapDays,
      dueAfterDays: h.medianGapDays + CASH_HELD_GRACE_DAYS,
      daysLate,
      disputed: h.disputed,
      asOf,
      notJudged,
      filter: { kind: "awaiting_payout", payer },
    });
  }
  if (!out.length) {
    return notJudged.length && notJudged.length === byPayer.size
      ? notEnough(`${notJudged.map((p) => p.payer).join(", ")}: too few payouts recorded to know when they pay`)
      : nothing("no payer is late or holding more than 50,000 PKR beyond its usual gap");
  }
  return out.sort((a, b) => b.orders - a.orders || a.payer.localeCompare(b.payer));
}

/** Every finding that passes its gate. Ranking lives in app/lib/insights. */
export function findings(input: FindingsInput): Finding[] {
  const single: Array<Finding | Skip> = [
    disagreementFinding(input),
    variantReturnsFinding(input),
    marginFinding(input),
    courierifyStoppedFinding(input),
    missingFeesFinding(input),
    unconfirmedFinding(input),
  ];
  const many = (l: Finding[] | Skip): Finding[] => (Array.isArray(l) ? l : []);
  const lists = [
    ...many(cashHeldFindings(input)),
    ...many(courierCityFindings(input)),
    ...many(productLossFindings(input)),
    ...many(cityReturnsFindings(input)),
  ];
  return [...single.filter((f): f is Finding => !isSkip(f)), ...lists];
}

// ── Drill-down: the same predicates, for the Orders list ─────────────────────

export function parseOrderFilter(params: URLSearchParams): OrderFilter | null {
  const variant = params.get("variant");
  if (variant && /^\d+$/.test(variant)) return { kind: "variant", variantId: variant };
  if (params.get("disagree") === "1") return { kind: "disagree" };
  if (params.get("feeMissing") === "1") return { kind: "fee_missing" };
  const unpaid = params.get("unpaid");
  const age = params.get("age");
  if (unpaid && /^[a-z0-9_-]{1,40}$/.test(unpaid)) {
    // No age: every unpaid order of that courier (an untracked courier's list).
    if (!age) return { kind: "unpaid", courier: unpaid, age: "any" };
    if (([...AGE_BUCKETS.map((b) => b.key), "unknown"] as string[]).includes(age)) return { kind: "unpaid", courier: unpaid, age: age as AgeFilter };
  }
  const awaiting = params.get("awaitingPayout");
  if (awaiting && /^[a-z0-9_-]{1,40}$/.test(awaiting)) return { kind: "awaiting_payout", payer: awaiting };
  if (params.get("unanswered") === "waiting") return { kind: "unanswered_waiting" };
  const city = params.get("city");
  const courier = params.get("courier");
  const via = params.get("via");
  if (city && courier && via && /^[\p{L}\p{N} .'()-]{1,60}$/u.test(city) && /^[a-z0-9_-]{1,40}$/.test(courier) && /^[a-z0-9_-]{1,40}$/.test(via)) {
    return { kind: "city_route", city, courier, via };
  }
  if (city && !courier && /^[\p{L}\p{N} .'()-]{1,60}$/u.test(city)) return { kind: "city", city };
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
    case "awaiting_payout":
      return `awaitingPayout=${filter.payer}`;
    case "unanswered_waiting":
      return "unanswered=waiting";
    case "city_route":
      return `city=${encodeURIComponent(filter.city)}&courier=${filter.courier}&via=${filter.via}`;
    case "city":
      return `city=${encodeURIComponent(filter.city)}`;
    case "unpaid":
      return filter.age === "any" ? `unpaid=${filter.courier}` : `unpaid=${filter.courier}&age=${filter.age}`;
  }
}

/**
 * Whether an order belongs to a filter. `currency` is the store's: the
 * variant filter leaves out international orders exactly as the card does.
 */
export function matchesFilter(
  o: RollupOrder,
  filter: OrderFilter,
  currency: string | null,
  ctx?: { payers?: PayerHistory[]; asOf?: Date },
): boolean {
  switch (filter.kind) {
    case "variant":
      return o.currency === currency && o.lines.some((l) => l.variantId === filter.variantId);
    case "disagree":
      return disagrees(o);
    case "decided_by":
      return filter.app === "courierify" ? fromCourierify(o) : !fromCourierify(o);
    case "fee_missing":
      return feeMissing(o);
    case "unanswered_waiting":
      return o.currency === currency && unansweredWaiting(o, ctx?.asOf ?? new Date());
    case "city_route":
      return o.currency === currency && inCityRoute(o, filter.city, filter);
    case "city":
      return o.currency === currency && o.city === filter.city;
    case "unpaid":
      return (
        o.outcome === "delivered" &&
        fromCourierify(o) &&
        // An untracked list (no age) is keyed by payer, an ageing cell by courier.
        (filter.age === "any" ? payerOf(o).toLowerCase() : (o.courier ?? "unknown")) === filter.courier &&
        !!o.uncollected &&
        parseAmount(o.uncollected.amount)! > 0n &&
        (filter.age === "any" || ageOf(o.outcomeTiming?.at ?? null, ctx?.asOf ?? new Date()) === filter.age)
      );
    case "awaiting_payout": {
      const h = ctx?.payers?.find((p) => p.payer === filter.payer);
      return !!h && o.outcome === "delivered" && fromCourierify(o) && payerOf(o) === filter.payer && isDue(o, h, ctx!.asOf ?? new Date());
    }
  }
}
