/**
 * The order grain (G-GZR2-2): one row per order, built from rows Growzar has
 * already synced, with every field saying where it came from.
 *
 * Pure: the caller loads the rows, this decides what they mean. Every screen,
 * every Phase 3 detector and "talk to your data" read the table this fills,
 * so each rule in CONFLICTING-DATA-POINTS.md is applied here exactly once.
 *
 * **Every field explains itself.** `explain[field]` names the rule, the
 * source, and the exact input rows (`app/entity/id@updatedAt`). An insight
 * has to be able to show its arithmetic (DECISION-LAYER §5.3); a number that
 * cannot say where it came from cannot be defended to a merchant.
 */
import {
  currentStatusTiming,
  type StatusTiming,
} from "../shipments/events";
import { formatAmount, isPositive, parseAmount, readMoney, subtractMoney, timesQuantity, zero, type Money } from "./money";
import { normalizeCity, type CityAlias } from "./city-aliases";

/** A synced row as the grain sees it. */
export type SourceRow = {
  app: "FINANCIFY" | "COURIERIFY" | "WHATKABOT";
  entity: "ORDER" | "PARCEL" | "CONFIRMATION";
  externalId: string;
  sourceUpdatedAt: Date;
  payload: Record<string, unknown>;
};

type TimelineEvent = Parameters<typeof currentStatusTiming>[0][number];

export type OrderGrainInput = {
  orderId: string;
  /** Store's IANA timezone, from the apps (rule #5). Null if never reported. */
  timezone: string | null;
  /** Financify's order row, when Financify is connected and has it. */
  order: SourceRow | null;
  /** Courierify parcels for this order, each with its status events. */
  parcels: Array<{ row: SourceRow; events: readonly TimelineEvent[] }>;
  /** Confirmation rows for this order: Courierify's, and WhatKaBot's COD checks. */
  confirmations: SourceRow[];
  /** Growzar's own customer (rule #19), resolved by the caller. */
  customer: { id: string; via: string } | null;
  /** Financify city spelling → Courierify city, learned per store (city-aliases.ts). */
  cityAliases?: ReadonlyMap<string, CityAlias>;
};

/**
 * What happened to the order, one word (rules #7, #8, #10, #11).
 *
 * `returned` is courier-confirmed return to origin only. A cancelled order
 * and a cancelled shipment are different events (rule #11), and a refund is
 * not a delivery outcome at all (rule #10) — it is the separate `refunded`
 * amount.
 */
export type Outcome =
  | "delivered"
  | "returned"
  | "partially_delivered"
  | "in_transit"
  | "booked"
  | "shipment_cancelled"
  | "order_cancelled"
  | "not_shipped"
  | "unknown";

export type Explain = {
  rule: string[];
  source: string;
  inputs: string[];
  note?: string;
};

export type OrderGrain = {
  orderId: string;
  orderName: string | null;
  createdAt: Date | null;
  /** The store's local day the order was placed on (rule #5). */
  localDay: string | null;
  currency: string | null;

  /** Rule #2: three kinds of revenue, never summed with one another. */
  placed: Money | null;
  delivered: Money | null;
  collected: Money | null;
  /**
   * COD of delivered parcels no courier settlement has covered yet: what a
   * courier (or 3PL) still owes, as Courierify last saw it (G-GZR3-5, I4).
   */
  uncollected: Money | null;
  /** Rule #10: money given back, not a delivery outcome. */
  refunded: Money | null;
  discounts: Money | null;
  shipping: Money | null;
  tax: Money | null;

  cogs: Money | null;
  cogsComplete: boolean | null;
  courierFee: Money | null;
  courierFeeSource: string | null;

  outcome: Outcome;
  outcomeAuthority: "courierify" | "financify" | "none";
  /** Rule #9: "happened on" only with a courier time; else "status as of". */
  outcomeTiming: { basis: StatusTiming["basis"]; at: Date } | null;
  /**
   * Financify's own outcome and raw status, kept beside the authority's even
   * when Courierify decides (G-GZR3-1), so "the apps disagree" is a column a
   * finding can count, not a sentence in `explain`. Null without a Financify
   * row.
   */
  financifyOutcome: Outcome | null;
  financifyStatus: string | null;
  orderCancelled: boolean;
  shipmentCancelled: boolean;

  confirmation: string | null;
  customerId: string | null;
  parcelCount: number;
  /**
   * The courier that carried it: the first Courierify parcel that was not
   * cancelled, else Financify's `delivery.carrier` (rule #7's fallback). The
   * two apps spell couriers differently ("nkfulfillment" / "NK Fulfilment"),
   * so a Financify carrier is kept as `financify:<lower-case name>` rather
   * than merged by guesswork. Null when neither knows.
   */
  courier: string | null;
  /**
   * Who booked the deciding parcel, from Courierify's `fulfilledVia`:
   * "orio" (a 3PL) or "shopify" (another fulfilment app), or null when the
   * merchant booked through Courierify directly. Non-null means Courierify
   * read the status from Shopify's fulfilment, never polled the courier, so
   * there are no courier times: "not available", never "slow" (G-GZR3-2).
   */
  fulfilledVia: string | null;
  /**
   * Courierify's canonical city (its tehsil mapping), or null when the raw
   * spelling did not map — a roll-up groups those as "unmapped", never as a
   * city of their own ("Lahore" arrives in 13 spellings on one store).
   */
  city: string | null;
  cityRaw: string | null;
  /** Rule #30: variant id is the product key; SKU is display-only. */
  /**
   * `value` is the line's own price × quantity less its own discount; an
   * order-level discount is not in it, so lines need not sum to `placed`.
   * `cost` is the order-time unit cost × quantity (rule #14). Either is null
   * when Financify did not send it. A gift card costs nothing.
   *
   * `quantity` is after Shopify order edits: units edited off are in
   * `editedOff`, and a line edited off entirely stays with quantity 0.
   */
  lines: Array<{
    variantId: string | null;
    productId: string | null;
    /** Display only (rule #30): Financify's product and variant titles. */
    title?: string | null;
    variantTitle?: string | null;
    quantity: number;
    /** Units removed in a Shopify order edit; absent when none were. */
    editedOff?: number;
    value: Money | null;
    cost: Money | null;
  }>;

  explain: Record<string, Explain>;
};

const ref = (row: SourceRow, field?: string) =>
  `${row.app.toLowerCase()}/${row.entity.toLowerCase()}/${row.externalId}@${row.sourceUpdatedAt.toISOString()}${field ? `#${field}` : ""}`;

/**
 * One formatter per timezone. Building an Intl.DateTimeFormat costs about
 * 27 KB of native (ICU) memory that only goes back when the GC gets to it;
 * built per call, the worker's 19,127 offer events took +521 MB and 1.9 s
 * against +13 MB and 68 ms cached (2026-10-19).
 */
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The store's local calendar day for an instant (rule #5). */
export function localDayOf(at: Date, timezone: string): string {
  let f = dayFormats.get(timezone);
  if (!f) {
    // en-CA formats as YYYY-MM-DD.
    f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(timezone, f);
  }
  return f.format(at);
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * What Shopify order edits took off an order (W1 finance edits).
 *
 * Financify sends Shopify's edited figures (D-82), but `current.*` is after
 * edits *and* refunds and cancellations (it is 0 on a cancelled order), and
 * so is each line's `currentQuantity`. Growzar keeps refunds (rule #10) and
 * cancellations (rule #11) apart from placed revenue, so it reads the edits
 * alone: Shopify records items edited off an unpaid order as a zero-value
 * refund, which Financify sends as `refunds[kind=edit_removal]` with its
 * lines. Books reads edits the same way, so the two agree.
 *
 * An edit that only changes a price or shipping, or adds items, leaves no
 * such event and keeps the total as placed (2026-10-27 decision). An edit
 * removal on an order already paid comes back as a money refund, and counts
 * as one.
 *
 * Null when the order was not edited, Financify has not sent its refunds,
 * nothing was edited off, or the removals are in another currency than the
 * order (Financify's `money.*` is in the order's currency, its refunds in
 * the shop's; rule #4).
 */
type EditRemovals = {
  /** Units edited off per Shopify line id. */
  byLine: Map<string, number>;
  /** Value of the items edited off, with their tax and order-discount share. */
  value: Money;
  tax: Money;
  count: number;
};

function editRemovals(fin: Record<string, unknown> | null, currency: string | null): { removals: EditRemovals | null; note: string | null } {
  if (obj(fin?.current).edited !== true) return { removals: null, note: null };
  if (!Array.isArray(fin!.refunds)) {
    return { removals: null, note: "edited in Shopify, but Financify has not sent the edit's details; the total as placed is used" };
  }
  const byLine = new Map<string, number>();
  let value = 0n;
  let tax = 0n;
  let count = 0;
  for (const r of fin!.refunds as unknown[]) {
    const refund = obj(r);
    if (refund.kind !== "edit_removal" || !Array.isArray(refund.lines)) continue;
    count += 1;
    for (const l of refund.lines as unknown[]) {
      const line = obj(l);
      const amount = readMoney(line.amount);
      const lineTax = readMoney(line.tax);
      if ((amount && amount.currency !== currency) || (lineTax && lineTax.currency !== currency)) {
        return { removals: null, note: `edited in Shopify, but the edit is in ${amount?.currency ?? lineTax?.currency} and the order in ${currency}; the total as placed is used` };
      }
      value += parseAmount(amount?.amount) ?? 0n;
      tax += parseAmount(lineTax?.amount) ?? 0n;
      const id = line.lineId == null ? null : String(line.lineId);
      const qty = typeof line.quantity === "number" && Number.isInteger(line.quantity) ? line.quantity : 0;
      if (id) byLine.set(id, (byLine.get(id) ?? 0) + qty);
    }
  }
  if (count === 0) {
    return { removals: null, note: "edited in Shopify without removing items; the total as placed is used" };
  }
  return {
    removals: {
      byLine,
      value: { amount: formatAmount(value + tax), currency: currency! },
      tax: { amount: formatAmount(tax), currency: currency! },
      count,
    },
    note: null,
  };
}

/** One parcel's outcome, from Courierify's own status vocabulary. */
function parcelOutcome(status: string): Outcome {
  switch (status) {
    case "delivered":
      return "delivered";
    case "returned":
      return "returned";
    case "cancelled":
      return "shipment_cancelled";
    case "booked":
    case "pending":
      return "booked";
    case "picked_up":
    case "in_transit":
    case "out_for_delivery":
    case "attempted":
      return "in_transit";
    default:
      return "unknown";
  }
}

/**
 * Financify's category, used only when no Courierify parcel exists (rule #7).
 * Its `returned` includes FAILED_DELIVERY — a delivery attempt that failed,
 * which a courier may still re-attempt — so a Financify-only "returned" is
 * weaker than a courier-confirmed one, and the explain note says so.
 */
function financifyOutcome(category: unknown): Outcome {
  switch (category) {
    case "delivered":
      return "delivered";
    case "returned":
      return "returned";
    case "in_transit":
      return "in_transit";
    case "cancelled":
      return "order_cancelled";
    case "pending":
      return "not_shipped";
    default:
      return "unknown";
  }
}

/**
 * Several parcels, one order. Cancelled parcels are ignored unless every
 * parcel was cancelled; a mix of delivered and returned is its own outcome
 * rather than a coin toss between them.
 */
function combineParcels(outcomes: Outcome[]): Outcome {
  const live = outcomes.filter((o) => o !== "shipment_cancelled");
  if (live.length === 0) return outcomes.length ? "shipment_cancelled" : "not_shipped";
  if (live.every((o) => o === "delivered")) return "delivered";
  if (live.every((o) => o === "returned")) return "returned";
  if (live.every((o) => o === "delivered" || o === "returned")) return "partially_delivered";
  if (live.includes("unknown")) return "unknown";
  if (live.every((o) => o === "booked")) return "booked";
  return "in_transit";
}

export function buildOrderGrain(input: OrderGrainInput): OrderGrain {
  const { order, parcels, confirmations, timezone } = input;
  const explain: Record<string, Explain> = {};
  const fin = order?.payload ?? null;
  const money = obj(fin?.money);

  // ── Identity and day ─────────────────────────────────────────────────────
  const firstParcel = parcels[0]?.row.payload;
  const orderName =
    (typeof fin?.orderName === "string" && fin.orderName) ||
    (typeof firstParcel?.orderName === "string" && firstParcel.orderName) ||
    null;

  const createdAt = date(fin?.createdAt) ?? date(firstParcel?.orderCreatedAt);
  const localDay = createdAt && timezone ? localDayOf(createdAt, timezone) : null;
  const createdFrom = fin?.createdAt ? order! : parcels[0]?.row;
  explain.localDay = {
    rule: ["#5"],
    source: order ? "financify.orders.createdAt" : "courierify.shipments.orderCreatedAt",
    inputs: createdFrom ? [ref(createdFrom, fin?.createdAt ? "createdAt" : "orderCreatedAt")] : [],
    note: !timezone
      ? "the store's timezone has not been reported, so there is no local day"
      : fin?.localDay && localDay && fin.localDay !== localDay
        ? `Financify's own localDay says ${String(fin.localDay)}; Growzar computed ${localDay} in ${timezone}`
        : `computed in ${timezone}`,
  };

  // ── Money (rules #2, #4) ─────────────────────────────────────────────────
  const asPlaced = readMoney(money.placed);
  const currency = asPlaced?.currency ?? null;
  // Shopify's edited total: as placed, less what edits took off.
  const { removals, note: editNote } = editRemovals(fin, currency);
  const placed = asPlaced && removals ? subtractMoney(asPlaced, removals.value) : asPlaced;
  explain.placed = {
    rule: ["#1", "#2"],
    source: !order
      ? "none"
      : removals
        ? "Shopify's edited total: financify.orders.money.placed less refunds[edit_removal]"
        : "financify.orders.money.placed",
    inputs: order ? [ref(order, "money.placed"), ...(removals ? [ref(order, "refunds")] : [])] : [],
    note: !order
      ? "Courierify's parcel feed carries a COD amount, not an order total, so placed revenue is unknown without Financify"
      : removals
        ? `${asPlaced!.currency} ${asPlaced!.amount} as placed, less ${removals.value.amount} of items removed in ${removals.count === 1 ? "an edit" : `${removals.count} edits`}`
        : (editNote ?? undefined),
  };

  for (const field of ["refunded", "discounts", "shipping", "tax"] as const) {
    explain[field] = {
      rule: field === "refunded" ? ["#2", "#10"] : ["#2"],
      source: order ? `financify.orders.money.${field}` : "none",
      inputs: order ? [ref(order, `money.${field}`)] : [],
    };
  }
  const taxAsPlaced = readMoney(money.tax);
  const tax = taxAsPlaced && removals && removals.tax.currency === taxAsPlaced.currency ? subtractMoney(taxAsPlaced, removals.tax) : taxAsPlaced;
  if (removals && isPositive(removals.tax)) {
    explain.tax = { ...explain.tax!, source: "financify.orders.money.tax less refunds[edit_removal].lines.tax", inputs: [...explain.tax!.inputs, ref(order!, "refunds")] };
  }

  // ── Delivery outcome (rules #7, #8, #9, #10, #11) ────────────────────────
  let outcome: Outcome;
  let outcomeAuthority: OrderGrain["outcomeAuthority"];
  let outcomeTiming: OrderGrain["outcomeTiming"] = null;

  if (parcels.length > 0) {
    // Courierify is the delivery authority when connected (rule #7): it is
    // the only app talking to couriers.
    const perParcel = parcels.map((p) => parcelOutcome(String(p.row.payload.status ?? "")));
    outcome = combineParcels(perParcel);
    outcomeAuthority = "courierify";

    // Timing from the event log. For several parcels, the latest parcel to
    // reach its outcome decides when the order did, and the order only says
    // "happened on" if every deciding parcel had a courier time; "reported by
    // the 3PL" if each had a courier or a 3PL time; else "status as of".
    const timings = parcels
      .filter((_, i) => perParcel[i] !== "shipment_cancelled")
      .map((p) => currentStatusTiming(p.events));
    if (timings.length && timings.every((t) => t !== null)) {
      const latest = timings.reduce((a, b) => (b!.at > a!.at ? b : a))!;
      outcomeTiming = {
        basis: timings.every((t) => t!.basis === "happened_on")
          ? "happened_on"
          : timings.every((t) => t!.basis !== "status_as_of")
            ? "reported_by_3pl"
            : "status_as_of",
        at: latest.at,
      };
    }

    explain.outcome = {
      rule: ["#7", "#10", "#11"],
      source: "courierify.shipments.status",
      inputs: parcels.map((p) => ref(p.row, "status")),
      note:
        fin && financifyOutcome(obj(fin.delivery).category) !== outcome
          ? `Financify says ${String(obj(fin.delivery).category)} (${String(obj(fin.delivery).status)}); Courierify is the authority`
          : undefined,
    };
    explain.outcomeTiming = {
      rule: ["#9"],
      source: "courierify.shipment-events",
      inputs: parcels.map((p) => `courierify/shipment_event/${p.row.externalId}(${p.events.length} events)`),
      note: outcomeTiming
        ? outcomeTiming.basis === "happened_on"
          ? "the courier gave a time"
          : outcomeTiming.basis === "reported_by_3pl"
            ? "the 3PL reported a time (its observation, not the courier's): show 'reported by the 3PL on', never 'delivered on'"
            : "no courier time for the current status: show 'status as of', never 'delivered on'"
        : "no events for at least one parcel",
    };
  } else if (fin) {
    outcome = financifyOutcome(obj(fin.delivery).category);
    outcomeAuthority = "financify";
    explain.outcome = {
      rule: ["#7", "#10", "#11"],
      source: "financify.orders.delivery.category",
      inputs: [ref(order!, "delivery")],
      note:
        obj(fin.delivery).status === "FAILED_DELIVERY"
          ? "Financify files a failed delivery attempt as returned; no courier confirmed the return"
          : "no Courierify parcel for this order",
    };
    // Financify's deliveredAt is an event time and statusObservedAt is not
    // (contract §5), but without Courierify's log there is no way to know
    // whether the event time is the courier's; treat it as "as of".
    const observed = date(obj(fin.delivery).statusObservedAt);
    outcomeTiming = observed ? { basis: "status_as_of", at: observed } : null;
    explain.outcomeTiming = {
      rule: ["#9"],
      source: "financify.orders.delivery.statusObservedAt",
      inputs: [ref(order!, "delivery.statusObservedAt")],
      note: "without Courierify's event log, only 'status as of'",
    };
  } else {
    outcome = "unknown";
    outcomeAuthority = "none";
  }

  const orderCancelled =
    obj(fin?.delivery).category === "cancelled" || obj(fin?.delivery).status === "CANCELLED";
  const shipmentCancelled = parcels.some((p) => p.row.payload.status === "cancelled");
  explain.orderCancelled = {
    rule: ["#11"],
    source: "financify.orders.delivery",
    inputs: order ? [ref(order, "delivery")] : [],
  };
  explain.shipmentCancelled = {
    rule: ["#11"],
    source: "courierify.shipments.status",
    inputs: parcels.map((p) => ref(p.row, "status")),
  };

  // Delivered revenue (rule #2): the placed amount once the delivery
  // authority (rule #7) says delivered, zero once it says it will not be,
  // unknown while it has not said. Financify computes the same from its own
  // delivery status; this uses the authority's.
  let delivered: Money | null = null;
  if (placed) {
    if (outcome === "delivered") delivered = placed;
    else if (["returned", "order_cancelled", "shipment_cancelled"].includes(outcome)) {
      delivered = { amount: "0.00", currency: placed.currency };
    }
  }
  explain.delivered = {
    rule: ["#2", "#7"],
    source: "placed × outcome",
    inputs: [...explain.placed.inputs, ...explain.outcome!.inputs],
    note:
      outcome === "partially_delivered"
        ? "some parcels delivered and some returned; which lines were delivered is not known"
        : delivered === null
          ? "no outcome yet"
          : undefined,
  };

  // Cash collected (rules #2, #17 "paid by courier"): the COD of each
  // delivered parcel that a courier settlement has covered. A settled
  // returned parcel is in a payout only for its fees; it collected nothing.
  let collectedUnits: bigint | null = null;
  let collectedCurrency: string | null = null;
  const collectedInputs: string[] = [];
  for (const p of parcels) {
    const settled = obj(p.row.payload.settlement).settled === true;
    if (!settled || p.row.payload.status !== "delivered") continue;
    const cod = readMoney(p.row.payload.cod);
    if (!cod) continue;
    if (collectedCurrency && collectedCurrency !== cod.currency) continue; // rule #4
    collectedCurrency = cod.currency;
    collectedUnits = (collectedUnits ?? 0n) + parseAmount(cod.amount)!;
    collectedInputs.push(ref(p.row, "cod"));
  }
  const collected: Money | null =
    collectedUnits !== null && collectedCurrency
      ? { amount: formatAmount(collectedUnits), currency: collectedCurrency }
      : null;
  // What is still owed: the same parcels, not yet covered by a settlement.
  let uncollectedUnits: bigint | null = null;
  let uncollectedCurrency: string | null = null;
  const uncollectedInputs: string[] = [];
  for (const p of parcels) {
    const settled = obj(p.row.payload.settlement).settled === true;
    if (settled || p.row.payload.status !== "delivered") continue;
    const cod = readMoney(p.row.payload.cod);
    if (!cod) continue;
    if (uncollectedCurrency && uncollectedCurrency !== cod.currency) continue; // rule #4
    uncollectedCurrency = cod.currency;
    uncollectedUnits = (uncollectedUnits ?? 0n) + parseAmount(cod.amount)!;
    uncollectedInputs.push(ref(p.row, "cod"));
  }
  const uncollected: Money | null =
    uncollectedUnits !== null && uncollectedCurrency
      ? { amount: formatAmount(uncollectedUnits), currency: uncollectedCurrency }
      : null;
  explain.uncollected = {
    rule: ["#17"],
    source: "courierify.shipments.cod where delivered and not settlement.settled",
    inputs: uncollectedInputs,
    note: uncollected ? "no courier settlement recorded in Courierify for this COD yet" : "nothing delivered is awaiting a settlement",
  };

  explain.collected = {
    rule: ["#2", "#17"],
    source: "courierify.shipments.cod where settlement.settled and delivered",
    inputs: collectedInputs,
    note: collected ? "paid by courier; bank receipt is not yet available" : "no settled delivered parcel",
  };

  // ── Lines (rules #14, #30) ──────────────────────────────────────────────
  const lineItems = Array.isArray(fin?.lineItems) ? (fin!.lineItems as unknown[]).map(obj) : [];
  const giftCards = lineItems.map((line) => line.isGiftCard === true);
  const lines = lineItems.map((line, i) => {
    const ordered = typeof line.quantity === "number" && Number.isInteger(line.quantity) ? line.quantity : 0;
    const lineId = line.lineId == null ? null : String(line.lineId);
    const editedOff = Math.min(ordered, (lineId && removals?.byLine.get(lineId)) || 0);
    const quantity = ordered - editedOff;
    const unitPrice = readMoney(line.unitPrice);
    const unitCost = readMoney(line.unitCost);
    const discount = readMoney(line.totalDiscount);
    let value = unitPrice ? timesQuantity(unitPrice, ordered) : null;
    if (value && discount && discount.currency === value.currency) value = subtractMoney(value, discount);
    // The line's own discount covers every unit ordered; what is left keeps its share.
    if (value && editedOff) value = { amount: formatAmount((parseAmount(value.amount)! * BigInt(quantity)) / BigInt(ordered)), currency: value.currency };
    return {
      variantId: typeof line.variantId === "string" ? line.variantId : null,
      productId: typeof line.productId === "string" ? line.productId : null,
      title: typeof line.title === "string" ? line.title : null,
      variantTitle: typeof line.variantTitle === "string" ? line.variantTitle : null,
      quantity,
      ...(editedOff ? { editedOff } : {}),
      value,
      cost: giftCards[i] ? (currency ? zero(currency) : null) : unitCost ? timesQuantity(unitCost, quantity) : null,
    };
  });
  explain.lines = {
    rule: ["#14", "#30"],
    source: removals
      ? "financify.orders.lineItems, quantities less refunds[edit_removal].lines (Shopify's edited quantities)"
      : "financify.orders.lineItems (quantities as ordered)",
    inputs: order ? [ref(order, "lineItems"), ...(removals ? [ref(order, "refunds")] : [])] : [],
    note: removals
      ? `${lines.filter((l) => l.editedOff).length} line(s) changed by an edit; a line removed entirely stays with quantity 0`
      : giftCards.includes(true)
        ? "gift cards carry no cost"
        : undefined,
  };

  // ── Costs (rules #13, #14) ──────────────────────────────────────────────
  // Financify's cost of goods is per unit ordered. After an edit (or with a
  // gift card, which costs nothing) it is recomputed from the lines, and is
  // complete only if every line still on the order has a cost.
  const cogsObj = obj(fin?.cogs);
  const fromLines = !!removals || giftCards.includes(true);
  let cogs = readMoney(cogsObj.total);
  let cogsComplete = typeof cogsObj.complete === "boolean" ? cogsObj.complete : null;
  let missingCost = 0;
  if (fromLines) {
    const costCurrency = cogs?.currency ?? currency;
    let units = 0n;
    for (const [i, l] of lines.entries()) {
      if (l.quantity === 0 || giftCards[i]) continue;
      if (!l.cost || l.cost.currency !== costCurrency) missingCost += 1;
      else units += parseAmount(l.cost.amount)!;
    }
    cogs = costCurrency ? { amount: formatAmount(units), currency: costCurrency } : null;
    cogsComplete = missingCost === 0;
  }
  explain.cogs = {
    rule: ["#14"],
    source: !fromLines
      ? "financify.orders.cogs"
      : removals
        ? "financify.orders.lineItems: unit cost × quantity after Shopify's edits"
        : "financify.orders.lineItems: unit cost × quantity, gift cards at no cost",
    inputs: order ? [ref(order, fromLines ? "lineItems" : "cogs"), ...(removals ? [ref(order, "refunds")] : [])] : [],
    note: fromLines
      ? missingCost
        ? `${missingCost} line(s) have no cost`
        : undefined
      : cogsObj.complete === false
        ? `${String(cogsObj.linesMissingCost)} line(s) have no cost`
        : undefined,
  };
  // Financify nests the money: `courierFee: { amount: { amount, currency },
  // source }`. Reading `courierFee` itself as money dropped all 908 priced
  // fees on 0dscam-qn until G-GZR3-1 (the rule #13 fixture had it flat).
  const feeObj = obj(fin?.courierFee);
  const courierFee = readMoney(feeObj.amount);
  explain.courierFee = {
    rule: ["#13"],
    source: "financify.orders.courierFee (Courierify's courier_costs metafield, per the 2026-09-25 decision)",
    inputs: order ? [ref(order, "courierFee")] : [],
    note: courierFee ? undefined : `not priced (${String(feeObj.source ?? "no Financify row")})`,
  };

  // ── Confirmation (rule #25) ─────────────────────────────────────────────
  // Courierify's OrderConfirmation first; WhatKaBot's COD check only for an
  // order Courierify never confirmed (rule #25's fallback). WhatKaBot's
  // normalised `state` is pending / confirmed / cancelled / no_answer.
  const newest = (rows: SourceRow[]) => [...rows].sort((a, b) => b.sourceUpdatedAt.getTime() - a.sourceUpdatedAt.getTime())[0];
  const fromCourierify = confirmations.filter((c) => c.app !== "WHATKABOT");
  const fromWhatKaBot = confirmations.filter((c) => c.app === "WHATKABOT");
  const latestConfirmation = newest(fromCourierify);
  const latestCodCheck = latestConfirmation ? undefined : newest(fromWhatKaBot);
  const confirmation = latestConfirmation
    ? typeof latestConfirmation.payload.status === "string" ? latestConfirmation.payload.status : null
    : typeof latestCodCheck?.payload.state === "string" ? latestCodCheck.payload.state : null;
  explain.confirmation = latestCodCheck
    ? {
        rule: ["#25"],
        source: "whatkabot.confirmations (CodOrderCheck), used because Courierify has no confirmation for this order",
        inputs: fromWhatKaBot.map((c) => ref(c, "state")),
        note: fromWhatKaBot.length > 1 ? "several COD checks; the latest is used" : undefined,
      }
    : {
        rule: ["#25"],
        source: "courierify.confirmations (OrderConfirmation, not OrderCase.stage)",
        inputs: fromCourierify.map((c) => ref(c, "status")),
        note: fromCourierify.length > 1 ? "several confirmation rows; the latest is used" : undefined,
      };

  // ── Buyer (rule #19) ────────────────────────────────────────────────────
  explain.customerId = {
    rule: ["#19"],
    source: "growzar.customers",
    inputs: input.customer ? [`growzar/customer/${input.customer.id}`] : [],
    note: input.customer ? `matched by ${input.customer.via}` : "no usable buyer identity",
  };

  // ── Courier and city (rule #12) ─────────────────────────────────────────
  // The first parcel that was not cancelled decides both; an order whose
  // parcels were all cancelled still went somewhere, so fall back to the
  // first parcel.
  const deciding = parcels.find((p) => p.row.payload.status !== "cancelled") ?? parcels[0];
  const couriers = [...new Set(parcels.map((p) => courierOf(p.row)).filter(Boolean))];
  const carrier = typeof obj(fin?.delivery).carrier === "string" ? String(obj(fin?.delivery).carrier).trim() : "";
  const financifyCarrier = carrier ? `financify:${carrier.toLowerCase()}` : null;
  const via = deciding && typeof deciding.row.payload.fulfilledVia === "string" && deciding.row.payload.fulfilledVia.trim()
    ? deciding.row.payload.fulfilledVia.trim().toLowerCase()
    : null;
  explain.fulfilledVia = {
    rule: ["#9", "#12"],
    source: "courierify.shipments.fulfilledVia",
    inputs: deciding ? [ref(deciding.row, "fulfilledVia")] : [],
    note: !deciding
      ? "no Courierify parcel"
      : via
        ? `booked through ${via}: status mirrored from Shopify's fulfilment, so no courier times`
        : "booked through Courierify directly",
  };
  explain.courier = deciding
    ? {
        rule: ["#7", "#12"],
        source: "courierify.shipments.courier",
        inputs: [ref(deciding.row, "courier")],
        note: couriers.length > 1 ? `parcels went with ${couriers.join(", ")}; the first live parcel's courier is used` : undefined,
      }
    : {
        rule: ["#7", "#12"],
        source: "financify.orders.delivery.carrier",
        inputs: order && carrier ? [ref(order, "delivery.carrier")] : [],
        note: carrier
          ? "no Courierify parcel; Financify's carrier name, not merged with Courierify's spelling"
          : "no parcel and no carrier",
      };
  // Courierify's city when it carried a parcel (rule #12); otherwise
  // Financify's delivery city (G-FIN2-2), in Courierify's names where the
  // store's own data says which name a spelling means.
  const city = deciding ? cityOf(deciding.row) : null;
  const finCityRaw = typeof obj(obj(fin?.delivery).city).raw === "string" ? String(obj(obj(fin?.delivery).city).raw).trim() || null : null;
  const finAlias = !deciding && finCityRaw ? (input.cityAliases?.get(normalizeCity(finCityRaw)) ?? null) : null;
  explain.city = deciding
    ? {
        rule: ["#12"],
        source: "courierify.shipments.city.canonical",
        inputs: [ref(deciding.row, "city")],
        note: city?.canonical
          ? `mapped by ${city.match ?? "Courierify"}`
          : "Courierify's tehsil mapping has no match for this spelling: unmapped",
      }
    : {
        rule: ["#12"],
        source: "financify.orders.delivery.city.raw",
        inputs: order && finCityRaw ? [ref(order, "delivery.city")] : [],
        note: !finCityRaw
          ? "no Courierify parcel, and no delivery city from Financify"
          : finAlias
            ? finAlias.how === "learned"
              ? `Financify's "${finCityRaw}" is ${finAlias.canonical} on ${finAlias.votes} of ${finAlias.of} orders both apps know`
              : `Financify's "${finCityRaw}" is the city name ${finAlias.canonical}`
            : `Financify's "${finCityRaw}" has no learned match: unmapped`,
      };


  return {
    orderId: input.orderId,
    orderName,
    createdAt,
    localDay,
    currency,
    placed,
    delivered,
    collected,
    uncollected,
    refunded: readMoney(money.refunded),
    discounts: readMoney(money.discounts),
    shipping: readMoney(money.shipping),
    tax,
    cogs,
    cogsComplete,
    courierFee,
    courierFeeSource: typeof feeObj.source === "string" ? feeObj.source : null,
    outcome,
    outcomeAuthority,
    outcomeTiming,
    financifyOutcome: fin ? financifyOutcome(obj(fin.delivery).category) : null,
    financifyStatus: fin && typeof obj(fin.delivery).status === "string" ? (obj(fin.delivery).status as string) : null,
    orderCancelled,
    shipmentCancelled,
    confirmation,
    customerId: input.customer?.id ?? null,
    parcelCount: parcels.length,
    courier: deciding ? courierOf(deciding.row) : financifyCarrier,
    fulfilledVia: via,
    city: deciding ? cityOf(deciding.row).canonical : (finAlias?.canonical ?? null),
    cityRaw: deciding ? cityOf(deciding.row).raw : finCityRaw,
    lines,
    explain,
  };
}

/** Whether the order was refunded at all (rule #10), for counting. */
export const wasRefunded = (row: Pick<OrderGrain, "refunded">) => isPositive(row.refunded);

function courierOf(row: SourceRow): string | null {
  const c = row.payload.courier;
  return typeof c === "string" && c.trim() ? c.trim().toLowerCase() : null;
}

function cityOf(row: SourceRow): { canonical: string | null; raw: string | null; match: string | null } {
  const c = obj(row.payload.city);
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { canonical: text(c.canonical), raw: text(c.raw), match: text(c.match) };
}

/** The city Courierify gave the order's deciding parcel, for learning aliases. */
export function courierifyCityOf(parcels: ReadonlyArray<{ row: SourceRow }>): string | null {
  const deciding = parcels.find((p) => p.row.payload.status !== "cancelled") ?? parcels[0];
  return deciding ? cityOf(deciding.row).canonical : null;
}

/** Financify's raw delivery city on an order row, if any. */
export function financifyCityOf(order: SourceRow | null): string | null {
  const raw = obj(obj(order?.payload.delivery).city).raw;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
