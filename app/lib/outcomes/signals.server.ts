import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { checkoutsSection, formAbandonmentsSection } from "../metrics/checkouts.server";
import { localDayOf } from "../metrics/order-grain";
import { loadAdSpend } from "../metrics/rollups.server";
import { attributable } from "../metrics/settlements";
import type { RollupOrder } from "../metrics/rollups";
import { addDays, type Windows } from "./groups";
import { observe, SIGNALLED, type FormOrderFact, type Observed, type SignalInput } from "./signals";

/**
 * Loading what a watch's "did it" signal reads (G-GZR9-4). Per store and
 * run, each source is read once, on first use.
 */

export type SignalEnv = {
  storeId: string;
  currency: string | null;
  timezone: string;
  orders: readonly RollupOrder[];
  today: string;
  now: Date;
  cache: Partial<{
    formOrders: FormOrderFact[];
    settingsChanges: SignalInput["settingsChanges"];
    offers: SignalInput["offers"];
    settlements: SignalInput["settlements"];
    purchaseOrders: SignalInput["purchaseOrders"];
  }>;
};

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const when = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

async function payloads(storeId: string, app: "PREVENTIFY" | "COURIERIFY" | "INVENTORIFY", entity: Prisma.RawRecordWhereInput["entity"]) {
  const rows = await prisma.rawRecord.findMany({ where: { storeId, app, entity, deletedAt: null }, select: { payload: true } });
  return rows.map((r) => obj(r.payload));
}

/** Ad spend per day over fetched days only: a day not fetched is unknown, not zero. */
async function spendPerDay(storeId: string, currency: string | null, w: { from: string; to: string }, pick: { variant?: string; campaigns?: readonly string[] }) {
  if (!currency) return null;
  if (pick.variant) {
    const ads = await loadAdSpend(storeId, w.from, w.to);
    const total = (ads.byVariant.get(pick.variant) ?? []).reduce((a, m) => a + (m.currency === currency ? Number(m.amount) : 0), 0);
    return { total, days: ads.fetchedDays.size };
  }
  const keys = [...(pick.campaigns ?? [])];
  if (!keys.length) return null;
  const [spend, fetched] = await Promise.all([
    prisma.adSpend.findMany({ where: { storeId, level: "campaign", key: { in: keys }, currency, day: { gte: w.from, lte: w.to } }, select: { spendAmount: true } }),
    prisma.adSpend.count({ where: { storeId, level: "day", day: { gte: w.from, lte: w.to } } }),
  ]);
  return { total: spend.reduce((a, r) => a + Number(r.spendAmount), 0), days: fetched };
}

/** The watch's signal if it shows yet, else null. Only detectors with a signal (pack §5) are read. */
export async function observeWatch(
  env: SignalEnv,
  w: { detector: string; subject: string; actedAt: Date; finding: Record<string, unknown> | null },
  win: Windows,
): Promise<Observed | null> {
  if (!SIGNALLED.has(w.detector)) return null;
  // After: from the day after acting to yesterday, at most day 28.
  const yesterday = addDays(env.today, -1);
  const after = { from: win.after.from, to: yesterday < win.after.to ? yesterday : win.after.to };
  if (after.to < after.from) return null;
  const input: SignalInput = {
    detector: w.detector,
    subject: w.subject,
    finding: w.finding,
    actedAt: w.actedAt,
    now: env.now,
    currency: env.currency,
    windows: { before: win.before, after },
    orders: env.orders,
  };
  const c = env.cache;
  switch (w.detector) {
    case "product_loss":
    case "campaign_returns": {
      const pick = w.detector === "product_loss" ? { variant: w.subject } : { campaigns: ((w.finding?.flagged as Array<{ key: string }> | undefined) ?? []).map((x) => x.key) };
      const [b, a] = await Promise.all([spendPerDay(env.storeId, env.currency, win.before, pick), spendPerDay(env.storeId, env.currency, after, pick)]);
      input.adSpend = b && a ? { before: b, after: a } : null;
      break;
    }
    case "variant_returns":
    case "returners":
    case "network_risk":
      c.formOrders ??= (await payloads(env.storeId, "PREVENTIFY", "FORM_ORDER")).flatMap((p) => {
        const at = when(p.createdAt);
        if (!at) return [];
        const lines = Array.isArray(p.lines) ? (p.lines as unknown[]).map(obj) : [];
        const method = typeof p.verificationMethod === "string" ? p.verificationMethod : null;
        return [{
          localDay: localDayOf(at, env.timezone),
          variantIds: lines.map((l) => String(l.variantId ?? "")).filter(Boolean),
          prepaid: typeof p.paymentMethod === "string" && p.paymentMethod !== "cod",
          verified: !!method && method !== "verification_skipped",
        }];
      });
      input.formOrders = c.formOrders;
      if (w.detector !== "variant_returns") {
        c.settingsChanges ??= (await payloads(env.storeId, "PREVENTIFY", "FORM_SETTINGS_CHANGE")).flatMap((p) => {
          const at = when(p.changedAt);
          // "baseline" rows record the settings as first seen, not a change someone made.
          return at && p.source !== "baseline" ? [{ field: String(p.field ?? ""), to: p.to, at }] : [];
        });
        input.settingsChanges = c.settingsChanges;
      }
      break;
    case "offer_returns":
      c.offers ??= (await payloads(env.storeId, "PREVENTIFY", "OFFER")).flatMap((p) => {
        const at = when(p.updatedAt);
        return at ? [{ type: String(p.type ?? ""), enabled: p.enabled !== false, name: String(p.name ?? "Offer"), updatedAt: at }] : [];
      });
      input.offers = c.offers;
      break;
    case "unfollowed_checkouts":
    case "unfollowed_form_abandonments": {
      const section = w.detector === "unfollowed_checkouts" ? checkoutsSection : formAbandonmentsSection;
      const [b, a] = await Promise.all([section(env.storeId, win.before, env.now), section(env.storeId, after, env.now)]);
      const share = (v: Awaited<ReturnType<typeof section>>) => ({ hits: v?.followedUp ?? 0, of: (v?.followedUp ?? 0) + (v?.notFollowedUp ?? 0) });
      input.followUp = { before: share(b), after: share(a) };
      break;
    }
    case "cash_held":
      c.settlements ??= (await payloads(env.storeId, "COURIERIFY", "SETTLEMENT")).flatMap((p) => {
        const at = when(p.settlementDate);
        // A payout, as settlements.ts reads them (no direction means a payout).
        return at && (p.direction === undefined || p.direction === "payout") && attributable(p) ? [{ payer: String(p.courier ?? "").toLowerCase(), day: String(p.settlementDate).slice(0, 10), at }] : [];
      });
      input.settlements = c.settlements;
      break;
    case "stockout":
      c.purchaseOrders ??= (await payloads(env.storeId, "INVENTORIFY", "PURCHASE_ORDER")).flatMap((p) => {
        const at = when(p.createdAt);
        const items = Array.isArray(p.items) ? (p.items as unknown[]).map(obj) : [];
        return at ? [{ poNumber: String(p.poNumber ?? ""), variantIds: items.map((i) => String(i.variantId ?? "")), at }] : [];
      });
      input.purchaseOrders = c.purchaseOrders;
      break;
  }
  return observe(input);
}
