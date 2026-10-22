/**
 * Shopify sales → one sales summary per day. Pure: orders in, journal lines out.
 *
 * On the day an order is PLACED:
 *   Dr owed-by, per payment method   what each method collected; the unpaid rest
 *                                    is owed through the order's "unpaid" method (COD)
 *   Dr discounts                     discounts
 *   Cr gift cards (liability)        gift cards sold — money held, not sales
 *   Cr sales                         the balancing figure (total + discounts − shipping − tax − gift cards)
 *   Cr shipping charged / sales tax
 *   Dr cost of what you sold / Cr stock   quantity × Shopify cost per item
 *
 * On the day of a REFUND (money given back):
 *   Dr returns (net of its tax), Dr sales tax, Cr the method that paid it back
 *   restocked items: Dr stock / Cr cost of what you sold (not restocked: the cost stays)
 * Items taken off an UNPAID order by editing it (Shopify: a refund of 0 that
 * lists them): their value comes off what's owed, on the day of the edit.
 *
 * On the day an order is CANCELLED:
 *   whatever the customer never paid (total − received) comes back off the
 *   unpaid method: Dr returns, Dr its share of tax, Cr owed-by
 *   never shipped: all its cost goes back (Dr stock / Cr cost), restocked in Shopify or not
 *   (Shopify adds a zero-amount refund to restock a cancelled order; that
 *   refund reverses the cost, the cancellation reverses the sale.)
 *
 * When a cash-on-delivery PARCEL COMES BACK (delivery tracking says returned
 * or failed, or a courier return tag), whatever Shopify hasn't already taken off:
 *   Dr returns (net of its tax share), Dr sales tax, Cr the unpaid method
 *   Dr stock / Cr cost of what you sold (items not restocked in Shopify)
 * If the merchant then cancels or refunds it in Shopify, Books' part shrinks
 * by what Shopify takes off; delivered after all, it's undone.
 *
 * Refunds and cancellations count only for orders placed on or after the
 * connector's first day (earlier sales were never brought in).
 */

import { todayIn } from "../dates";

export interface ShopTransaction {
  kind: string;
  status: string;
  gateway: string;
  amount: string;
}

export interface ShopLine {
  quantity: number;
  giftCard: boolean;
  /** After line discounts, before tax. */
  total: string;
  /** Shopify "cost per item", or null when the item has none (or the product was deleted). */
  unitCost: string | null;
  /** What identifies the line, to find its cost at sale in Financify's order records. */
  lineId?: string | null;
  variantId?: string | null;
  sku?: string | null;
  title?: string | null;
}

export interface ShopRefund {
  createdAt: string;
  total: string;
  /** Tax returned, from the refund's own lines (0 when Shopify didn't split it). */
  tax: string;
  transactions: ShopTransaction[];
  lines: Array<{ quantity: number; restock: boolean; giftCard: boolean; total: string; unitCost: string | null; lineId?: string | null }>;
}

export interface ShopOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  test: boolean;
  currency: string;
  gateways: string[];
  total: string;
  /** Collected from the customer before any refunds (Shopify totalReceived). */
  received: string;
  discounts: string;
  shipping: string;
  tax: string;
  transactions: ShopTransaction[];
  lines: ShopLine[];
  refunds: ShopRefund[];
  /** Whether anything was ever shipped (a fulfilment that wasn't cancelled). Unknown = treated as shipped. */
  shipped?: boolean;
  /**
   * Growzar: the gateway the unpaid rest is owed through, as Financify's feed
   * works it out by this same rule (it sees pending transactions; the feed
   * sends only successful ones). Used when present.
   */
  unpaidGateway?: string | null;
}

export interface SalesMapping {
  sales: string;
  shipping: string;
  discounts: string;
  returns: string;
  tax: string;
  /** Payment gateway name (as Shopify reports it) → account owed by / paid into. */
  gateways: Record<string, string>;
  /** Used for cash-on-delivery gateways that aren't mapped. */
  cod: string;
  /** Used for every other unmapped gateway. */
  prepaid: string;
  /**
   * Where each item's cost comes from: Financify's cost at sale (what the dashboard uses),
   * falling back to Shopify's; or Shopify's current cost per item, falling back to
   * Financify's. Missing = "shopify_now" (how Books always worked).
   */
  costSource?: "at_sale" | "shopify_now";
  /**
   * Orders paid by "manual" payment: worked out from delivery tracking (a courier → cash on
   * delivery; your own delivery → cash collected; no tracking → as mapped), or always as mapped.
   * Missing = "as_mapped".
   */
  manualPayments?: "detect" | "as_mapped";
  /**
   * With "detect": a manual-payment order with no courier or rider on record — counted as
   * cash on delivery, as cash your riders collected, or as mapped (missing).
   */
  manualUnknown?: "cod" | "self" | "as_mapped";
  /** Cash collected by your own riders (manual orders delivered yourself). */
  selfDelivery?: string;
  /** Gift cards sold and spent (a liability). Optional in old settings. */
  giftCards?: string;
  /** Cost of what you sold; empty turns cost tracking off. */
  cogs?: string;
  stock?: string;
  /** When an item has no cost in Shopify: estimate it as this % of its sale price, or leave it out (null). */
  costFallbackPercent?: number | null;
  /** Take returned cash-on-delivery parcels back off (from delivery tracking). Missing = on. */
  parcelReturns?: boolean;
  /**
   * When a cash-on-delivery order counts as a sale: when it's ordered (missing),
   * when it's handed to the courier (on a loadsheet, or tracking shows it moving),
   * or when it's delivered. Until then its sale and cost are held off the books
   * on `held` (a line under sales), and released on the day it goes out or arrives.
   * "money": any order with an unpaid part (cash on delivery, manual, bank transfer)
   * waits until money for it is on record — a courier settlement (Courierify or a
   * settlement file) or a payments file — and counts on that payment's date.
   */
  codBasis?: "order" | "dispatch" | "delivery" | "money";
  held?: string;
}

export interface DaySummary {
  day: string;
  debits: Array<{ accountId: string; amount: string }>;
  credits: Array<{ accountId: string; amount: string }>;
  orders: number;
  refunds: number;
  cancelled: number;
  /** Items sold with no cost in Shopify (left out, or estimated when a fallback % is set). */
  missingCost: number;
  estimatedCost: number;
  /** Parcels that came back, and ones delivered after all (their return undone). */
  parcelsBack: number;
  parcelsUndone: number;
  /** COD orders held until dispatched or delivered, and ones let in. */
  parcelsHeld: number;
  parcelsReleased: number;
  memo: string;
}

/** A parcel event's account amounts: signed, debit positive, minor units as strings. */
export type ParcelLines = Record<string, string>;

export interface ParcelEvent {
  orderId: string;
  orderName: string;
  day: string;
  /**
   * "lost": a parcel written off (its lines are in the write-off entry, not a sales day).
   * "held"/"released": a COD order kept off the books until it's dispatched or delivered, and let in.
   */
  kind: "returned" | "reinstated" | "adjusted" | "lost" | "skip" | "held" | "released";
  lines: ParcelLines;
}

/**
 * Gateways Shopify uses for cash on delivery. Exact names only: "Gokwik PPCOD"
 * and similar are partly prepaid and must not be treated as COD.
 */
const COD_GATEWAYS = new Set(["cash on delivery (cod)", "cash on delivery", "cod", "cash_on_delivery", "cash on delivery(cod)"]);

export function isCodGateway(name: string): boolean {
  const n = name.trim().toLowerCase();
  // Stores add their own wording after it ("Cash on Delivery - الدفع عند الإستلام").
  return COD_GATEWAYS.has(n) || n.startsWith("cash on delivery");
}

export function isGiftCardGateway(name: string): boolean {
  return name.trim().toLowerCase() === "gift_card";
}

/** The account a payment gateway's money is owed by (or paid into). */
/** A manual-payment order delivered by your own riders: the cash they collected. */
export const SELF_DELIVERY_GATEWAY = "Self delivery (cash)";

export function accountForGateway(gateway: string | undefined, m: SalesMapping): string {
  if (gateway === SELF_DELIVERY_GATEWAY) return m.selfDelivery || m.gateways.manual || m.prepaid;
  if (gateway && m.gateways[gateway]) return m.gateways[gateway];
  if (gateway && isGiftCardGateway(gateway) && m.giftCards) return m.giftCards;
  return gateway && isCodGateway(gateway) ? m.cod : m.prepaid;
}

/** "1500.5" → 150050n with 2 decimals; extra decimals round half away from zero. */
export function decimalToMinor(value: string | number | null | undefined, decimals: number): bigint {
  const s = String(value ?? "0").trim();
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`Not a money amount: ${s}`);
  const neg = !!m[1];
  const whole = m[2] || "0";
  const frac = m[3] ?? "";
  let minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals).padEnd(decimals, "0") || "0");
  if (frac.length > decimals && Number(frac[decimals]) >= 5) minor += 1n;
  return neg ? -minor : minor;
}

const COLLECTED = new Set(["SALE", "CAPTURE"]);

/**
 * Money collected per gateway, and which gateway the unpaid rest is owed
 * through: a gateway with a pending/authorised transaction, else a COD
 * gateway, else the first non-gift-card gateway, else the first one.
 */
export function splitCollections(o: ShopOrder, amt: (s: string) => bigint): { byGateway: Map<string, bigint>; unpaidGateway: string | undefined } {
  const byGateway = new Map<string, bigint>();
  for (const t of o.transactions) {
    if (!COLLECTED.has(t.kind.toUpperCase()) || t.status.toUpperCase() !== "SUCCESS") continue;
    byGateway.set(t.gateway, (byGateway.get(t.gateway) ?? 0n) + amt(t.amount));
  }
  const pending = o.transactions.find((t) => ["PENDING", "AWAITING_RESPONSE"].includes(t.status.toUpperCase()) || t.kind.toUpperCase() === "AUTHORIZATION");
  const unpaidGateway =
    o.unpaidGateway || (pending?.gateway ?? o.gateways.find((g) => isCodGateway(g)) ?? o.gateways.find((g) => !isGiftCardGateway(g)) ?? o.gateways[0] ?? [...byGateway.keys()][0]);
  return { byGateway, unpaidGateway };
}

/** a × b / c in whole minor units (for proportional tax shares). */
function share(a: bigint, b: bigint, c: bigint): bigint {
  return c === 0n ? 0n : (a * b) / c;
}

const RESTOCKED = new Set(["RETURN", "CANCEL", "LEGACY_RESTOCK"]);
export function isRestock(restockType: string | null | undefined): boolean {
  return RESTOCKED.has(String(restockType ?? "").toUpperCase());
}

/**
 * How much of each refund came off what the customer still owed (in minor
 * units, by refund, oldest first). That's the part not paid back in money,
 * plus — for an unpaid order edited in Shopify to remove items (Shopify
 * records that as a refund of 0 listing the items) — the value of the items
 * removed. Never more than what was still unpaid, so paid orders and returns
 * with a restocking fee aren't touched.
 */
export function unpaidParts(o: ShopOrder, decimals: number): Map<ShopRefund, { money: bigint; removed: bigint }> {
  const amt = (s: string) => decimalToMinor(s, decimals);
  let left = amt(o.total) - amt(o.received);
  const out = new Map<ShopRefund, { money: bigint; removed: bigint }>();
  for (const r of [...o.refunds].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const rt = amt(r.total);
    let paidBack = 0n;
    for (const t of r.transactions) if (t.kind.toUpperCase() === "REFUND" && t.status.toUpperCase() === "SUCCESS") paidBack += amt(t.amount);
    const money = rt - (paidBack > rt ? rt : paidBack);
    const lineValue = r.lines.filter((l) => !l.giftCard).reduce((x, l) => x + amt(l.total), 0n) + amt(r.tax);
    let removed = lineValue - rt;
    const room = left - money;
    if (removed > room) removed = room;
    if (removed < 0n) removed = 0n;
    out.set(r, { money, removed });
    left -= money + removed;
  }
  return out;
}

/**
 * Build one summary per day. `placed` = orders created in the range;
 * `changed` = orders with refunds or cancellations that may fall in the range.
 */
export function summariseDays(input: {
  days: string[];
  timeZone: string | null | undefined;
  startDate: string;
  decimals: number;
  mapping: SalesMapping;
  placed: ShopOrder[];
  changed: ShopOrder[];
  /** Parcel events (from parcelChanges or saved ones) to add to their days. */
  parcels?: ParcelEvent[];
}): DaySummary[] {
  const { days, timeZone, startDate, decimals, mapping: m } = input;
  const dayOf = (iso: string) => todayIn(timeZone, new Date(iso));
  const want = new Set(days);
  const trackCost = !!(m.cogs && m.stock);
  type Bucket = { sums: Map<string, bigint>; orders: number; refunds: number; cancelled: number; missingCost: number; estimatedCost: number; parcelsBack: number; parcelsUndone: number; parcelsHeld: number; parcelsReleased: number };
  const books = new Map<string, Bucket>();
  const bucket = (day: string) => {
    let b = books.get(day);
    if (!b) books.set(day, (b = { sums: new Map(), orders: 0, refunds: 0, cancelled: 0, missingCost: 0, estimatedCost: 0, parcelsBack: 0, parcelsUndone: 0, parcelsHeld: 0, parcelsReleased: 0 }));
    return b;
  };
  const add = (b: Bucket, accountId: string | undefined, v: bigint) => {
    if (!accountId || v === 0n) return;
    b.sums.set(accountId, (b.sums.get(accountId) ?? 0n) + v);
  };
  const amt = (s: string) => decimalToMinor(s, decimals);
  /** Cost of `qty` units; counts items with no cost (and estimates them when a fallback % is set). */
  const costOf = (b: Bucket, qty: number, unitCost: string | null, lineTotal: string): bigint => {
    if (qty <= 0) return 0n;
    if (unitCost !== null && unitCost !== "") return amt(unitCost) * BigInt(qty);
    b.missingCost += qty;
    if (m.costFallbackPercent != null && m.costFallbackPercent > 0) {
      b.estimatedCost += qty;
      return (amt(lineTotal) * BigInt(Math.round(m.costFallbackPercent * 100))) / 10000n;
    }
    return 0n;
  };

  const seen = new Set<string>();
  for (const o of input.placed) {
    if (o.test || seen.has(o.id)) continue;
    seen.add(o.id);
    const day = dayOf(o.createdAt);
    if (!want.has(day)) continue;
    const b = bucket(day);
    const total = amt(o.total), disc = amt(o.discounts), ship = amt(o.shipping), tax = amt(o.tax);
    // Money: per gateway as collected, the rest owed through the unpaid gateway.
    const { byGateway, unpaidGateway } = splitCollections(o, amt);
    let collected = 0n;
    for (const [g, v] of byGateway) {
      const take = v > total - collected ? total - collected : v; // never more than the order
      if (take <= 0n) continue;
      add(b, accountForGateway(g, m), take);
      collected += take;
    }
    add(b, accountForGateway(unpaidGateway, m), total - collected);
    // Gift cards sold are money held for later, not sales.
    const giftSold = o.lines.filter((l) => l.giftCard).reduce((s, l) => s + amt(l.total), 0n);
    add(b, m.giftCards ?? m.sales, -giftSold);
    add(b, m.discounts, disc);
    add(b, m.sales, -(total + disc - ship - tax - giftSold));
    add(b, m.shipping, -ship);
    add(b, m.tax, -tax);
    if (trackCost) {
      let cost = 0n;
      for (const l of o.lines) if (!l.giftCard) cost += costOf(b, l.quantity, l.unitCost, l.total);
      add(b, m.cogs, cost);
      add(b, m.stock, -cost);
    }
    b.orders++;
  }

  const changedSeen = new Set<string>();
  for (const o of [...input.changed, ...input.placed]) {
    if (o.test || changedSeen.has(o.id)) continue;
    changedSeen.add(o.id);
    if (dayOf(o.createdAt) < startDate) continue; // its sale was never brought in
    const { unpaidGateway } = splitCollections(o, amt);
    const owedBy = accountForGateway(unpaidGateway, m);
    const parts = unpaidParts(o, decimals);

    for (const r of o.refunds) {
      const day = dayOf(r.createdAt);
      if (!want.has(day)) continue;
      const b = bucket(day);
      const total = amt(r.total);
      let moved = false;
      if (total !== 0n) {
        const tax = amt(r.tax) > total ? total : amt(r.tax);
        const giftBack = r.lines.filter((l) => l.giftCard).reduce((s, l) => s + amt(l.total), 0n);
        add(b, m.returns, total - tax - giftBack);
        add(b, m.giftCards ?? m.returns, giftBack);
        add(b, m.tax, tax);
        // Credit the method(s) that paid it back; any rest off the order's unpaid method.
        let paidBack = 0n;
        for (const t of r.transactions) {
          if (t.kind.toUpperCase() !== "REFUND" || t.status.toUpperCase() !== "SUCCESS") continue;
          const v = amt(t.amount) > total - paidBack ? total - paidBack : amt(t.amount);
          if (v <= 0n) continue;
          add(b, accountForGateway(t.gateway, m), -v);
          paidBack += v;
        }
        add(b, owedBy, -(total - paidBack));
        moved = true;
      }
      // Items taken off an unpaid order by editing it: the sale comes off what's owed.
      const removed = parts.get(r)?.removed ?? 0n;
      if (removed > 0n) {
        const lineTax = amt(r.tax);
        const taxTaken = total > 0n ? (lineTax > total ? total : lineTax) : 0n;
        const lineValue = r.lines.filter((l) => !l.giftCard).reduce((x, l) => x + amt(l.total), 0n) + lineTax;
        let tax = lineValue > 0n ? share(lineTax, removed, lineValue) : 0n;
        if (tax > lineTax - taxTaken) tax = lineTax - taxTaken;
        add(b, m.returns, removed - tax);
        add(b, m.tax, tax);
        add(b, owedBy, -removed);
        moved = true;
      }
      if (trackCost) {
        let back = 0n;
        // A copy of the bucket: items with no cost were already counted when sold.
        for (const l of r.lines) if (l.restock && !l.giftCard) back += costOf({ ...b }, l.quantity, l.unitCost, l.total);
        if (back !== 0n) moved = true;
        add(b, m.stock, back);
        add(b, m.cogs, -back);
      }
      if (moved) b.refunds++;
    }

    if (o.cancelledAt) {
      const day = dayOf(o.cancelledAt);
      if (!want.has(day)) continue;
      const total = amt(o.total);
      // What's still unpaid: refunds up to the cancellation that weren't paid back already took their part off.
      let unpaid = total - amt(o.received);
      for (const r of o.refunds) {
        if (dayOf(r.createdAt) > day) continue;
        const p = parts.get(r);
        if (p) unpaid -= p.money + p.removed;
      }
      // Never shipped: nothing left the warehouse, so none of its cost stays — restocked in Shopify or not.
      // (Items Shopify did restock come back through its refund; this is the rest.)
      let back = 0n;
      if (trackCost && o.shipped === false) {
        const scratch = { ...bucket(day) };
        for (const l of o.lines) if (!l.giftCard) back += costOf(scratch, l.quantity, l.unitCost, l.total);
        for (const r of o.refunds) for (const l of r.lines) if (l.restock && !l.giftCard) back -= costOf(scratch, l.quantity, l.unitCost, l.total);
      }
      if (unpaid <= 0n && back <= 0n) continue; // fully paid (money back comes through refunds) or already refunded
      const b = bucket(day);
      if (back > 0n) {
        add(b, m.stock, back);
        add(b, m.cogs, -back);
      }
      if (unpaid > 0n) {
        const tax = share(amt(o.tax), unpaid, total);
        add(b, m.returns, unpaid - tax);
        add(b, m.tax, tax);
        add(b, owedBy, -unpaid);
      }
      b.cancelled++;
    }
  }

  for (const p of input.parcels ?? []) {
    if (p.kind === "skip" || p.kind === "lost" || !want.has(p.day)) continue;
    const b = bucket(p.day);
    for (const [accountId, v] of Object.entries(p.lines)) add(b, accountId, BigInt(v));
    if (p.kind === "returned") b.parcelsBack++;
    else if (p.kind === "reinstated") b.parcelsUndone++;
    else if (p.kind === "held") b.parcelsHeld++;
    else if (p.kind === "released") b.parcelsReleased++;
  }

  const out: DaySummary[] = [];
  for (const day of days) {
    const b = books.get(day);
    if (!b) continue;
    const debits: DaySummary["debits"] = [];
    const credits: DaySummary["credits"] = [];
    for (const [accountId, v] of b.sums) {
      if (v > 0n) debits.push({ accountId, amount: v.toString() });
      else if (v < 0n) credits.push({ accountId, amount: (-v).toString() });
    }
    if (debits.length === 0 && credits.length === 0) continue;
    const parts = [`${b.orders} order${b.orders === 1 ? "" : "s"}`];
    if (b.refunds) parts.push(`${b.refunds} refund${b.refunds === 1 ? "" : "s"}`);
    if (b.cancelled) parts.push(`${b.cancelled} cancelled`);
    if (b.parcelsBack) parts.push(`${b.parcelsBack} parcel${b.parcelsBack === 1 ? "" : "s"} came back`);
    if (b.parcelsUndone) parts.push(`${b.parcelsUndone} parcel${b.parcelsUndone === 1 ? "" : "s"} delivered after all`);
    const until = m.codBasis === "money" ? "paid" : m.codBasis === "delivery" ? "delivered" : "dispatched";
    if (b.parcelsHeld) parts.push(`${b.parcelsHeld} ${m.codBasis === "money" ? "unpaid" : "COD"} order${b.parcelsHeld === 1 ? "" : "s"} held until ${until}`);
    if (b.parcelsReleased) parts.push(`${b.parcelsReleased} ${until}`);
    if (b.missingCost) parts.push(`${b.missingCost} item${b.missingCost === 1 ? "" : "s"} with no cost in Shopify${b.estimatedCost ? " (estimated)" : " (left out)"}`);
    out.push({ day, debits, credits, orders: b.orders, refunds: b.refunds, cancelled: b.cancelled, missingCost: b.missingCost, estimatedCost: b.estimatedCost, parcelsBack: b.parcelsBack, parcelsUndone: b.parcelsUndone, parcelsHeld: b.parcelsHeld, parcelsReleased: b.parcelsReleased, memo: `Shopify: ${parts.join(", ")}` });
  }
  return out;
}

// ── Parcels that come back ───────────────────────────────────────────────────

/**
 * Delivery statuses that mean the parcel came back or never got through —
 * the same list the dashboard uses, minus the cancelled ones (a Shopify
 * cancellation is recorded by its own rule).
 */
const RETURNED_STATUSES = new Set(["RETURNED", "FAILED_DELIVERY", "REFUSED", "RTS", "RTO", "RETURN", "UNDELIVERED", "RETURN IN TRANSIT"]);
export function isReturnedStatus(status: string | null | undefined): boolean {
  return RETURNED_STATUSES.has(String(status ?? "").trim().toUpperCase());
}
export function isDeliveredStatus(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toUpperCase() === "DELIVERED";
}

/** "gid://shopify/Order/123" → "123" (delivery tracking keys orders by the number). */
export function legacyOrderId(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/** The first day Shopify itself cancelled or refunded the order, if ever. */
export function firstShopifyReturnDay(o: ShopOrder, dayOf: (iso: string) => string): string | null {
  const days = [...(o.cancelledAt ? [dayOf(o.cancelledAt)] : []), ...o.refunds.map((r) => dayOf(r.createdAt))].sort();
  return days[0] ?? null;
}

/**
 * The dashboard also counts an order as returned when it carries one of the
 * couriers' return tags, whatever its tracking status says.
 */
export function trackingStatus(status: string | null | undefined, tags: unknown): string {
  const t = typeof tags === "string" ? tags : tags ? JSON.stringify(tags) : "";
  return t.includes("Return to Shipper") || t.includes("Refused to Accept") ? "RETURNED" : String(status ?? "");
}

/**
 * What a returned parcel still has to take off, as of the end of `day`, after
 * Shopify's own cancellation and refunds up to then: the part of the order
 * still unpaid (back off the unpaid method, with its share of tax) and the
 * cost of items not yet restocked (back into stock). Null when nothing is
 * unpaid — a paid order comes back through a refund in Shopify.
 */
export function parcelReturnLines(o: ShopOrder, m: SalesMapping, decimals: number, asOf?: { day: string; dayOf: (iso: string) => string }, saleAccount: string = m.returns): ParcelLines | null {
  const amt = (s: string) => decimalToMinor(s, decimals);
  const by = (iso: string) => !asOf || asOf.dayOf(iso) <= asOf.day;
  const total = amt(o.total);
  let unpaid = total - amt(o.received);
  if (o.cancelledAt && by(o.cancelledAt)) unpaid = 0n; // Shopify's cancellation takes it off
  const refunds = o.refunds.filter((r) => by(r.createdAt));
  const parts = unpaidParts(o, decimals);
  // What refunds (and edits) already took off what was owed.
  for (const r of refunds) {
    const p = parts.get(r);
    if (p) unpaid -= p.money + p.removed;
  }
  if (unpaid <= 0n) return null;
  const sums = new Map<string, bigint>();
  const add = (id: string | undefined, v: bigint) => {
    if (!id || v === 0n) return;
    sums.set(id, (sums.get(id) ?? 0n) + v);
  };
  const tax = share(amt(o.tax), unpaid, total);
  add(saleAccount, unpaid - tax);
  add(m.tax, tax);
  add(accountForGateway(splitCollections(o, amt).unpaidGateway, m), -unpaid);
  if (m.cogs && m.stock) {
    const costOf = (qty: number, unitCost: string | null, lineTotal: string) => {
      if (qty <= 0) return 0n;
      if (unitCost !== null && unitCost !== "") return amt(unitCost) * BigInt(qty);
      if (m.costFallbackPercent != null && m.costFallbackPercent > 0) return (amt(lineTotal) * BigInt(Math.round(m.costFallbackPercent * 100))) / 10000n;
      return 0n;
    };
    let cost = 0n;
    for (const l of o.lines) if (!l.giftCard) cost += costOf(l.quantity, l.unitCost, l.total);
    for (const r of refunds) for (const l of r.lines) if (l.restock && !l.giftCard) cost -= costOf(l.quantity, l.unitCost, l.total);
    if (cost > 0n) {
      add(m.stock, cost);
      add(m.cogs, -cost);
    }
  }
  const lines: ParcelLines = {};
  for (const [k, v] of sums) if (v !== 0n) lines[k] = v.toString();
  return Object.keys(lines).length ? lines : null;
}

export function negateLines(lines: ParcelLines): ParcelLines {
  return Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, (-BigInt(v)).toString()]));
}

/** target − current, per account; null when nothing changes. */
function diffLines(target: ParcelLines, current: ParcelLines): ParcelLines | null {
  const out: ParcelLines = {};
  for (const k of new Set([...Object.keys(target), ...Object.keys(current)])) {
    const v = BigInt(target[k] ?? "0") - BigInt(current[k] ?? "0");
    if (v !== 0n) out[k] = v.toString();
  }
  return Object.keys(out).length ? out : null;
}

/** Add parcel lines together (an order's events so far). */
export function sumLines(all: ParcelLines[]): ParcelLines {
  const t = new Map<string, bigint>();
  for (const l of all) for (const [k, v] of Object.entries(l)) t.set(k, (t.get(k) ?? 0n) + BigInt(v));
  const out: ParcelLines = {};
  for (const [k, v] of t) if (v !== 0n) out[k] = v.toString();
  return out;
}

const isEmpty = (l: ParcelLines) => Object.keys(l).length === 0;

/**
 * What changes for parcels while bringing in days [from, to].
 *
 * `orders` = the orders to look at: those tracking says came back, and any
 * order Shopify changed in these days. `active` = what's in the books for a
 * parcel from before `from` (its events added up).
 *
 * A parcel that tracking says came back is taken off on its order day (or
 * `from` for an older order) — whatever Shopify hasn't already taken off.
 * On each later day Shopify cancels or refunds it, Books' part is brought in
 * line with what's left, so nothing is ever taken off twice; if Shopify has
 * taken it all off, Books' part is undone. Delivered after all: undone on
 * `from`. Orders before the connector's first day, after `to`, test orders,
 * and orders with nothing unpaid left are left alone; the settled ones get a
 * "skip" so they aren't looked at again.
 */
export function parcelChanges(input: {
  orders: ShopOrder[];
  statusOf: Map<string, string>;
  /** `recheck`: look at it on `from` too (a parcel written off as lost that may since have come back). */
  active: Map<string, { lines: ParcelLines; orderName: string; recheck?: boolean }>;
  from: string;
  to: string;
  startDate: string;
  timeZone: string | null | undefined;
  decimals: number;
  mapping: SalesMapping;
  /**
   * Holding COD orders until they're dispatched or delivered: `account` takes
   * the held sale; `onDay` (by legacy order id) is the day each went out or
   * arrived, when known. A delivered status counts as out from `from` —
   * unless `deliveredReleases` is false (held until paid: only money lets it in).
   */
  hold?: { account: string; onDay: Map<string, string>; allOut?: boolean; deliveredReleases?: boolean };
}): ParcelEvent[] {
  const { from, to, mapping: m, hold } = input;
  const dayOf = (iso: string) => todayIn(input.timeZone, new Date(iso));
  const out: ParcelEvent[] = [];
  const seen = new Set<string>();
  const isHeld = (l: ParcelLines) => !!hold && l[hold.account] !== undefined;
  const deliveredOut = (status: string | undefined) => hold?.deliveredReleases !== false && isDeliveredStatus(status);
  for (const o of input.orders) {
    if (o.test || seen.has(o.id)) continue;
    seen.add(o.id);
    const orderDay = dayOf(o.createdAt);
    if (orderDay > to) continue; // its sale isn't in the books yet
    const legacy = legacyOrderId(o.id);
    const status = input.statusOf.get(legacy);
    const was = input.active.get(o.id)?.lines ?? {};
    if (orderDay < input.startDate) {
      // Its sale was never brought in: remember, so it isn't fetched again.
      if (isEmpty(was) && isReturnedStatus(status)) out.push({ orderId: o.id, orderName: o.name, day: to, kind: "skip", lines: {} });
      continue;
    }
    const onDay = hold?.onDay.get(legacy);
    let current = was;
    const first = orderDay > from ? orderDay : from;
    // The days to look at: the first one, then each day Shopify cancels or refunds it (and the day it goes out, when held).
    const shopDays = [...new Set([...(o.cancelledAt ? [dayOf(o.cancelledAt)] : []), ...o.refunds.map((r) => dayOf(r.createdAt))])];
    const marks = [...new Set([...shopDays, ...(onDay ? [onDay] : [])])].sort();
    const heldNow = isHeld(was);
    const lookFrom = (heldNow ? deliveredOut(status) : isDeliveredStatus(status)) || (input.active.get(o.id)?.recheck && isReturnedStatus(status)) || (heldNow && (!!hold?.allOut || isReturnedStatus(status) || (!!onDay && onDay <= to)));
    // Already in the books: looked at again only when something changed for it.
    const days = isEmpty(was)
      ? [first, ...marks.filter((d) => d > first && d <= to)]
      : lookFrom
        ? [from, ...marks.filter((d) => d > from && d <= to)]
        : marks.filter((d) => d >= from && d <= to);
    for (const day of days) {
      let target: ParcelLines;
      let goneOut = false;
      if (isReturnedStatus(status)) target = parcelReturnLines(o, m, input.decimals, { day, dayOf }) ?? {};
      else if (hold) {
        goneOut = !!hold.allOut || deliveredOut(status) || (!!onDay && day >= onDay);
        target = goneOut ? {} : parcelReturnLines(o, m, input.decimals, { day, dayOf }, hold.account) ?? {};
      } else if (isDeliveredStatus(status)) target = {};
      else if (!isEmpty(current)) target = parcelReturnLines(o, m, input.decimals, { day, dayOf }) ?? {};
      else continue;
      const delta = diffLines(target, current);
      if (!delta) continue;
      const kind: ParcelEvent["kind"] = isEmpty(current)
        ? isHeld(target)
          ? "held"
          : "returned"
        : isEmpty(target)
          ? isHeld(current)
            ? goneOut
              ? "released"
              : "adjusted"
            : "reinstated"
          : "adjusted";
      out.push({ orderId: o.id, orderName: o.name, day, kind, lines: delta });
      current = target;
    }
    // Nothing unpaid left at all (paid, or settled in Shopify): never look at it again.
    if (isEmpty(was) && isEmpty(current) && isReturnedStatus(status) && parcelReturnLines(o, m, input.decimals) === null) {
      out.push({ orderId: o.id, orderName: o.name, day: to, kind: "skip", lines: {} });
    }
  }
  // No Shopify data needed: delivered after all (a return undone), or a held order that's now gone out.
  for (const [id, a] of input.active) {
    if (seen.has(id) || isEmpty(a.lines)) continue;
    const legacy = legacyOrderId(id);
    const status = input.statusOf.get(legacy);
    if (isReturnedStatus(status)) continue;
    if (isHeld(a.lines)) {
      const onDay = hold!.onDay.get(legacy);
      if (!hold!.allOut && !deliveredOut(status) && !(onDay && onDay <= to)) continue;
      out.push({ orderId: id, orderName: a.orderName, day: onDay && onDay > from ? onDay : from, kind: "released", lines: negateLines(a.lines) });
    } else if (isDeliveredStatus(status)) {
      out.push({ orderId: id, orderName: a.orderName, day: from, kind: "reinstated", lines: negateLines(a.lines) });
    }
  }
  return out;
}

/** Shopify GraphQL order node → our order shape. */
export function toShopOrder(n: any): ShopOrder {
  const money = (x: any) => String(x?.shopMoney?.amount ?? "0");
  const tx = (t: any): ShopTransaction => ({ kind: String(t?.kind ?? ""), status: String(t?.status ?? ""), gateway: String(t?.gateway ?? ""), amount: money(t?.amountSet) });
  const cost = (v: any) => (v?.inventoryItem?.unitCost?.amount != null ? String(v.inventoryItem.unitCost.amount) : null);
  const str = (x: any) => (x === null || x === undefined || x === "" ? null : String(x));
  return {
    id: n.id,
    name: n.name,
    createdAt: n.createdAt,
    cancelledAt: n.cancelledAt ?? null,
    test: !!n.test,
    currency: n.totalPriceSet?.shopMoney?.currencyCode ?? "",
    gateways: n.paymentGatewayNames ?? [],
    total: money(n.totalPriceSet),
    received: money(n.totalReceivedSet),
    discounts: money(n.totalDiscountsSet),
    shipping: money(n.totalShippingPriceSet),
    tax: money(n.totalTaxSet),
    transactions: (n.transactions ?? []).map(tx),
    shipped: Array.isArray(n.fulfillments) ? n.fulfillments.some((f: any) => !["CANCELLED", "ERROR", "FAILURE"].includes(String(f?.status ?? "").toUpperCase())) : undefined,
    lines: (n.lineItems?.nodes ?? []).map((l: any) => ({
      quantity: Number(l.quantity ?? 0),
      giftCard: !!l.isGiftCard,
      total: money(l.discountedTotalSet),
      unitCost: cost(l.variant),
      lineId: str(l.id),
      variantId: str(l.variant?.id),
      sku: str(l.sku),
      title: str([l.title, l.variantTitle].filter(Boolean).join(" / ") || null),
    })),
    refunds: (n.refunds ?? []).map((r: any) => {
      const lines = (r.refundLineItems?.nodes ?? []).map((x: any) => ({
        quantity: Number(x.quantity ?? 0),
        restock: isRestock(x.restockType),
        giftCard: !!x.lineItem?.isGiftCard,
        total: money(x.subtotalSet),
        unitCost: cost(x.lineItem?.variant),
        lineId: str(x.lineItem?.id),
        tax: money(x.totalTaxSet),
      }));
      // Exact decimal sum (6 places is finer than any currency).
      const tax6 = lines.reduce((s: bigint, l: any) => s + decimalToMinor(l.tax, 6), 0n);
      const neg = tax6 < 0n;
      const a = neg ? -tax6 : tax6;
      const taxStr = `${neg ? "-" : ""}${a / 1000000n}.${(a % 1000000n).toString().padStart(6, "0")}`;
      return {
        createdAt: String(r.createdAt),
        total: money(r.totalRefundedSet),
        tax: taxStr,
        transactions: (r.transactions?.nodes ?? []).map(tx),
        lines: lines.map(({ tax: _t, ...rest }: any) => rest),
      };
    }),
  };
}

// ── Costs at sale, and manual payments ───────────────────────────────────────

/** A line as Financify's order records keep it (orders.lineItems). */
export interface StoredLine {
  lineItemId?: string | null;
  variantId?: string | null;
  sku?: string | null;
  title?: string | null;
  variantTitle?: string | null;
  quantity?: number | string | null;
  unitCost?: number | string | null;
}

const blank = (x: unknown) => x === null || x === undefined || String(x).trim() === "";
const gidTail = (x: unknown) => (blank(x) ? "" : String(x).slice(String(x).lastIndexOf("/") + 1));
/** A usable cost: a number above zero. Zero and blanks mean "unknown" in both systems. */
function usableCost(x: unknown): string | null {
  if (blank(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? String(x) : null;
}

/**
 * Each line's cost by the store's chosen source. Lines are matched to Financify's
 * records by line id, then variant, SKU, title, and finally position (a variant
 * deleted and recreated keeps nothing else) — each stored line used once.
 * Refund lines take the cost of the line they refund. Returns how many lines'
 * costs came from Financify.
 */
export function applyStoredCosts(o: ShopOrder, stored: StoredLine[] | undefined, mode: "at_sale" | "shopify_now"): { order: ShopOrder; filled: number } {
  if (!stored || stored.length === 0) return { order: o, filled: 0 };
  const used = new Set<number>();
  const pick = (test: (s: StoredLine) => boolean) => {
    const i = stored.findIndex((s, k) => !used.has(k) && test(s));
    if (i >= 0) used.add(i);
    return i >= 0 ? stored[i] : null;
  };
  const title = (s: StoredLine) => [s.title, s.variantTitle].filter((x) => !blank(x)).join(" / ").toLowerCase();
  const matches = o.lines.map((l) => {
    if (l.giftCard) return null;
    return (
      (l.lineId ? pick((s) => gidTail(s.lineItemId) !== "" && gidTail(s.lineItemId) === gidTail(l.lineId)) : null) ??
      (l.variantId ? pick((s) => gidTail(s.variantId) !== "" && gidTail(s.variantId) === gidTail(l.variantId)) : null) ??
      (l.sku ? pick((s) => !blank(s.sku) && String(s.sku).toLowerCase() === l.sku!.toLowerCase()) : null) ??
      (l.title ? pick((s) => title(s) !== "" && title(s) === l.title!.toLowerCase()) : null)
    );
  });
  // Position, only when the two lists line up (same count and quantities) — for lines nothing else matched.
  const sameShape = stored.length === o.lines.length && stored.every((s, i) => Number(s.quantity ?? 0) === o.lines[i]!.quantity);
  o.lines.forEach((l, i) => {
    if (!matches[i] && sameShape && !l.giftCard && !used.has(i)) {
      used.add(i);
      matches[i] = stored[i];
    }
  });
  let filled = 0;
  const costOf = new Map<string, string | null>();
  const lines = o.lines.map((l, i) => {
    const fromStore = usableCost(matches[i]?.unitCost);
    const fromShopify = usableCost(l.unitCost);
    const chosen = mode === "at_sale" ? fromStore ?? fromShopify : fromShopify ?? fromStore;
    if (chosen !== null && chosen === fromStore && chosen !== fromShopify) filled++;
    if (l.lineId) costOf.set(gidTail(l.lineId), chosen);
    return { ...l, unitCost: chosen };
  });
  const refunds = o.refunds.map((r) => ({
    ...r,
    lines: r.lines.map((rl) => {
      const k = rl.lineId ? gidTail(rl.lineId) : "";
      return k && costOf.has(k) ? { ...rl, unitCost: costOf.get(k) ?? null } : rl;
    }),
  }));
  return { order: { ...o, lines, refunds }, filled };
}

/** How a manual-payment order was delivered: a courier, your own riders, or not known. */
export type ManualEvidence = "courier" | "self" | "none";

/**
 * "Manual" payment on an order a courier delivered is cash on delivery: the courier
 * collected it and owes it to you. Delivered by your own riders, it's cash they
 * collected. With no tracking it stays as mapped (paid before shipping). Only orders
 * paid by manual payment alone are re-read; a manual advance next to COD is left as is.
 */
export function routeManualPayment(o: ShopOrder, evidence: ManualEvidence | undefined): ShopOrder {
  const gws = o.gateways.filter((g) => !isGiftCardGateway(g));
  if (!evidence || evidence === "none" || gws.length !== 1 || gws[0]!.toLowerCase() !== "manual") return o;
  const to = evidence === "courier" ? "Cash on Delivery (COD)" : SELF_DELIVERY_GATEWAY;
  const swap = (g: string) => (g.toLowerCase() === "manual" ? to : g);
  return {
    ...o,
    gateways: o.gateways.map(swap),
    transactions: o.transactions.map((t) => ({ ...t, gateway: swap(t.gateway) })),
    refunds: o.refunds.map((r) => ({ ...r, transactions: r.transactions.map((t) => ({ ...t, gateway: swap(t.gateway) })) })),
  };
}
