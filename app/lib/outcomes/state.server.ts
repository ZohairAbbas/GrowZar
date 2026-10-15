import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { checkoutsSection, formAbandonmentsSection } from "../metrics/checkouts.server";
import type { RollupOrder } from "../metrics/rollups";
import { loadStatements } from "../metrics/settlements.server";
import type { Statement } from "../metrics/settlements";
import { CUTOFF_DAYS, rateEffect, timing, verdictOf, type WindowTally } from "./measure";
import {
  cashFollowed,
  checkoutTally,
  deductionsOutcome,
  followChecks,
  followVerdict,
  rateTally,
  receivedFollowed,
  stockoutOutcome,
  stuckFollowed,
  type Followed,
  type StateVerdict,
} from "./state";
import { addDays, type Windows } from "./groups";
import type { Baseline } from "./watch";

/**
 * Loading and measuring a state-based watch (G-GZR9-3). What a store's
 * watches need is loaded once per run, on first use.
 */

type Parcel = Record<string, unknown>;

export type StateEnv = {
  storeId: string;
  currency: string | null;
  orders: readonly RollupOrder[];
  ordersById: ReadonlyMap<string, RollupOrder>;
  today: string;
  now: Date;
  cache: { parcels?: Map<string, Parcel[]>; statements?: Statement[] };
};

export type StateResult = {
  effect: Record<string, unknown>;
  verdict: StateVerdict;
  money: Record<string, unknown> | null;
  /** Follow-type watches recompute their checks from dates each run. */
  checkpoints?: unknown[];
  progress: { decided: number; orders: number };
};

async function parcelsByOrder(env: StateEnv): Promise<Map<string, Parcel[]>> {
  if (!env.cache.parcels) {
    const rows = await prisma.rawRecord.findMany({ where: { storeId: env.storeId, app: "COURIERIFY", entity: "PARCEL", deletedAt: null }, select: { payload: true } });
    const by = new Map<string, Parcel[]>();
    for (const r of rows) {
      const p = (r.payload ?? {}) as Parcel;
      const id = typeof p.orderId === "string" ? p.orderId : null;
      if (id) by.set(id, [...(by.get(id) ?? []), p]);
    }
    env.cache.parcels = by;
  }
  return env.cache.parcels;
}

const none = { decided: 0, orders: 0 };

export async function measureStateWatch(
  env: StateEnv,
  w: { detector: string; subject: string; actedAt: Date; baseline: Prisma.JsonValue },
  win: Windows,
): Promise<StateResult> {
  const baseline = (w.baseline ?? {}) as Partial<Baseline>;
  const daysSince = (env.now.getTime() - w.actedAt.getTime()) / 86_400_000;
  const atCutoff = daysSince >= CUTOFF_DAYS;
  const afterClosed = env.today > win.after.to;

  switch (w.detector) {
    case "cash_held":
    case "returns_not_received":
    case "stuck_parcels": {
      const items = baseline.items;
      if (!items) {
        return { effect: { reason: "the watch has no saved orders to follow (its baseline is unavailable)" }, verdict: daysSince >= 28 ? "not_enough_data" : "too_early", money: null, progress: none };
      }
      const parcels = w.detector === "stuck_parcels" ? null : await parcelsByOrder(env);
      const followed: Followed[] =
        w.detector === "cash_held"
          ? cashFollowed(items, parcels!)
          : w.detector === "returns_not_received"
            ? receivedFollowed(items, parcels!, env.ordersById, env.currency, env.now)
            : stuckFollowed(items, env.ordersById);
      const checks = followChecks(followed, w.actedAt, env.now, env.currency);
      const verdict = followVerdict(checks, items.length);
      const last = checks.at(-1);
      const resolvedNow = followed.filter((f) => f.resolvedAt).length;
      // Measured, not estimated: what was paid, or the cost of what came back. Stuck parcels carry none in v1.
      const money =
        last && last.amount !== null && w.detector !== "stuck_parcels"
          ? { measured: true, amount: last.amount, currency: env.currency, asOfDay: last.day, what: w.detector === "cash_held" ? "cod_paid" : "product_cost_received" }
          : null;
      return {
        effect: { metric: w.detector === "cash_held" ? "share_paid" : w.detector === "returns_not_received" ? "share_received" : "share_moved", items: items.length, resolvedNow, calibrated: false },
        verdict,
        money: verdict === "too_early" ? null : money,
        checkpoints: checks,
        progress: { decided: resolvedNow, orders: items.length },
      };
    }

    case "missing_courier_fees":
    case "courierify_stopped": {
      const t = rateTally(w.detector, env.orders, win, env.now);
      return rateResult(t, w.detector === "missing_courier_fees" ? "share_missing_fee" : "share_outside_courierify", w.actedAt, win, env);
    }

    case "unfollowed_checkouts":
    case "unfollowed_form_abandonments": {
      const section = w.detector === "unfollowed_checkouts" ? checkoutsSection : formAbandonmentsSection;
      const [b, a] = await Promise.all([section(env.storeId, win.before, env.now), section(env.storeId, win.after, env.now)]);
      const t = { before: { subject: checkoutTally(b), rest: null }, after: { subject: checkoutTally(a), rest: null } };
      return rateResult(t, "share_not_followed_up", w.actedAt, win, env);
    }

    case "courier_deductions": {
      if (!env.currency) return { effect: { reason: "the store's currency has not been reported" }, verdict: atCutoff ? "not_enough_data" : "too_early", money: null, progress: none };
      env.cache.statements ??= await loadStatements(env.storeId);
      // Statements dated from the day after acting up to the cut-off.
      const after = { from: win.after.from, to: addDays(win.after.from, CUTOFF_DAYS - 2) };
      const r = deductionsOutcome(env.cache.statements, w.subject, after, env.currency, atCutoff);
      return {
        effect: { metric: "unitemized_share", before: (baseline.finding?.finding as { unitemizedShare?: number } | undefined)?.unitemizedShare ?? null, after: r.unitemizedShare, statements: r.row?.statements ?? 0, window: after, calibrated: false },
        verdict: r.verdict,
        money: null,
        progress: { decided: r.row?.statements ?? 0, orders: r.row?.statements ?? 0 },
      };
    }

    case "stockout": {
      const f = baseline.finding?.finding as { variantId?: string; shortDays?: number } | undefined;
      const variantId = f?.variantId ?? w.subject;
      const rows = await prisma.$queryRaw<Array<{ day: string; stock: number }>>`
        SELECT payload->>'date' AS day, (payload->>'stock')::float AS stock FROM raw_records
        WHERE "storeId" = ${env.storeId} AND app = 'INVENTORIFY' AND entity = 'STOCK_SNAPSHOT' AND "deletedAt" IS NULL
          AND payload->>'variantId' = ${variantId} AND payload->>'date' >= ${win.after.from} AND payload->>'date' <= ${win.after.to}`;
      const r = stockoutOutcome(rows, win.after, typeof f?.shortDays === "number" ? f.shortDays : null, afterClosed);
      return { effect: { metric: "days_out_of_stock", ...r, calibrated: false }, verdict: r.verdict, money: null, progress: { decided: r.daysSeen, orders: 28 } };
    }

    default:
      return { effect: { reason: `${w.detector} is not state-based` }, verdict: "not_enough_data", money: null, progress: none };
  }
}

function rateResult(t: { before: WindowTally; after: WindowTally }, metric: string, actedAt: Date, win: Windows, env: StateEnv): StateResult {
  const e = rateEffect(t.before, t.after, metric);
  const tm = timing(actedAt, win.after.to, env.today, env.now, e.progress);
  return { effect: { ...e, comparison: "the store's own earlier rate", windows: win }, verdict: verdictOf(e, tm), money: null, progress: e.progress };
}
