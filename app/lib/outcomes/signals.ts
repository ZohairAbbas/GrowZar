/**
 * "Did it" signals (G-GZR9-4, pack §5): evidence in the apps' own data that
 * the merchant made the change the insight pointed at, after acting. Pure.
 *
 * A signal never opens a watch and never changes its trigger (pack §10.4):
 * it upgrades what the outcome may say, from "since you looked at this" to
 * "after you opened this, you changed X". Once seen, it is kept.
 */

import type { RollupOrder } from "../metrics/rollups";

export type Observed = {
  /** Which change was seen, e.g. `courier_share_up`. */
  signal: string;
  /** In words, for the card: "booked 64% of Lahore's parcels with Leopards, up from 31%". */
  text: string;
  /** When it was seen: the app's own time where it has one, else the measurement's. */
  at: string;
  evidence: Record<string, unknown>;
};

/** The two claim levels (pack §4); never more. */
export type ClaimLevel = "changed" | "looked";
export const claimLevel = (observed: unknown): ClaimLevel => (observed && typeof observed === "object" && "signal" in observed ? "changed" : "looked");

// ── Thresholds (pack §5; the last three are this item's, see the PR) ────────

export const ROUTE_SHARE_POINTS = 20;
export const ORDER_SHARE_DROP = 0.2;
export const COVERAGE_POINTS = 10;
export const SPEND_DROP = 0.5;
export const PRICE_RISE = 0.05;
export const ORDERS_STOP = 0.8;
/** After-window orders needed before a share-type signal speaks. */
export const MIN_AFTER_ORDERS = 10;

export type Share = { hits: number; of: number };
const rate = (s: Share) => (s.of ? s.hits / s.of : 0);
const pct = (x: number) => Math.round(x * 1000) / 10;

/** A share that rose by at least `points` percentage points, with enough after-window orders. */
export function shareRose(before: Share, after: Share, points: number): { from: number; to: number } | null {
  if (after.of < MIN_AFTER_ORDERS || !before.of) return null;
  const from = pct(rate(before));
  const to = pct(rate(after));
  return to - from >= points ? { from, to } : null;
}

/** A share that fell by at least `relative` of itself. */
export function shareFell(before: Share, after: Share, relative: number): { from: number; to: number } | null {
  if (after.of < MIN_AFTER_ORDERS || !before.hits) return null;
  const from = rate(before);
  const to = rate(after);
  return to <= from * (1 - relative) ? { from: pct(from), to: pct(to) } : null;
}

/** A per-day amount that fell by at least `relative` (ad spend, orders). */
export function perDayFell(before: { total: number; days: number }, after: { total: number; days: number }, relative: number): { from: number; to: number } | null {
  if (!before.days || !after.days || before.total <= 0) return null;
  const from = before.total / before.days;
  const to = after.total / after.days;
  return to <= from * (1 - relative) ? { from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 } : null;
}

export const nowSignal = (signal: string, text: string, now: Date, evidence: Record<string, unknown>): Observed => ({ signal, text, at: now.toISOString(), evidence });

/** The first dated event after acting, as a signal at its own time. */
export function firstAfter<T extends { at: Date }>(events: readonly T[], actedAt: Date): T | null {
  return [...events].filter((e) => e.at > actedAt).sort((a, b) => a.at.getTime() - b.at.getTime())[0] ?? null;
}

// ── Per detector ─────────────────────────────────────────────────────────────

type Window = { from: string; to: string };
const inW = (o: { localDay: string | null }, w: Window) => !!o.localDay && o.localDay >= w.from && o.localDay <= w.to;
const sameCity = (o: RollupOrder, city: string) => !!o.city && o.city.toLowerCase() === city.toLowerCase();
const hasVariant = (o: RollupOrder, v: string) => o.lines.some((l) => l.variantId === v);

/** A Preventify form order, as far as signals need it. */
export type FormOrderFact = { localDay: string; variantIds: string[]; prepaid: boolean; verified: boolean };

/** Everything a watch's signal may read; the server loads only what the detector needs. */
export type SignalInput = {
  detector: string;
  subject: string;
  finding: Record<string, unknown> | null;
  actedAt: Date;
  now: Date;
  currency: string | null;
  /** Before: the 90 days the detector judged; after: day 1 to today, at most day 28. */
  windows: { before: Window; after: Window };
  orders: readonly RollupOrder[];
  /** Ad spend per day in the store's currency, over fetched days only. */
  adSpend?: { before: { total: number; days: number }; after: { total: number; days: number } } | null;
  formOrders?: readonly FormOrderFact[];
  settingsChanges?: ReadonlyArray<{ field: string; to: unknown; at: Date }>;
  offers?: ReadonlyArray<{ type: string; enabled: boolean; name: string; updatedAt: Date }>;
  settlements?: ReadonlyArray<{ payer: string; day: string; at: Date }>;
  purchaseOrders?: ReadonlyArray<{ poNumber: string; variantIds: string[]; at: Date }>;
  followUp?: { before: Share; after: Share } | null;
};

const share = (list: readonly RollupOrder[], w: Window, pool: (o: RollupOrder) => boolean, hit: (o: RollupOrder) => boolean): Share => {
  const of = list.filter((o) => inW(o, w) && pool(o));
  return { hits: of.filter(hit).length, of: of.length };
};

export function observe(s: SignalInput): Observed | null {
  const { windows: w, orders: all, now } = s;
  const orders = s.currency ? all.filter((o) => o.currency === s.currency) : all;
  const f = s.finding ?? {};
  switch (s.detector) {
    case "courier_for_city": {
      const best = f.best as { courier?: string; via?: string } | undefined;
      if (!best?.courier) return null;
      const onRoute = (o: RollupOrder) => o.courier === best.courier && (o.fulfilledVia ?? "direct") === (best.via ?? "direct");
      const pool = (o: RollupOrder) => o.parcelCount > 0 && sameCity(o, s.subject);
      const r = shareRose(share(orders, w.before, pool, onRoute), share(orders, w.after, pool, onRoute), ROUTE_SHARE_POINTS);
      return r ? nowSignal("courier_share_up", `booked ${r.to}% of ${f.city ?? s.subject}'s parcels with ${best.courier}, up from ${r.from}%`, now, r) : null;
    }
    case "city_returns": {
      const r = shareFell(share(orders, w.before, () => true, (o) => sameCity(o, s.subject)), share(orders, w.after, () => true, (o) => sameCity(o, s.subject)), ORDER_SHARE_DROP);
      return r ? nowSignal("city_share_down", `${f.city ?? s.subject} went from ${r.from}% of orders to ${r.to}%`, now, r) : null;
    }
    case "unconfirmed_returns": {
      const r = shareRose(share(orders, w.before, () => true, (o) => !!o.confirmation), share(orders, w.after, () => true, (o) => !!o.confirmation), COVERAGE_POINTS);
      return r ? nowSignal("confirmation_up", `confirmed ${r.to}% of orders on WhatsApp, up from ${r.from}%`, now, r) : null;
    }
    case "variant_returns": {
      const r = shareFell(share(orders, w.before, () => true, (o) => hasVariant(o, s.subject)), share(orders, w.after, () => true, (o) => hasVariant(o, s.subject)), ORDER_SHARE_DROP);
      if (r) return nowSignal("variant_share_down", `the product went from ${r.from}% of orders to ${r.to}%`, now, r);
      const forms = (s.formOrders ?? []).filter((x) => x.variantIds.includes(s.subject));
      const p = shareRose(formShare(forms, w.before, (x) => x.prepaid), formShare(forms, w.after, (x) => x.prepaid), COVERAGE_POINTS);
      return p ? nowSignal("variant_prepaid_up", `${p.to}% of the product's form orders paid in advance, up from ${p.from}%`, now, p) : null;
    }
    case "product_loss": {
      const ads = s.adSpend ? perDayFell(s.adSpend.before, s.adSpend.after, SPEND_DROP) : null;
      if (ads) return nowSignal("ad_spend_down", `ad spend on the product fell to ${ads.to} a day from ${ads.from}`, now, ads);
      const days = (x: Window) => Math.round((Date.parse(`${x.to}T00:00:00Z`) - Date.parse(`${x.from}T00:00:00Z`)) / 86_400_000) + 1;
      const count = (x: Window) => orders.filter((o) => inW(o, x) && hasVariant(o, s.subject)).length;
      const stop = perDayFell({ total: count(w.before), days: days(w.before) }, { total: count(w.after), days: days(w.after) }, ORDERS_STOP);
      if (stop && days(w.after) >= 7) return nowSignal("orders_stopped", `orders for the product fell to ${stop.to} a day from ${stop.from}`, now, stop);
      const price = (x: Window) => {
        const ls = orders.filter((o) => inW(o, x)).flatMap((o) => o.lines.filter((l) => l.variantId === s.subject && l.value && l.quantity > 0));
        const q = ls.reduce((a, l) => a + l.quantity, 0);
        return q ? ls.reduce((a, l) => a + Number(l.value!.amount), 0) / q : null;
      };
      const [pb, pa] = [price(w.before), price(w.after)];
      const n = orders.filter((o) => inW(o, w.after) && hasVariant(o, s.subject)).length;
      return pb && pa && n >= MIN_AFTER_ORDERS && pa >= pb * (1 + PRICE_RISE)
        ? nowSignal("price_up", `the product's price rose to ${Math.round(pa)} from ${Math.round(pb)}`, now, { from: pb, to: pa })
        : null;
    }
    case "campaign_returns": {
      const ads = s.adSpend ? perDayFell(s.adSpend.before, s.adSpend.after, SPEND_DROP) : null;
      return ads ? nowSignal("campaign_spend_down", `spend on the flagged campaigns fell to ${ads.to} a day from ${ads.from}`, now, ads) : null;
    }
    case "returners":
    case "network_risk": {
      const on = firstAfter((s.settingsChanges ?? []).filter((c) => c.field === "otpEnabled" && c.to === true), s.actedAt);
      if (on) return { signal: "otp_on", text: "turned on OTP verification in Preventify", at: on.at.toISOString(), evidence: { field: "otpEnabled" } };
      const forms = s.formOrders ?? [];
      const v = shareRose(formShare(forms, w.before, (x) => x.verified), formShare(forms, w.after, (x) => x.verified), COVERAGE_POINTS);
      return v ? nowSignal("verification_up", `verified ${v.to}% of form orders, up from ${v.from}%`, now, v) : null;
    }
    case "offer_returns": {
      const off = firstAfter((s.offers ?? []).filter((o) => o.type === s.subject && !o.enabled).map((o) => ({ ...o, at: o.updatedAt })), s.actedAt);
      return off ? { signal: "offer_off", text: `switched off the offer "${off.name}" in Preventify`, at: off.at.toISOString(), evidence: { name: off.name, type: off.type } } : null;
    }
    case "unfollowed_checkouts":
    case "unfollowed_form_abandonments": {
      const r = s.followUp ? shareRose(s.followUp.before, s.followUp.after, COVERAGE_POINTS) : null;
      return r ? nowSignal("follow_up_up", `followed up ${r.to}% of abandoned ${s.detector === "unfollowed_checkouts" ? "checkouts" : "forms"}, up from ${r.from}%`, now, r) : null;
    }
    case "cash_held": {
      const paid = firstAfter((s.settlements ?? []).filter((x) => x.payer === s.subject), s.actedAt);
      return paid ? { signal: "payout_received", text: `${s.subject} sent a payout dated ${paid.day}`, at: paid.at.toISOString(), evidence: { day: paid.day } } : null;
    }
    case "stockout": {
      const v = (f.variantId as string | undefined) ?? s.subject;
      const po = firstAfter((s.purchaseOrders ?? []).filter((p) => p.variantIds.includes(v)), s.actedAt);
      return po ? { signal: "purchase_order", text: `created purchase order ${po.poNumber} in Inventorify`, at: po.at.toISOString(), evidence: { poNumber: po.poNumber } } : null;
    }
    default:
      // Stuck parcels: Courierify's events carry courier statuses, not the merchant's reattempt requests (app ask).
      // Deductions, returns not received, missing fees, Courierify stopped: no "did it" signal (pack §5).
      return null;
  }
}

const formShare = (list: readonly FormOrderFact[], w: Window, hit: (x: FormOrderFact) => boolean): Share => {
  const of = list.filter((x) => x.localDay >= w.from && x.localDay <= w.to);
  return { hits: of.filter(hit).length, of: of.length };
};

/** Detectors with a "did it" signal. */
export const SIGNALLED = new Set([
  "courier_for_city", "city_returns", "unconfirmed_returns", "variant_returns", "product_loss", "campaign_returns",
  "returners", "network_risk", "offer_returns", "unfollowed_checkouts", "unfollowed_form_abandonments", "cash_held", "stockout",
]);
