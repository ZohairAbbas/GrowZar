/**
 * The parcel register's rules. Pure: an order (as Books reads it from
 * Shopify) and what Books recorded for it in, a register row's figures out;
 * a row in, its stage out.
 *
 * "Owed" follows exactly the rules the daily sales entries use, so the open
 * parcels add up to the "Owed by couriers" balance (apart from payouts and
 * entries that don't name an order — the Courier balances screen shows that
 * difference).
 */

import { accountForGateway, decimalToMinor, isCodGateway, splitCollections, unpaidParts, type ParcelLines, type SalesMapping, type ShopOrder } from "./shopify-sales";
import { todayIn } from "../dates";

/** Accounts cash-on-delivery money is owed through: the COD account and any COD gateway mapped elsewhere. */
export function courierAccounts(m: SalesMapping): Set<string> {
  const out = new Set<string>();
  if (m.cod) out.add(m.cod);
  for (const [g, id] of Object.entries(m.gateways ?? {})) if (isCodGateway(g) && id) out.add(id);
  return out;
}

export interface OwedFigures {
  accountId: string;
  /** Owed through the courier when the order came in. */
  saleOwed: bigint;
  /** Owed now: after Shopify's refunds, edits and cancellation up to `asOf`, and Books' parcel entries. */
  owed: bigint;
}

/**
 * What an order owes through the courier, by Books' own rules, as of `asOf`
 * (the last day brought in). Null when it doesn't go through a courier.
 * `parcelLines` = Books' parcel entries for it that still count.
 */
export function owedFigures(o: ShopOrder, m: SalesMapping, decimals: number, timeZone: string | null | undefined, asOf: string, parcelLines: ParcelLines[]): OwedFigures | null {
  const amt = (s: string) => decimalToMinor(s, decimals);
  const dayOf = (iso: string) => todayIn(timeZone, new Date(iso));
  const { byGateway, unpaidGateway } = splitCollections(o, amt);
  const accountId = accountForGateway(unpaidGateway, m);
  if (!courierAccounts(m).has(accountId)) return null;
  const total = amt(o.total);
  // Exactly as the day's entry: each gateway's collection (capped at the order), the rest through the unpaid one.
  let collected = 0n;
  let saleOwed = 0n;
  for (const [g, v] of byGateway) {
    const take = v > total - collected ? total - collected : v;
    if (take <= 0n) continue;
    if (accountForGateway(g, m) === accountId) saleOwed += take; // a COD capture is still owed by the courier
    collected += take;
  }
  saleOwed += total - collected;
  if (saleOwed <= 0n) return null;
  let owed = saleOwed;
  const parts = unpaidParts(o, decimals);
  for (const r of o.refunds) {
    if (dayOf(r.createdAt) > asOf) continue;
    const p = parts.get(r);
    if (p) owed -= p.money + p.removed;
  }
  if (o.cancelledAt && dayOf(o.cancelledAt) <= asOf) {
    // The cancellation takes off whatever was still unpaid (as the daily entry does).
    let unpaid = total - amt(o.received);
    for (const r of o.refunds) {
      if (dayOf(r.createdAt) > dayOf(o.cancelledAt)) continue;
      const p = parts.get(r);
      if (p) unpaid -= p.money + p.removed;
    }
    if (unpaid > 0n) owed -= unpaid;
  }
  for (const l of parcelLines) owed += BigInt(l[accountId] ?? "0");
  return { accountId, saleOwed, owed: owed < 0n ? 0n : owed };
}

// ── Stages ───────────────────────────────────────────────────────────────────

export type ParcelStage =
  | "held"
  | "not_shipped"
  | "in_transit"
  | "stuck"
  | "delivered"
  | "paid_not_recorded"
  | "short_paid"
  | "overpaid"
  | "cleared"
  | "came_back"
  | "cancelled"
  | "written_off";

export const STAGE_LABELS: Record<ParcelStage, string> = {
  held: "Not a sale yet — held back (dispatch, delivery or payment)",
  not_shipped: "Not shipped yet",
  in_transit: "On the way",
  stuck: "Stuck — no news",
  delivered: "Delivered, waiting for payout",
  paid_not_recorded: "Paid by the courier, payout not in your books",
  short_paid: "Paid short",
  overpaid: "Paid more than owed",
  cleared: "Paid",
  came_back: "Came back",
  cancelled: "Cancelled or refunded",
  written_off: "Written off",
};

/** Stages where money is still expected from the courier. */
export const OPEN_STAGES: ParcelStage[] = ["not_shipped", "in_transit", "stuck", "delivered", "paid_not_recorded", "short_paid"];

export interface StageInput {
  saleOwed: bigint;
  owed: bigint;
  paid: bigint;
  writtenOff: bigint;
  shipped: boolean | null;
  trackingStatus: string | null;
  trackingAt: Date | null;
  placedDay: string;
  settledAt: Date | null;
  settledNet: bigint | null;
  settledFees: bigint | null;
}

export interface StageRules {
  /** No tracking news for this many days on a parcel on its way: stuck. */
  stuckAfterDays: number;
  /** Not shipped this many days after the order: stuck. */
  unshippedAfterDays: number;
}

export const DEFAULT_STAGE_RULES: StageRules = { stuckAfterDays: 21, unshippedAfterDays: 14 };

const RETURNED = new Set(["RETURNED", "FAILED_DELIVERY", "REFUSED", "RTS", "RTO", "RETURN", "UNDELIVERED", "RETURN IN TRANSIT"]);
const MOVING = new Set(["DISPATCHED", "IN_TRANSIT", "OUT_FOR_DELIVERY"]);

const daysBetween = (fromIso: string, toIso: string) => Math.floor((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

/** Still owed by the courier per Books: owed − cleared by a payout − written off. */
export function openAmount(p: Pick<StageInput, "owed" | "paid" | "writtenOff">): bigint {
  return p.owed - p.paid - p.writtenOff;
}

export function parcelStage(p: StageInput, today: string, rules: StageRules = DEFAULT_STAGE_RULES): ParcelStage {
  const open = openAmount(p);
  const status = String(p.trackingStatus ?? "").toUpperCase();
  if (p.owed === 0n) return p.writtenOff > 0n ? "written_off" : RETURNED.has(status) ? "came_back" : "cancelled";
  if (open < 0n) return "overpaid";
  if (open === 0n) return p.writtenOff > 0n && p.paid === 0n ? "written_off" : "cleared";
  // Money is still owed in the books.
  if (p.paid > 0n) return "short_paid";
  if (p.settledAt) return "paid_not_recorded";
  if (status === "DELIVERED") return "delivered";
  const lastNews = p.trackingAt ? p.trackingAt.toISOString().slice(0, 10) : p.placedDay;
  if (MOVING.has(status) || RETURNED.has(status)) return daysBetween(lastNews, today) >= rules.stuckAfterDays ? "stuck" : "in_transit";
  if (p.shipped) return daysBetween(lastNews, today) >= rules.stuckAfterDays ? "stuck" : "in_transit";
  return daysBetween(p.placedDay, today) >= rules.unshippedAfterDays ? "stuck" : "not_shipped";
}

/** What the courier collected for a parcel it paid out (net + its charges); 0 for one that came back. */
export function settledGross(net: bigint | null, fees: bigint | null): bigint {
  const g = (net ?? 0n) + (fees ?? 0n);
  return g < 0n ? 0n : g;
}

// ── Courierify on the order ──────────────────────────────────────────────────

export interface CourierifyOnOrder {
  courier: string | null;
  trackingNumber: string | null;
  bookedFees: bigint | null;
  codAmount: bigint | null;
  settlementRef: string | null;
  settledAt: Date | null;
  settledNet: bigint | null;
  settledFees: bigint | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Courierify's two order metafields: `courier_costs` (the booking: courier,
 * tracking, its charges, the amount to collect) and `settlement` (the payout,
 * once the courier has paid it: reference, charges, net, date). Anything
 * missing or malformed is left null — never guessed. Amounts in another
 * currency than the book's are ignored.
 */
export function readCourierify(costsJson: string | null | undefined, settlementJson: string | null | undefined, decimals: number, currency: string): CourierifyOnOrder {
  const minor = (v: number | null) => (v === null ? null : BigInt(Math.round(v * 10 ** decimals)));
  const parse = (s: string | null | undefined) => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const c = parse(costsJson);
  const st = parse(settlementJson);
  const out: CourierifyOnOrder = { courier: null, trackingNumber: null, bookedFees: null, codAmount: null, settlementRef: null, settledAt: null, settledNet: null, settledFees: null };
  if (c && typeof c === "object") {
    out.courier = typeof c.courier === "string" && c.courier.trim() ? c.courier.trim() : null;
    out.trackingNumber = typeof c.trackingNumber === "string" ? c.trackingNumber : null;
    const k = c.costs ?? {};
    const sameCurrency = !k.currency || String(k.currency).toUpperCase() === currency;
    if (sameCurrency) {
      const parts = [num(k.deliveryFee), num(k.codFee), num(k.insuranceFee)];
      const itemised = parts.reduce<number>((a, b) => a + (b ?? 0), 0);
      const tax = num(k.taxAmount);
      const gross = num(k.grossCharges);
      const fees = Math.max(itemised + (tax ?? 0), gross ?? 0);
      out.bookedFees = parts.some((x) => x !== null) || gross !== null ? minor(fees) : null;
      out.codAmount = minor(num(k.codAmount));
    }
  }
  if (st && typeof st === "object" && String(st.status ?? "").toLowerCase() === "received") {
    const f = st.fees ?? {};
    const sameCurrency = !f.currency || String(f.currency).toUpperCase() === currency;
    const at = typeof st.settledAt === "string" && !Number.isNaN(Date.parse(st.settledAt)) ? new Date(st.settledAt) : null;
    const ref = typeof st.settlementRef === "string" && st.settlementRef.trim() ? st.settlementRef.trim() : null;
    const net = num(f.netAmount);
    if (sameCurrency && at && ref && net !== null) {
      out.settlementRef = ref;
      out.settledAt = at;
      out.settledNet = minor(net);
      out.settledFees = minor((num(f.deliveryFee) ?? 0) + (num(f.codFee) ?? 0) + (num(f.reversalFee) ?? 0));
      out.courier ??= typeof st.courier === "string" ? st.courier : null;
    }
  }
  return out;
}
