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
import { formatAmount, isPositive, parseAmount, readMoney, subtractMoney, timesQuantity, type Money } from "./money";

/** A synced row as the grain sees it. */
export type SourceRow = {
  app: "FINANCIFY" | "COURIERIFY";
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
  /** Courierify confirmation rows for this order. */
  confirmations: SourceRow[];
  /** Growzar's own customer (rule #19), resolved by the caller. */
  customer: { id: string; via: string } | null;
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
   * when Financify did not send it.
   */
  lines: Array<{
    variantId: string | null;
    productId: string | null;
    quantity: number;
    value: Money | null;
    cost: Money | null;
  }>;

  explain: Record<string, Explain>;
};

const ref = (row: SourceRow, field?: string) =>
  `${row.app.toLowerCase()}/${row.entity.toLowerCase()}/${row.externalId}@${row.sourceUpdatedAt.toISOString()}${field ? `#${field}` : ""}`;

/** The store's local calendar day for an instant (rule #5). */
export function localDayOf(at: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
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
  const placed = readMoney(money.placed);
  const currency = placed?.currency ?? null;
  explain.placed = {
    rule: ["#1", "#2"],
    source: order ? "financify.orders.money.placed" : "none",
    inputs: order ? [ref(order, "money.placed")] : [],
    note: order
      ? undefined
      : "Courierify's parcel feed carries a COD amount, not an order total, so placed revenue is unknown without Financify",
  };

  for (const field of ["refunded", "discounts", "shipping", "tax"] as const) {
    explain[field] = {
      rule: field === "refunded" ? ["#2", "#10"] : ["#2"],
      source: order ? `financify.orders.money.${field}` : "none",
      inputs: order ? [ref(order, `money.${field}`)] : [],
    };
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
    // "happened on" if every deciding parcel had a courier time.
    const timings = parcels
      .filter((_, i) => perParcel[i] !== "shipment_cancelled")
      .map((p) => currentStatusTiming(p.events));
    if (timings.length && timings.every((t) => t !== null)) {
      const latest = timings.reduce((a, b) => (b!.at > a!.at ? b : a))!;
      outcomeTiming = {
        basis: timings.every((t) => t!.basis === "happened_on") ? "happened_on" : "status_as_of",
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
  explain.collected = {
    rule: ["#2", "#17"],
    source: "courierify.shipments.cod where settlement.settled and delivered",
    inputs: collectedInputs,
    note: collected ? "paid by courier; bank receipt is not yet available" : "no settled delivered parcel",
  };

  // ── Costs (rules #13, #14) ──────────────────────────────────────────────
  const cogsObj = obj(fin?.cogs);
  const cogs = readMoney(cogsObj.total);
  explain.cogs = {
    rule: ["#14"],
    source: "financify.orders.cogs",
    inputs: order ? [ref(order, "cogs")] : [],
    note: cogsObj.complete === false ? `${String(cogsObj.linesMissingCost)} line(s) have no cost` : undefined,
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
  const latestConfirmation = [...confirmations].sort(
    (a, b) => b.sourceUpdatedAt.getTime() - a.sourceUpdatedAt.getTime(),
  )[0];
  const confirmation =
    typeof latestConfirmation?.payload.status === "string" ? latestConfirmation.payload.status : null;
  explain.confirmation = {
    rule: ["#25"],
    source: "courierify.confirmations (OrderConfirmation, not OrderCase.stage)",
    inputs: confirmations.map((c) => ref(c, "status")),
    note: confirmations.length > 1 ? "several confirmation rows; the latest is used" : undefined,
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
  const city = deciding ? cityOf(deciding.row) : null;
  explain.city = {
    rule: ["#12"],
    source: "courierify.shipments.city.canonical",
    inputs: deciding ? [ref(deciding.row, "city")] : [],
    note: !deciding
      ? "no Courierify parcel, and Financify does not expose a delivery city"
      : city?.canonical
        ? `mapped by ${city.match ?? "Courierify"}`
        : "Courierify's tehsil mapping has no match for this spelling: unmapped",
  };

  const lines = Array.isArray(fin?.lineItems)
    ? (fin!.lineItems as unknown[]).map((l) => {
        const line = obj(l);
        const quantity = typeof line.quantity === "number" && Number.isInteger(line.quantity) ? line.quantity : 0;
        const unitPrice = readMoney(line.unitPrice);
        const unitCost = readMoney(line.unitCost);
        const discount = readMoney(line.totalDiscount);
        let value = unitPrice ? timesQuantity(unitPrice, quantity) : null;
        if (value && discount && discount.currency === value.currency) value = subtractMoney(value, discount);
        return {
          variantId: typeof line.variantId === "string" ? line.variantId : null,
          productId: typeof line.productId === "string" ? line.productId : null,
          quantity,
          value,
          cost: unitCost ? timesQuantity(unitCost, quantity) : null,
        };
      })
    : [];

  return {
    orderId: input.orderId,
    orderName,
    createdAt,
    localDay,
    currency,
    placed,
    delivered,
    collected,
    refunded: readMoney(money.refunded),
    discounts: readMoney(money.discounts),
    shipping: readMoney(money.shipping),
    tax: readMoney(money.tax),
    cogs,
    cogsComplete: typeof cogsObj.complete === "boolean" ? cogsObj.complete : null,
    courierFee,
    courierFeeSource: typeof feeObj.source === "string" ? feeObj.source : null,
    outcome,
    outcomeAuthority,
    outcomeTiming,
    orderCancelled,
    shipmentCancelled,
    confirmation,
    customerId: input.customer?.id ?? null,
    parcelCount: parcels.length,
    courier: deciding ? courierOf(deciding.row) : financifyCarrier,
    city: deciding ? cityOf(deciding.row).canonical : null,
    cityRaw: deciding ? cityOf(deciding.row).raw : null,
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
