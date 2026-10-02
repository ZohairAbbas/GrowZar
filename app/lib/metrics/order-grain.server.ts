import { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { buyerFromOrderPayload } from "../customers/resolve.server";
import { normalizePhone } from "../customers/phone";
import { buildOrderGrain, type OrderGrain, type SourceRow } from "./order-grain";
import type { Money } from "./money";

/**
 * Rebuild one store's order grain from what Growzar has synced (G-GZR2-2).
 *
 * The whole store, every time. At pilot size — 4.3k orders, 7.5k source rows,
 * 7k events — that is a couple of seconds, and a full rebuild cannot drift
 * from its inputs the way an incremental one can. When a store is large
 * enough for that to matter, the rebuild can take the changed order ids from
 * the sync; the builder is already per order.
 *
 * The grain is replaced in one transaction, so a reader sees the old grain or
 * the new one, never half of each.
 */

const WRITE_CHUNK = 500;

type Loaded = {
  orders: Map<string, SourceRow>;
  parcelsByOrder: Map<string, SourceRow[]>;
  confirmationsByOrder: Map<string, SourceRow[]>;
};

function asSource(row: {
  app: string;
  entity: string;
  externalId: string;
  sourceUpdatedAt: Date;
  payload: Prisma.JsonValue;
}): SourceRow {
  return {
    app: row.app as SourceRow["app"],
    entity: row.entity as SourceRow["entity"],
    externalId: row.externalId,
    sourceUpdatedAt: row.sourceUpdatedAt,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  };
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

async function load(storeId: string): Promise<Loaded> {
  const rows = await prisma.rawRecord.findMany({
    where: {
      storeId,
      deletedAt: null,
      OR: [
        { app: "FINANCIFY", entity: "ORDER" },
        { app: "COURIERIFY", entity: { in: ["PARCEL", "CONFIRMATION"] } },
      ],
    },
    select: { app: true, entity: true, externalId: true, sourceUpdatedAt: true, payload: true },
  });

  const loaded: Loaded = {
    orders: new Map(),
    parcelsByOrder: new Map(),
    confirmationsByOrder: new Map(),
  };

  for (const raw of rows) {
    const row = asSource(raw);
    if (row.entity === "ORDER") {
      loaded.orders.set(row.externalId, row);
      continue;
    }
    // A parcel or confirmation without a numeric order id cannot join to an
    // order (rule #6). It stays a parcel; it is never promoted to an order.
    const orderId = typeof row.payload.orderId === "string" ? row.payload.orderId : null;
    if (!orderId) continue;
    push(row.entity === "PARCEL" ? loaded.parcelsByOrder : loaded.confirmationsByOrder, orderId, row);
  }

  return loaded;
}

const decimal = (m: Money | null) => (m ? new Prisma.Decimal(m.amount) : null);

function toRow(storeId: string, g: OrderGrain): Prisma.OrderGrainCreateManyInput {
  return {
    storeId,
    orderId: g.orderId,
    orderName: g.orderName,
    createdAt: g.createdAt,
    localDay: g.localDay,
    currency: g.currency,
    placedAmount: decimal(g.placed),
    deliveredAmount: decimal(g.delivered),
    refundedAmount: decimal(g.refunded),
    discountsAmount: decimal(g.discounts),
    shippingAmount: decimal(g.shipping),
    taxAmount: decimal(g.tax),
    collectedAmount: decimal(g.collected),
    collectedCurrency: g.collected?.currency ?? null,
    cogsAmount: decimal(g.cogs),
    cogsCurrency: g.cogs?.currency ?? null,
    cogsComplete: g.cogsComplete,
    courierFeeAmount: decimal(g.courierFee),
    courierFeeCurrency: g.courierFee?.currency ?? null,
    courierFeeSource: g.courierFeeSource,
    outcome: g.outcome,
    outcomeAuthority: g.outcomeAuthority,
    outcomeBasis: g.outcomeTiming?.basis ?? null,
    outcomeAt: g.outcomeTiming?.at ?? null,
    financifyOutcome: g.financifyOutcome,
    financifyStatus: g.financifyStatus,
    orderCancelled: g.orderCancelled,
    shipmentCancelled: g.shipmentCancelled,
    confirmation: g.confirmation,
    customerId: g.customerId,
    parcelCount: g.parcelCount,
    courier: g.courier,
    fulfilledVia: g.fulfilledVia,
    city: g.city,
    cityRaw: g.cityRaw,
    lines: g.lines as Prisma.InputJsonValue,
    explain: g.explain as Prisma.InputJsonValue,
  };
}

/**
 * Build every order of one store, without writing anything. The reconciliation
 * script uses this directly, so what it checks is exactly what gets stored.
 */
export async function computeOrderGrain(
  storeId: string,
): Promise<{ grain: OrderGrain[]; fromFinancify: number }> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { timezone: true, country: true },
  });

  const { orders, parcelsByOrder, confirmationsByOrder } = await load(storeId);

  const events = await prisma.shipmentEvent.findMany({
    where: { storeId },
    select: { shipmentId: true, status: true, courierEventAt: true, observedAt: true, sourceEventId: true, source: true },
  });
  const eventsByShipment = new Map<string, typeof events>();
  for (const e of events) push(eventsByShipment, e.shipmentId, e);

  // Buyer phone → Growzar customer (rule #19). Read-only: resolution itself
  // happens at sync time; the grain only looks the answer up.
  const identities = await prisma.customerIdentity.findMany({
    where: { storeId, kind: "PHONE" },
    select: { value: true, customerId: true },
  });
  const customerByPhone = new Map(identities.map((i) => [i.value, i.customerId]));

  const customerFor = (rows: SourceRow[]) => {
    for (const row of rows) {
      const phone = normalizePhone(buyerFromOrderPayload(row.payload).phone, store.country).e164;
      const id = phone ? customerByPhone.get(phone) : undefined;
      if (id) return { id, via: `phone on ${row.app.toLowerCase()}/${row.entity.toLowerCase()}/${row.externalId}` };
    }
    return null;
  };

  // The order list (rule #1): Financify's orders, plus any order a parcel
  // names that Financify does not have. A parcel is never an order, but an
  // order id on a parcel is evidence the order exists.
  const orderIds = new Set([...orders.keys(), ...parcelsByOrder.keys()]);

  const grain: OrderGrain[] = [];
  for (const orderId of orderIds) {
    const order = orders.get(orderId) ?? null;
    const parcels = (parcelsByOrder.get(orderId) ?? []).map((row) => ({
      row,
      events: eventsByShipment.get(row.externalId) ?? [],
    }));
    grain.push(
      buildOrderGrain({
        orderId,
        timezone: store.timezone,
        order,
        parcels,
        confirmations: confirmationsByOrder.get(orderId) ?? [],
        customer: customerFor([...(order ? [order] : []), ...parcels.map((p) => p.row)]),
      }),
    );
  }

  return { grain, fromFinancify: orders.size };
}

export type RebuildResult = {
  storeId: string;
  orders: number;
  fromFinancify: number;
  fromParcelsOnly: number;
  withCustomer: number;
  ms: number;
};

export async function rebuildOrderGrain(storeId: string): Promise<RebuildResult> {
  const started = Date.now();
  const { grain, fromFinancify } = await computeOrderGrain(storeId);

  const data = grain.map((g) => toRow(storeId, g));
  await prisma.$transaction(
    async (tx) => {
      await tx.orderGrain.deleteMany({ where: { storeId } });
      for (let i = 0; i < data.length; i += WRITE_CHUNK) {
        await tx.orderGrain.createMany({ data: data.slice(i, i + WRITE_CHUNK) });
      }
    },
    { timeout: 120_000 },
  );

  return {
    storeId,
    orders: grain.length,
    fromFinancify,
    fromParcelsOnly: grain.length - fromFinancify,
    withCustomer: grain.filter((g) => g.customerId).length,
    ms: Date.now() - started,
  };
}
