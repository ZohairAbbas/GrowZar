import { prisma } from "../db.server";
import type { App } from "../insights/detectors";
import type { FindingsInput } from "../metrics/findings";
import { parseAmount, readMoney, sumByCurrency, type Money } from "../metrics/money";
import { localDayOf } from "../metrics/order-grain";
import { bucketOf, profitAfterReturns, type RollupOrder } from "../metrics/rollups";
import { loadAdSpend, toRollupOrder } from "../metrics/rollups.server";
import { payerHistories, readPayout } from "../metrics/settlements";

/**
 * The detectors' input as it would have read at a past moment `T`, rebuilt
 * from order history (Phase 9: the watch backfill, G-GZR9-1, and the replay,
 * G-GZR9-6). The method is G-GZR3-9's backtest (scripts/backtest-insights.ts):
 *
 * - orders placed in the `lookback` local days before T;
 * - an outcome counts as known at T if the courier (or 3PL) timed it before
 *   T, or the order was placed KNOWN_AFTER_DAYS before T; otherwise the
 *   order reads as still in transit. When an outcome became known is not
 *   recorded, so this is an approximation, and a baseline built from it is
 *   marked `reconstructed`;
 * - payouts dated before T, and a parcel's COD as owed unless it was settled
 *   before T.
 *
 * Only what Courierify and Financify feed is rebuilt. Detectors that read
 * other apps' current state (stock, checkouts, offers, buyer contact, the
 * buyer network) are not run: their past state is not kept.
 */

const DAY_MS = 86_400_000;
const DECIDED = new Set(["delivered", "returned", "partially_delivered"]);
/** Courier-timed deliveries take a median of 6 days and returns 10 on the pilot store (G-GZR3-9). */
export const KNOWN_AFTER_DAYS = 14;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function outcomeKnownAt(o: RollupOrder, T: Date): boolean {
  return (
    ((o.outcomeTiming?.basis === "happened_on" || o.outcomeTiming?.basis === "reported_by_3pl") && o.outcomeTiming.at <= T) ||
    (!!o.createdAt && T.getTime() - o.createdAt.getTime() >= KNOWN_AFTER_DAYS * DAY_MS)
  );
}

export function knownAt(o: RollupOrder, T: Date): RollupOrder {
  if (DECIDED.has(o.outcome) && !outcomeKnownAt(o, T)) {
    return { ...o, outcome: "in_transit", delivered: null, collected: null, uncollected: null, financifyOutcome: null };
  }
  return o;
}

/** Apps whose past the rebuild covers. */
export const REBUILT_APPS: ReadonlySet<App> = new Set<App>(["COURIERIFY", "FINANCIFY"]);

export async function inputAsOf(
  storeId: string,
  T: Date,
  lookback: number,
): Promise<{ input: FindingsInput; connected: Set<App>; period: { from: string; to: string } }> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { currency: true, timezone: true, connections: { where: { status: "CONNECTED" }, select: { app: true } } },
  });
  const currency = store.currency;
  const asOfDay = localDayOf(T, store.timezone ?? "UTC");
  const from = addDays(asOfDay, -lookback);
  const to = addDays(asOfDay, -1);

  const grain = await prisma.orderGrain.findMany({ where: { storeId } });
  const all = grain.map(toRollupOrder);
  const rows = all.filter((o) => o.localDay && o.localDay >= from && o.localDay <= to).map((o) => knownAt(o, T));

  const ads = await loadAdSpend(storeId, from, to);
  const adFees = (
    await prisma.adSpend.findMany({ where: { storeId, level: "day", day: { gte: from, lte: to } }, select: { feesAmount: true, currency: true } })
  ).map((r) => ({ amount: r.feesAmount.toFixed(6), currency: r.currency }));
  const adsComplete = ads.fetchedDays.size === lookback;
  const spendWithFees = adsComplete ? sumByCurrency([...ads.total, ...adFees]) : null;
  const orders = bucketOf("as-of", rows);

  // Payouts dated before T, and each delivered parcel's COD as owed at T.
  const raw = await prisma.rawRecord.findMany({
    where: { storeId, app: "COURIERIFY", entity: { in: ["SETTLEMENT", "PARCEL"] }, deletedAt: null },
    select: { entity: true, payload: true },
  });
  const payouts = raw
    .filter((r) => r.entity === "SETTLEMENT")
    .map((r) => readPayout(obj(r.payload)))
    .filter((p): p is NonNullable<typeof p> => p !== null && p.day < asOfDay);
  const unpaid = new Map<string, Money[]>();
  for (const r of raw) {
    if (r.entity !== "PARCEL") continue;
    const p = obj(r.payload);
    const s = obj(p.settlement);
    const cod = readMoney(p.cod);
    if (p.status !== "delivered" || !cod || parseAmount(cod.amount)! <= 0n) continue;
    const settledAt = s.settled === true ? (typeof s.settledAt === "string" ? new Date(s.settledAt) : new Date(0)) : null;
    if (settledAt && settledAt <= T) continue;
    const id = String(p.orderId ?? "");
    unpaid.set(id, [...(unpaid.get(id) ?? []), cod]);
  }
  const awaiting = all
    .filter((o) => o.parcelCount > 0 && o.outcome === "delivered" && outcomeKnownAt(o, T) && unpaid.has(o.orderId))
    .map((o) => ({ ...o, uncollected: sumByCurrency(unpaid.get(o.orderId)!)[0] ?? null }));

  const lastParcelDay = all.filter((o) => o.parcelCount > 0 && o.localDay && o.localDay < asOfDay).map((o) => o.localDay!).sort().at(-1) ?? null;
  const connected = new Set(store.connections.map((c) => c.app as App).filter((a) => REBUILT_APPS.has(a)));

  return {
    connected,
    period: { from, to },
    input: {
      currency,
      rows,
      orders,
      profit: currency ? profitAfterReturns(orders, currency, spendWithFees) : null,
      adSpend: spendWithFees,
      courierify: { connected: connected.has("COURIERIFY"), lastParcelDay },
      cash: { asOf: T, payers: payerHistories(payouts), awaiting },
      asOf: T,
      adByVariant: adsComplete ? Object.fromEntries(ads.byVariant) : undefined,
      periodDays: lookback,
    },
  };
}
