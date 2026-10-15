import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { bandOrders } from "../metrics/buyer-history";
import { loadAttribution } from "../metrics/campaigns.server";
import { parseFormOrder } from "../metrics/offers";
import { localDayOf } from "../metrics/order-grain";
import { loadReturnCost } from "../metrics/return-cost.server";
import { loadAdSpend, toRollupOrder } from "../metrics/rollups.server";
import type { RollupOrder } from "../metrics/rollups";
import {
  classifierFor,
  historyFromOf,
  ORDER_BASED,
  productProfit,
  productVerdict,
  tally,
  windowsOf,
  type GroupContext,
  type ProfitWindow,
} from "./groups";
import {
  AFTER_DAYS,
  CUTOFF_DAYS,
  EARLY_DAYS,
  FORMULA_VERSION,
  rateEffect,
  returnsAvoidedMoney,
  timing,
  verdictOf,
  type Verdict,
} from "./measure";
import { STATE_BASED, type StateVerdict } from "./state";
import { measureStateWatch, type StateEnv } from "./state.server";
import { claimLevel, type Observed } from "./signals";
import { observeWatch, type SignalEnv } from "./signals.server";

/**
 * The measurement engine for order-based detectors (G-GZR9-2): the worker
 * runs it at most daily per store. Each open, unjudged watch gets its
 * numbers recomputed from the order grain as it stands; once judged
 * (`judgedAt`), a watch is final.
 */

const DAY_MS = 86_400_000;
export type Watch = { id: string; detector: string; subject: string; actedAt: Date; baseline: Prisma.JsonValue; checkpoints: Prisma.JsonValue; observed?: Prisma.JsonValue };
type Checkpoint = { day: number; at?: string; decided?: number; orders?: number };

export type Measured = { watches: number; judged: number; ms: number; results: Array<{ id: string; detector: string; verdict: StateVerdict; effect: Record<string, unknown>; observed: Observed | null }> };

/**
 * `extra`: watches to measure that are not stored (the replay, G-GZR9-6);
 * `write: false` measures without saving anything.
 */
export async function measureStore(storeId: string, now = new Date(), opts: { write?: boolean; extra?: Watch[] } = {}): Promise<Measured> {
  const started = Date.now();
  const write = opts.write ?? true;
  const stored: Watch[] = await prisma.insightOutcome.findMany({
    where: { storeId, closedAt: null, judgedAt: null, detector: { in: [...ORDER_BASED, ...STATE_BASED] } },
    select: { id: true, detector: true, subject: true, actedAt: true, baseline: true, checkpoints: true, observed: true },
  });
  const watches = [...stored, ...(opts.extra ?? [])];
  const results: Measured["results"] = [];
  if (!watches.length) return { watches: 0, judged: 0, ms: Date.now() - started, results };

  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { currency: true, timezone: true } });
  const tz = store.timezone ?? "UTC";
  const currency = store.currency;
  const grain = await prisma.orderGrain.findMany({ where: { storeId } });
  const orders = grain.map(toRollupOrder);
  const historyFrom = historyFromOf(orders);
  const kinds = new Set(watches.map((w) => w.detector));
  const ctx: GroupContext | null = currency ? { currency, ...(await sideData(storeId, kinds, orders)) } : null;
  const returnCost = await loadReturnCost(storeId, currency);
  const today = localDayOf(now, tz);
  const signalEnv: SignalEnv = { storeId, currency, timezone: tz, orders, today, now, cache: {} };
  const stateEnv: StateEnv = { storeId, currency, orders, ordersById: new Map(orders.map((o) => [o.orderId, o])), today, now, cache: {} };

  let judged = 0;
  for (const w of watches) {
    const actedDay = localDayOf(w.actedAt, tz);
    if (today <= actedDay) continue;
    const win = windowsOf(actedDay, historyFrom);
    const finding = findingOf(w.baseline);
    let checkpoints = (Array.isArray(w.checkpoints) ? w.checkpoints : []) as Checkpoint[];
    let effect: Record<string, unknown>;
    let verdict: StateVerdict;
    let money: Record<string, unknown> | null = null;
    let progress = { decided: 0, orders: 0 };
    const daysSince = (now.getTime() - w.actedAt.getTime()) / DAY_MS;

    let followed = false;
    if (STATE_BASED.has(w.detector)) {
      const r = await measureStateWatch(stateEnv, w, win);
      ({ effect, verdict, money, progress } = r);
      if (r.checkpoints) {
        checkpoints = r.checkpoints as Checkpoint[];
        followed = true;
      }
    } else if (!ctx) {
      effect = { reason: "the store's currency has not been reported" };
      verdict = daysSince >= CUTOFF_DAYS ? "not_enough_data" : "too_early";
    } else if (w.detector === "product_loss") {
      const r = await measureProduct(storeId, orders, w.subject, ctx.currency, win, w.actedAt, today, now);
      ({ effect, verdict, money, progress } = r);
    } else {
      const c = classifierFor(w.detector, w.subject, finding, ctx);
      if ("reason" in c) {
        effect = { reason: c.reason };
        verdict = daysSince >= CUTOFF_DAYS ? "not_enough_data" : "too_early";
      } else {
        const t = tally(orders, c, win, now);
        const e = rateEffect(t.before, t.after);
        const tm = timing(w.actedAt, win.after.to, today, now, e.progress);
        verdict = verdictOf(e, tm);
        progress = e.progress;
        effect = { ...e, comparison: c.label, windows: win };
        if (verdict === "improved") money = returnsAvoidedMoney(e, returnCost?.perReturn ?? null);
      }
    }

    for (const day of followed ? [] : [EARLY_DAYS, AFTER_DAYS, CUTOFF_DAYS]) {
      if (daysSince >= day && !checkpoints.some((c) => c.day === day)) checkpoints.push({ day, at: now.toISOString(), ...progress });
    }
    // The "did it" signal (G-GZR9-4): looked for until seen, then kept; it sets the claim level.
    const observed = w.observed ?? (await observeWatch(signalEnv, { ...w, finding }, win));
    effect = { ...effect, claim: claimLevel(observed) };
    const final = verdict !== "too_early";
    if (final) judged += 1;
    results.push({ id: w.id, detector: w.detector, verdict, effect, observed: (observed as Observed | null) ?? null });
    if (!write || !stored.includes(w)) continue;
    await prisma.insightOutcome.update({
      where: { id: w.id },
      data: {
        effect: { ...effect, measuredAt: now.toISOString() } as Prisma.InputJsonValue,
        verdict,
        checkpoints: checkpoints as unknown as Prisma.InputJsonValue,
        money: money ? (money as Prisma.InputJsonValue) : undefined,
        formulaVersion: money ? FORMULA_VERSION : undefined,
        judgedAt: final ? now : undefined,
        observed: !w.observed && observed ? (observed as Prisma.InputJsonValue) : undefined,
      },
    });
  }
  return { watches: watches.length, judged, ms: Date.now() - started, results };
}

const findingOf = (baseline: Prisma.JsonValue): Record<string, unknown> | null => {
  const f = (baseline as { finding?: { finding?: unknown } } | null)?.finding?.finding;
  return f && typeof f === "object" ? (f as Record<string, unknown>) : null;
};

/** What only some detectors need, loaded only when a watch needs it. */
async function sideData(storeId: string, kinds: ReadonlySet<string>, orders: readonly RollupOrder[]): Promise<Omit<GroupContext, "currency">> {
  const out: Omit<GroupContext, "currency"> = {};
  if (kinds.has("returners")) {
    out.bands = bandOrders(
      orders
        .filter((o) => o.customerId && o.createdAt)
        .map((o) => ({ orderId: o.orderId, customerId: o.customerId!, createdAt: o.createdAt!, outcome: o.outcome, outcomeAt: o.outcomeTiming?.at ?? null })),
    );
  }
  if (kinds.has("network_risk")) {
    const rows = await prisma.orderNetwork.findMany({ where: { storeId, status: "ok", riskLevel: { not: null } }, select: { orderId: true, riskLevel: true } });
    out.labels = new Map(rows.map((r) => [r.orderId, r.riskLevel!]));
  }
  if (kinds.has("campaign_returns")) {
    // Each buyer's first order (merged customers count once), as I10 finds them.
    const firsts = await prisma.$queryRaw<Array<{ orderId: string }>>`
      SELECT DISTINCT ON (COALESCE(c."mergedIntoId", c.id)) g."orderId"
      FROM order_grain g JOIN customers c ON c.id = g."customerId"
      WHERE g."storeId" = ${storeId} AND g."createdAt" IS NOT NULL
      ORDER BY COALESCE(c."mergedIntoId", c.id), g."createdAt", g."orderId"`;
    const attribution = await loadAttribution(storeId, firsts.map((f) => f.orderId));
    out.firsts = new Map(firsts.map((f) => [f.orderId, attribution.get(f.orderId)?.campaignKey ?? null]));
  }
  if (kinds.has("offer_returns")) {
    const rows = await prisma.rawRecord.findMany({ where: { storeId, app: "PREVENTIFY", entity: "FORM_ORDER", deletedAt: null }, select: { payload: true } });
    out.offers = new Map(
      rows.flatMap((r) => {
        const f = parseFormOrder(r.payload);
        return f ? [[f.orderId, f.offers.map((x) => x.type as string)] as const] : [];
      }),
    );
  }
  return out;
}

/** I2: the product's profit per 30 days as delivered, before and after; needs ad spend for every day of both windows. */
async function measureProduct(
  storeId: string,
  orders: readonly RollupOrder[],
  variantId: string,
  currency: string,
  win: ReturnType<typeof windowsOf>,
  actedAt: Date,
  today: string,
  now: Date,
): Promise<{ effect: Record<string, unknown>; verdict: Verdict; money: Record<string, unknown> | null; progress: { decided: number; orders: number } }> {
  const spend = async (w: { from: string; to: string }, days: number) => {
    const ads = await loadAdSpend(storeId, w.from, w.to);
    if (ads.fetchedDays.size !== days) return null;
    return (ads.byVariant.get(variantId) ?? []).reduce((a, m) => a + (m.currency === currency ? Number(m.amount) : 0), 0);
  };
  const beforeDays = Math.round((Date.parse(`${win.before.to}T00:00:00Z`) - Date.parse(`${win.before.from}T00:00:00Z`)) / DAY_MS) + 1;
  const before = await spend(win.before, beforeDays);
  const b: ProfitWindow | null = before === null ? null : productProfit(orders, variantId, currency, win.before, beforeDays, before, now);
  const afterAds = await spend(win.after, AFTER_DAYS);
  const a: ProfitWindow | null = afterAds === null ? null : productProfit(orders, variantId, currency, win.after, AFTER_DAYS, afterAds, now);
  const progress = a ? { decided: a.decided, orders: a.orders } : { decided: 0, orders: 0 };
  const tm = timing(actedAt, win.after.to, today, now, progress);
  const effect = { metric: "profit_per_30_days", currency, before: b, after: a, windows: win, calibrated: false, ...(!b || !a ? { reason: "ad spend per product is not fetched for every day of both windows" } : {}) };
  if (!tm.judge) return { effect, verdict: "too_early", money: null, progress };
  // A product that stopped selling has nothing to settle: its after window is judged as it stands.
  const v = b && a ? productVerdict(b, a) : null;
  const verdict: Verdict = v ?? (tm.atCutoff ? "not_enough_data" : "too_early");
  const money = verdict === "improved" && b && a ? { lossReducedPer30Days: a.per30.asDelivered - b.per30.asDelivered, currency } : null;
  return { effect, verdict, money, progress };
}
