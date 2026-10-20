import { prisma } from "../db.server";
import { readMoney, type Money } from "../metrics/money";
import type { RollupOrder } from "../metrics/rollups";
import { toRollupOrder } from "../metrics/rollups.server";
import { knownAt } from "../outcomes/as-of.server";
import { DeliveryTimes, observations, OutcomeOdds } from "./outcome-odds";
import { payoutCycles, type PaidParcel, type PayoutCycle } from "./payout-cycle";

/**
 * Everything the Phase 11 forecasts share, as the store's data stood at `asOf`
 * (G-GZR11-1, pack §5.1). Today's forecast passes `new Date()`; a backtest
 * passes a past date and sees only:
 *  - orders placed before it, with outcomes known by then (`knownAt`);
 *  - parcels delivered by then, and payments recorded by then.
 */

export type Parcel = {
  orderId: string;
  payer: string;
  status: string;
  cod: Money | null;
  bookedAt: Date | null;
  /** Delivered by `asOf`; null otherwise, even if it was delivered later. */
  deliveredAt: Date | null;
  /** Paid by `asOf`; null otherwise. */
  settledAt: Date | null;
};

export type ForecastBase = {
  asOf: Date;
  storeId: string;
  currency: string | null;
  timezone: string;
  rows: RollupOrder[];
  parcels: Parcel[];
  odds: OutcomeOdds;
  deliveryTimes: DeliveryTimes;
  payoutCycles: Map<string, PayoutCycle>;
};

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One Courierify parcel as it stood at `asOf`. */
export function parcelAsOf(payload: Record<string, unknown>, asOf: Date): Parcel | null {
  const orderId = text(payload.orderId);
  if (!orderId) return null;
  const delivered = date(payload.deliveredAt) ?? date(payload.deliveredObservedAt);
  const s = obj(payload.settlement);
  const settled = s.settled === true ? date(s.settledAt) : null;
  const deliveredAt = payload.status === "delivered" && delivered && delivered <= asOf ? delivered : null;
  return {
    orderId,
    payer: (text(payload.fulfilledVia) ?? text(payload.courier) ?? "unknown").toLowerCase(),
    status: String(payload.status ?? "unknown"),
    cod: readMoney(payload.cod),
    bookedAt: date(payload.bookedAt),
    deliveredAt,
    settledAt: deliveredAt && settled && settled <= asOf ? settled : null,
  };
}

export async function loadForecastBase(storeId: string, asOf: Date = new Date()): Promise<ForecastBase> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { currency: true, timezone: true } });
  const grain = await prisma.orderGrain.findMany({ where: { storeId, createdAt: { lt: asOf } } });
  const rows = grain.map(toRollupOrder).map((o) => knownAt(o, asOf));

  const raw = await prisma.rawRecord.findMany({
    where: { storeId, app: "COURIERIFY", entity: "PARCEL", deletedAt: null },
    select: { payload: true },
  });
  const parcels = raw
    .map((r) => parcelAsOf(obj(r.payload), asOf))
    .filter((p): p is Parcel => p !== null && (p.bookedAt === null || p.bookedAt < asOf));

  const obs = observations(rows, asOf);
  const paid: PaidParcel[] = parcels.filter((p) => p.deliveredAt).map((p) => ({ payer: p.payer, deliveredAt: p.deliveredAt!, settledAt: p.settledAt }));

  return {
    asOf,
    storeId,
    currency: store.currency,
    timezone: store.timezone ?? "UTC",
    rows,
    parcels,
    odds: new OutcomeOdds(obs),
    deliveryTimes: new DeliveryTimes(obs),
    payoutCycles: payoutCycles(paid, asOf),
  };
}
