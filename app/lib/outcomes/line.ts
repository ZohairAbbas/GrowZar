/**
 * What an outcome says on screen (G-GZR9-5, pack §13): one sentence per
 * watch, the same on the card, the insight's page, Results and the digest.
 * Pure.
 *
 * Count-only until a detector passes the placebo check (pack §10.2): the
 * numbers and what was seen, never "improved" or "worse", and no money
 * except what was measured and approved (I4: COD paid since).
 */
import { localDayOf } from "../metrics/order-grain";
import { PLACEBO } from "./watch";

/** Detectors whose money is shown (D-38, approved 2026-10-15): measured amounts only. */
export const OUTCOME_MONEY_APPROVED: ReadonlySet<string> = new Set(["cash_held"]);

export type WatchRow = {
  id: string;
  insightId: string;
  detector: string;
  subject: string;
  trigger: string;
  actedAt: Date;
  internal: boolean;
  baseline: unknown;
  effect: unknown;
  verdict: string;
  observed: unknown;
  checkpoints: unknown;
  judgedAt: Date | null;
  closedAt: Date | null;
  closedReason: string | null;
  hiddenAt: Date | null;
};

export type OutcomeLine = {
  watchId: string;
  insightId: string;
  detector: string;
  /** watching: still measuring; measured: final numbers; closed: marked wrong; hidden: "this wasn't us". */
  status: "watching" | "measured" | "closed" | "hidden";
  /** The store-local day it was opened or clicked, e.g. "20 Oct". */
  since: string;
  text: string;
  /** The "did it" signal, when one was seen (claim level "changed"). */
  signal: string | null;
  /** A measured, approved amount for a viewer who may see money, e.g. "PKR 412,000 paid". */
  money: string | null;
  /** The same amount as a number, for Results' totals. */
  moneyValue: { amount: number; currency: string } | null;
  internal: boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-20" → "20 Oct". */
export const dayLabel = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const n = (x: number) => x.toLocaleString("en-GB");
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const pct = (x: number | null | undefined) => (typeof x === "number" ? `${Math.round(x * 10) / 10}%` : "—");

/** What the rate is about, the comparison's name, and whether the rate is shown the other way round (I1: delivery rate). */
function rateWords(detector: string, subject: string, finding: Obj): { what: string; rest: string; invert?: boolean } {
  const city = typeof finding.city === "string" ? finding.city : cap(subject);
  switch (detector) {
    case "courier_for_city":
      return { what: `${city}'s delivery rate`, rest: "the store's other cities", invert: true };
    case "city_returns":
      return { what: `${city}'s return rate`, rest: "the rest of the store" };
    case "variant_returns": {
      const v = (Array.isArray(finding.flagged) ? finding.flagged : []).find((x: Obj) => x.variantId === subject);
      return { what: `the return rate of ${v?.title ?? "this product"}`, rest: "the rest of the store" };
    }
    case "unconfirmed_returns":
      return { what: "the store's return rate", rest: "" };
    case "returners":
      return { what: "the return rate of buyers who returned before", rest: "everyone else" };
    case "network_risk":
      return { what: "the return rate of buyers Courierify rated high risk", rest: "other rated buyers" };
    case "campaign_returns":
      return { what: "the first-order return rate of the flagged campaigns", rest: "other new buyers" };
    case "offer_returns":
      return { what: `the return rate of orders that took the ${subject.replace(/_/g, " ")} offer`, rest: "orders with no offer" };
    case "missing_courier_fees":
      return { what: "the share of Courierify parcels with no courier fee", rest: "" };
    case "courierify_stopped":
      return { what: "the share of shipped orders booked outside Courierify", rest: "" };
    case "unfollowed_checkouts":
      return { what: "the share of abandoned checkouts nobody followed up", rest: "" };
    case "unfollowed_form_abandonments":
      return { what: "the share of abandoned COD forms nobody followed up", rest: "" };
    default:
      return { what: "the measured rate", rest: "the rest of the store" };
  }
}

/** What a rate detector's progress counts. */
const UNITS: Record<string, string> = {
  unfollowed_checkouts: "abandoned checkouts",
  unfollowed_form_abandonments: "abandoned forms",
  missing_courier_fees: "parcels",
  courierify_stopped: "shipped orders",
};

const FOLLOWED: Record<string, { items: string; done: string }> = {
  cash_held: { items: "owed orders", done: "paid" },
  returns_not_received: { items: "returns not confirmed back", done: "received back" },
  stuck_parcels: { items: "stuck parcels", done: "delivered or returned" },
};

/** One watch as a sentence for a viewer; null for a placebo, which is never shown. */
export function outcomeLine(w: WatchRow, opts: { timezone: string; canSeeMoney: boolean; currency: string | null }): OutcomeLine | null {
  if (w.trigger === PLACEBO) return null;
  const since = dayLabel(localDayOf(w.actedAt, opts.timezone));
  const e = obj(w.effect);
  const finding = obj(obj(obj(w.baseline).finding).finding);
  const observed = obj(w.observed);
  const signal = typeof observed.text === "string" ? observed.text : null;
  const base = {
    watchId: w.id,
    insightId: w.insightId,
    detector: w.detector,
    since,
    signal,
    money: null as string | null,
    moneyValue: null as OutcomeLine["moneyValue"],
    internal: w.internal,
  };

  if (w.hiddenAt) return { ...base, status: "hidden", text: `Marked "this wasn't us". Not counted in results.` };
  if (w.closedAt) return { ...base, status: "closed", text: `Marked wrong after you looked at it on ${since}, so it is not measured.` };

  const followed = FOLLOWED[w.detector];
  const checks = Array.isArray(w.checkpoints) ? (w.checkpoints as Obj[]) : [];
  const last = checks.at(-1);
  // Money: measured and approved only, and only for a viewer who may see Finance.
  if (followed && OUTCOME_MONEY_APPROVED.has(w.detector) && opts.canSeeMoney && last?.amount && Number(last.amount) > 0 && opts.currency) {
    base.money = `${opts.currency} ${n(Math.round(Number(last.amount)))} ${followed.done}`;
    // D-93: how much of it the bank shows, from Books' matched statements.
    if (typeof last.inBankAmount === "string") base.money += `, ${opts.currency} ${n(Math.round(Number(last.inBankAmount)))} of it seen in the bank`;
    base.moneyValue = { amount: Number(last.amount), currency: opts.currency };
  }

  const final = !!w.judgedAt && w.verdict !== "too_early";
  if (!final) {
    // What the store changed shows as soon as it is seen, before any numbers are final.
    const seen = signal ? ` · seen since: ${signal}` : "";
    if (typeof e.reason === "string" && !e.progress && !e.items) {
      return { ...base, status: "watching", text: `Opened ${since}. It can't be measured: ${e.reason}.${signal ? ` Seen since: ${signal}.` : ""}` };
    }
    if (followed && typeof e.items === "number") {
      return { ...base, status: "watching", text: `Watching since ${since} · ${n(e.resolvedNow ?? 0)} of ${n(e.items)} ${followed.items} ${followed.done} so far${seen}` };
    }
    const p = obj(e.progress);
    const counts = typeof p.orders === "number" && p.orders > 0 && w.detector !== "stockout" && w.detector !== "courier_deductions"
      ? ` · ${n(p.decided)} of ${n(p.orders)} ${UNITS[w.detector] ?? "orders"} decided so far`
      : "";
    return { ...base, status: "watching", text: `Watching since ${since}${counts}${seen}` };
  }

  const lead = signal ? `After you opened this on ${since}: ${signal}. Since then, ` : `Since you looked at this on ${since}, `;
  if (w.verdict === "not_enough_data") {
    const decided = obj(e.progress).decided;
    const unit = UNITS[w.detector] ?? "orders";
    return { ...base, status: "measured", text: `${lead}there were too few ${unit} to measure${typeof decided === "number" ? ` (${n(decided)} decided)` : ""}.` };
  }
  if (followed) {
    const c28 = checks.find((c) => c.day === 28) ?? last ?? {};
    return { ...base, status: "measured", text: `${lead}${n(c28.resolved ?? 0)} of the ${n(c28.total ?? 0)} ${followed.items} were ${followed.done} within 28 days.` };
  }
  if (w.detector === "stockout") {
    return { ...base, status: "measured", text: `${lead}it was out of stock on ${n(e.daysOut ?? 0)} of the next 28 days${typeof e.forecastShortDays === "number" ? ` (the card expected ${n(e.forecastShortDays)})` : ""}.` };
  }
  if (w.detector === "courier_deductions") {
    return { ...base, status: "measured", text: `${lead}${cap(w.subject)}'s statements leave ${pct(e.after)} of COD unexplained, against ${pct(e.before)} before.` };
  }
  if (w.detector === "product_loss") {
    const a = obj(e.after);
    const b = obj(e.before);
    const perDay = (x: Obj) => (typeof x.orders === "number" && typeof x.days === "number" && x.days ? x.orders / x.days : null);
    const pb = perDay(b);
    const pa = perDay(a);
    return {
      ...base,
      status: "measured",
      text: `${lead}the product sold ${pa !== null ? (Math.round(pa * 10) / 10).toLocaleString("en-GB") : "—"} orders a day, against ${pb !== null ? (Math.round(pb * 10) / 10).toLocaleString("en-GB") : "—"} before.`,
    };
  }
  // A rate, before → after, against its comparison where it has one.
  const words = rateWords(w.detector, w.subject, finding);
  const flip = (x: unknown) => (typeof x === "number" ? (words.invert ? 100 - x : x) : null);
  const before = obj(e.before);
  const after = obj(e.after);
  const decided = obj(obj(obj(e.tallies).after).subject);
  const across = typeof decided.delivered === "number" ? decided.delivered + decided.returned : null;
  const rest = words.rest && typeof before.rest === "number" ? ` (${words.rest}: ${pct(flip(before.rest))} → ${pct(flip(after.rest))})` : "";
  return {
    ...base,
    status: "measured",
    text: `${lead}${words.what} went from ${pct(flip(before.subject))} to ${pct(flip(after.subject))}${rest}${across !== null ? `, across ${n(across)} ${UNITS[w.detector] ?? "orders"}` : ""}.`,
  };
}

/** Results' counts: real watches only, never internal ones (pack §10.1) or hidden ones (§10.8). */
export function resultCounts(lines: readonly OutcomeLine[]) {
  const counted = lines.filter((l) => !l.internal && l.status !== "hidden" && l.status !== "closed");
  return {
    watched: counted.length,
    measured: counted.filter((l) => l.status === "measured").length,
    watching: counted.filter((l) => l.status === "watching").length,
    changed: counted.filter((l) => l.signal).length,
    hidden: lines.filter((l) => !l.internal && l.status === "hidden").length,
  };
}
