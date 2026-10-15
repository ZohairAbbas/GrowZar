/**
 * The outcome measurement (G-GZR9-2): what changed after someone acted on an
 * insight, judged by settle-or-bound (phase-g9 pack §10.10). Pure.
 *
 * Every order-based detector is measured as a return rate: a subject group
 * (the city, the variant, the flagged buyers…) before and after, against a
 * comparison group over the same windows (difference in differences), or
 * against its own earlier rate where the pack says so. Fewer returns is
 * better; I1's delivery rate is the same number seen from the other side.
 *
 * Orders still open when the watch is judged are counted both ways, all
 * delivered and all returned, and a verdict needs both extremes to agree.
 */

/** Before: the 90 days the detector judged. After: orders placed on days 1–28 after acting. */
export const BEFORE_DAYS = 90;
export const AFTER_DAYS = 28;
/** Judged once this share of the subject's after-window orders is decided… */
export const SETTLED_SHARE = 0.95;
/** …or this many days after acting, whichever is first. */
export const CUTOFF_DAYS = 60;
/** The progress-only check. */
export const EARLY_DAYS = 14;
/** The gate: decided orders on each side, and |z| (as I5, I9, I10). */
export const MIN_DECIDED = 30;
export const MIN_Z = 1.96;
/**
 * Open orders past these ages are not waiting for an outcome any more: an
 * order unshipped after two weeks will not ship, and a parcel booked or in
 * transit for 45 days has lost its tracking (hundreds such on the pilot
 * stores). They are left out on both sides, like cancelled orders.
 */
export const STALE_UNSHIPPED_DAYS = 14;
export const STALE_OPEN_DAYS = 45;

export type Side = "subject" | "rest";
/** `stale`: open orders past STALE_*_DAYS, left out but counted so the card can say so. */
export type Tally = { delivered: number; returned: number; open: number; stale: number };
export type WindowTally = { subject: Tally; rest: Tally | null };

const DAY_MS = 86_400_000;
export const emptyTally = (): Tally => ({ delivered: 0, returned: 0, open: 0, stale: 0 });
export const decidedOf = (t: Tally) => t.delivered + t.returned;

/** How an order counts at `asOf`: decided, still open, or left out. */
export function stateOf(o: { outcome: string; createdAt: Date | null }, asOf: Date): "delivered" | "returned" | "open" | "stale" | null {
  if (o.outcome === "delivered" || o.outcome === "returned") return o.outcome;
  const age = o.createdAt ? (asOf.getTime() - o.createdAt.getTime()) / DAY_MS : Infinity;
  if (o.outcome === "not_shipped") return age <= STALE_UNSHIPPED_DAYS ? "open" : null;
  if (o.outcome === "booked" || o.outcome === "in_transit" || o.outcome === "unknown") return age <= STALE_OPEN_DAYS ? "open" : "stale";
  // Cancelled, and partially delivered (neither a delivery nor a return).
  return null;
}

export function add(t: Tally, state: "delivered" | "returned" | "open" | "stale") {
  t[state] += 1;
}

type Rate = { returned: number; decided: number };
const asReturned = (t: Tally): Rate => ({ returned: t.returned + t.open, decided: decidedOf(t) + t.open });
const asDelivered = (t: Tally): Rate => ({ returned: t.returned, decided: decidedOf(t) + t.open });
const central = (t: Tally): Rate => ({ returned: t.returned, decided: decidedOf(t) });

const p = (r: Rate) => (r.decided ? r.returned / r.decided : 0);
const variance = (r: Rate) => (r.decided ? (p(r) * (1 - p(r))) / r.decided : 0);

export type Scenario = { effect: number; se: number; z: number };

function scenario(sb: Rate, sa: Rate, rb: Rate | null, ra: Rate | null): Scenario {
  const effect = p(sa) - p(sb) - (rb && ra ? p(ra) - p(rb) : 0);
  const se = Math.sqrt(variance(sa) + variance(sb) + (rb && ra ? variance(ra) + variance(rb) : 0));
  return { effect, se, z: se ? effect / se : 0 };
}

export type Verdict = "too_early" | "improved" | "no_change" | "worse" | "not_enough_data";

export type RateEffect = {
  metric: "return_rate";
  /** Percent, one decimal, decided orders only: what the card line shows. */
  before: { subject: number | null; rest: number | null };
  after: { subject: number | null; rest: number | null };
  tallies: { before: WindowTally; after: WindowTally };
  /** Change in the subject's return rate beyond the comparison's, in points (negative: fewer returns). */
  effectPoints: number;
  /** 95% interval of that, in points. */
  interval: [number, number];
  z: number;
  /** The extremes: open orders all returned against the claim, and all for it. */
  pessimistic: Scenario;
  optimistic: Scenario;
  /** Subject's after-window orders decided, of those that count. */
  progress: { decided: number; orders: number };
  /** False until G-GZR9-6 measures how much un-clicked findings move on their own (pack §10.2). */
  calibrated: false;
};

const pct1 = (r: Rate) => (r.decided ? Math.round((1000 * r.returned) / r.decided) / 10 : null);
const pts = (x: number) => Math.round(x * 1000) / 10;

/** The numbers, whether or not it is time to judge. */
export function rateEffect(before: WindowTally, after: WindowTally): RateEffect {
  const cmp = !!(before.rest && after.rest);
  // Against the claim of fewer returns: the subject's after-orders return, its before-orders deliver; the comparison the other way.
  const pess = scenario(asDelivered(before.subject), asReturned(after.subject), cmp ? asReturned(before.rest!) : null, cmp ? asDelivered(after.rest!) : null);
  const opt = scenario(asReturned(before.subject), asDelivered(after.subject), cmp ? asDelivered(before.rest!) : null, cmp ? asReturned(after.rest!) : null);
  const mid = scenario(central(before.subject), central(after.subject), cmp ? central(before.rest!) : null, cmp ? central(after.rest!) : null);
  return {
    metric: "return_rate",
    before: { subject: pct1(central(before.subject)), rest: before.rest ? pct1(central(before.rest)) : null },
    after: { subject: pct1(central(after.subject)), rest: after.rest ? pct1(central(after.rest)) : null },
    tallies: { before, after },
    effectPoints: pts(mid.effect),
    interval: [pts(mid.effect - MIN_Z * mid.se), pts(mid.effect + MIN_Z * mid.se)],
    z: Math.round(mid.z * 100) / 100,
    pessimistic: pess,
    optimistic: opt,
    progress: { decided: decidedOf(after.subject), orders: decidedOf(after.subject) + after.subject.open },
    calibrated: false,
  };
}

/** Whether the gate's sample is there: 30 decided on each side, both windows. */
export function gatePasses(e: Pick<RateEffect, "tallies">): boolean {
  const { before, after } = e.tallies;
  const ok = (t: Tally | null) => !t || decidedOf(t) >= MIN_DECIDED;
  return decidedOf(before.subject) >= MIN_DECIDED && decidedOf(after.subject) >= MIN_DECIDED && ok(before.rest) && ok(after.rest);
}

/** Settle-or-bound: improved, worse or no change only when both extremes say so. */
export function boundVerdict(e: RateEffect): Verdict | null {
  if (!gatePasses(e)) return null;
  if (e.pessimistic.z <= -MIN_Z) return "improved";
  if (e.optimistic.z >= MIN_Z) return "worse";
  if (Math.abs(e.pessimistic.z) < MIN_Z && Math.abs(e.optimistic.z) < MIN_Z) return "no_change";
  return null;
}

export type Timing = { judge: boolean; atCutoff: boolean; afterClosed: boolean; daysSince: number };

/**
 * Where a watch stands at `now`: the after window must be over (its last day
 * has passed, store-local), then it is judged once settled or at the cut-off.
 */
export function timing(actedAt: Date, afterLastDay: string, today: string, now: Date, progress: { decided: number; orders: number }): Timing {
  const daysSince = (now.getTime() - actedAt.getTime()) / DAY_MS;
  const afterClosed = today > afterLastDay;
  const atCutoff = daysSince >= CUTOFF_DAYS;
  const settled = progress.orders > 0 && progress.decided / progress.orders >= SETTLED_SHARE;
  return { judge: afterClosed && (settled || atCutoff), atCutoff, afterClosed, daysSince };
}

/** The verdict at `timing`: an undecided judgment is too early before the cut-off and not enough data at it. */
export function verdictOf(e: RateEffect, t: Timing): Verdict {
  if (!t.judge) return "too_early";
  const v = boundVerdict(e);
  if (v) return v;
  return t.atCutoff ? "not_enough_data" : "too_early";
}

// ── Money (computed and stored; shown only once approved, D-38) ─────────────

export const FORMULA_VERSION = 1;

/**
 * Returns avoided per 30 days × the store's measured courier charge on a
 * return, on the conservative end: the smaller improvement of the 95%
 * interval's edge and the pessimistic extreme. Only for an improvement.
 */
export function returnsAvoidedMoney(
  e: RateEffect,
  perReturn: { amount: string; currency: string } | null,
): { returnsPer30Days: number; perReturn: { amount: string; currency: string } | null; amountPer30Days: number | null; currency: string | null } | null {
  const fewer = Math.min(-e.interval[1] / 100, -e.pessimistic.effect);
  if (fewer <= 0) return null;
  const ordersPer30 = ((decidedOf(e.tallies.after.subject) + e.tallies.after.subject.open) * 30) / AFTER_DAYS;
  const returnsPer30Days = Math.round(fewer * ordersPer30 * 10) / 10;
  const amount = perReturn ? Math.round(returnsPer30Days * Number(perReturn.amount)) : null;
  return { returnsPer30Days, perReturn, amountPer30Days: amount, currency: perReturn?.currency ?? null };
}
