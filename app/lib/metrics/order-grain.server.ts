import { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { buyerFromOrderPayload } from "../customers/resolve.server";
import { normalizePhone } from "../customers/phone";
import { buildOrderGrain, courierifyCityOf, financifyCityOf, type OrderGrain, type SourceRow } from "./order-grain";
import { learnCityAliases, type CityAlias } from "./city-aliases";
import type { Money } from "./money";

/**
 * Rebuild one store's order grain from what Growzar has synced (G-GZR2-2).
 *
 * Two ways, one builder (`buildGrains`, per order):
 *
 * - `rebuildOrderGrain`: the whole store, replaced in one transaction, so a
 *   reader sees the old grain or the new one, never half of each. It cannot
 *   drift from its inputs, and it is what learns the city aliases.
 * - `updateOrderGrain`: only the orders a sync cycle touched, with the
 *   aliases the last full rebuild learned. For the largest store (4.5k
 *   orders) a full rebuild took 9–28 s every cycle for ~5 changed orders.
 *   What it can miss (a parcel moved to another order, a customer merge,
 *   aliases a new order would teach) the worker's regular full rebuild
 *   corrects; `scripts/check-incremental-grain.ts` compares the two.
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

/**
 * The source rows the grain reads. One definition, used by the full load,
 * the partial load and the sync's change tracking, so they cannot disagree.
 */
export function isGrainInput(app: string, entity: string): boolean {
  return (
    (app === "FINANCIFY" && entity === "ORDER") ||
    (app === "COURIERIFY" && (entity === "PARCEL" || entity === "CONFIRMATION")) ||
    // WhatKaBot's COD checks: rule #25's fallback where Courierify has none.
    (app === "WHATKABOT" && entity === "CONFIRMATION")
  );
}

function fold(rows: ReadonlyArray<Parameters<typeof asSource>[0]>): Loaded {
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

async function load(storeId: string): Promise<Loaded> {
  const rows = await prisma.rawRecord.findMany({
    where: {
      storeId,
      deletedAt: null,
      OR: [
        { app: "FINANCIFY", entity: "ORDER" },
        { app: "COURIERIFY", entity: { in: ["PARCEL", "CONFIRMATION"] } },
        { app: "WHATKABOT", entity: "CONFIRMATION" },
      ],
    },
    select: { app: true, entity: true, externalId: true, sourceUpdatedAt: true, payload: true },
  });
  return fold(rows);
}

/**
 * The same rows as `load`, for the given orders only: the order itself, and
 * every parcel and confirmation whose payload names it (a string `orderId`,
 * as `fold` requires).
 */
async function loadOrders(storeId: string, orderIds: string[]): Promise<Loaded> {
  if (!orderIds.length) return fold([]);
  const rows = await prisma.$queryRaw<Array<Parameters<typeof asSource>[0]>>`
    SELECT app::text AS app, entity::text AS entity, "externalId", "sourceUpdatedAt", payload
    FROM raw_records
    WHERE "storeId" = ${storeId}
      AND "deletedAt" IS NULL
      AND (
        (app = 'FINANCIFY' AND entity = 'ORDER' AND "externalId" = ANY(${orderIds}::text[]))
        OR (
          ((app = 'COURIERIFY' AND entity IN ('PARCEL', 'CONFIRMATION')) OR (app = 'WHATKABOT' AND entity = 'CONFIRMATION'))
          AND jsonb_typeof(payload->'orderId') = 'string'
          AND payload->>'orderId' = ANY(${orderIds}::text[])
        )
      )`;
  return fold(rows);
}

/** The orders the parcels behind these shipment events belong to. */
async function ordersOfShipments(storeId: string, shipmentIds: string[]): Promise<string[]> {
  if (!shipmentIds.length) return [];
  const rows = await prisma.$queryRaw<Array<{ orderId: string }>>`
    SELECT DISTINCT payload->>'orderId' AS "orderId"
    FROM raw_records
    WHERE "storeId" = ${storeId}
      AND "deletedAt" IS NULL
      AND app = 'COURIERIFY' AND entity = 'PARCEL'
      AND "externalId" = ANY(${shipmentIds}::text[])
      AND jsonb_typeof(payload->'orderId') = 'string'`;
  return rows.map((r) => r.orderId);
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
    uncollectedAmount: decimal(g.uncollected),
    uncollectedCurrency: g.uncollected?.currency ?? null,
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

const EVENT_SELECT = { shipmentId: true, status: true, courierEventAt: true, observedAt: true, sourceEventId: true, source: true } as const;
type EventRow = Prisma.ShipmentEventGetPayload<{ select: typeof EVENT_SELECT }>;

type BuildInputs = Loaded & {
  eventsByShipment: Map<string, EventRow[]>;
  customerByPhone: Map<string, string>;
  timezone: string | null;
  country: string | null;
  cityAliases: ReadonlyMap<string, CityAlias>;
};

/** Orders built between yields to the event loop (see `buildGrains`). */
const YIELD_EVERY = 250;

/**
 * Build the grain for the given orders. An id with neither an order nor a
 * parcel builds nothing: that order no longer exists.
 */
async function buildGrains(orderIds: Iterable<string>, i: BuildInputs): Promise<OrderGrain[]> {
  const customerFor = (rows: SourceRow[]) => {
    for (const row of rows) {
      const phone = normalizePhone(buyerFromOrderPayload(row.payload).phone, i.country).e164;
      const id = phone ? i.customerByPhone.get(phone) : undefined;
      if (id) return { id, via: `phone on ${row.app.toLowerCase()}/${row.entity.toLowerCase()}/${row.externalId}` };
    }
    return null;
  };

  const grain: OrderGrain[] = [];
  let built = 0;
  for (const orderId of orderIds) {
    // Building a store's grain is one long synchronous run (thousands of
    // payloads parsed, phones normalized). Yield now and then so the worker's
    // timers, its queue lock renewal among them, and the event relay keep
    // running while a large store rebuilds.
    if (++built % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
    const order = i.orders.get(orderId) ?? null;
    const sourceParcels = i.parcelsByOrder.get(orderId) ?? [];
    if (!order && !sourceParcels.length) continue;
    const parcels = sourceParcels.map((row) => ({ row, events: i.eventsByShipment.get(row.externalId) ?? [] }));
    grain.push(
      buildOrderGrain({
        orderId,
        timezone: i.timezone,
        order,
        parcels,
        confirmations: i.confirmationsByOrder.get(orderId) ?? [],
        customer: customerFor([...(order ? [order] : []), ...parcels.map((p) => p.row)]),
        cityAliases: i.cityAliases,
      }),
    );
  }
  return grain;
}

/**
 * Build every order of one store, without writing anything. The reconciliation
 * script uses this directly, so what it checks is exactly what gets stored.
 */
export async function computeOrderGrain(
  storeId: string,
): Promise<{ grain: OrderGrain[]; fromFinancify: number; cityAliases: Map<string, CityAlias> }> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { timezone: true, country: true },
  });

  const loaded = await load(storeId);

  const events = await prisma.shipmentEvent.findMany({ where: { storeId }, select: EVENT_SELECT });
  const eventsByShipment = new Map<string, EventRow[]>();
  for (const e of events) push(eventsByShipment, e.shipmentId, e);

  // Buyer phone → Growzar customer (rule #19). Read-only: resolution itself
  // happens at sync time; the grain only looks the answer up.
  const identities = await prisma.customerIdentity.findMany({
    where: { storeId, kind: "PHONE" },
    select: { value: true, customerId: true },
  });
  const customerByPhone = new Map(identities.map((i) => [i.value, i.customerId]));

  // Financify's city spellings in Courierify's names, learned from the orders
  // both apps know (city-aliases.ts).
  const pairs: Array<{ raw: string; canonical: string }> = [];
  for (const [orderId, order] of loaded.orders) {
    const raw = financifyCityOf(order);
    const canonical = courierifyCityOf((loaded.parcelsByOrder.get(orderId) ?? []).map((row) => ({ row })));
    if (raw && canonical) pairs.push({ raw, canonical });
  }
  const cityAliases = learnCityAliases(pairs);

  // The order list (rule #1): Financify's orders, plus any order a parcel
  // names that Financify does not have. A parcel is never an order, but an
  // order id on a parcel is evidence the order exists.
  const orderIds = new Set([...loaded.orders.keys(), ...loaded.parcelsByOrder.keys()]);
  const grain = await buildGrains(orderIds, {
    ...loaded,
    eventsByShipment,
    customerByPhone,
    timezone: store.timezone,
    country: store.country,
    cityAliases,
  });

  return { grain, fromFinancify: loaded.orders.size, cityAliases };
}

/** What a sync cycle touched, as the grain sees it (see `isGrainInput`). */
export type GrainChanges = { orderIds: string[]; shipmentIds: string[] };

/**
 * Build only the orders `changes` names, without writing anything: the order
 * rows, parcels and confirmations naming them, the events of those parcels,
 * and the identities of those buyers. City aliases are passed in, from the
 * last full build. Returns every order id it considered, built or not.
 */
export async function computeOrderGrainFor(
  storeId: string,
  changes: GrainChanges,
  cityAliases: ReadonlyMap<string, CityAlias>,
): Promise<{ orderIds: string[]; grain: OrderGrain[] }> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { timezone: true, country: true },
  });
  const orderIds = [...new Set([...changes.orderIds, ...(await ordersOfShipments(storeId, changes.shipmentIds))])];
  const loaded = await loadOrders(storeId, orderIds);

  const parcelIds = [...loaded.parcelsByOrder.values()].flat().map((p) => p.externalId);
  const events = parcelIds.length
    ? await prisma.shipmentEvent.findMany({ where: { storeId, shipmentId: { in: parcelIds } }, select: EVENT_SELECT })
    : [];
  const eventsByShipment = new Map<string, EventRow[]>();
  for (const e of events) push(eventsByShipment, e.shipmentId, e);

  const rows = [...loaded.orders.values(), ...[...loaded.parcelsByOrder.values()].flat()];
  const phones = [...new Set(rows.map((r) => normalizePhone(buyerFromOrderPayload(r.payload).phone, store.country).e164).filter((p): p is string => !!p))];
  const identities = phones.length
    ? await prisma.customerIdentity.findMany({ where: { storeId, kind: "PHONE", value: { in: phones } }, select: { value: true, customerId: true } })
    : [];

  const grain = await buildGrains(orderIds, {
    ...loaded,
    eventsByShipment,
    customerByPhone: new Map(identities.map((i) => [i.value, i.customerId])),
    timezone: store.timezone,
    country: store.country,
    cityAliases,
  });
  return { orderIds, grain };
}

export type RebuildResult = {
  storeId: string;
  orders: number;
  fromFinancify: number;
  fromParcelsOnly: number;
  withCustomer: number;
  ms: number;
  /** Learned from every order; what `updateOrderGrain` needs until the next full rebuild. */
  cityAliases: Map<string, CityAlias>;
};

export async function rebuildOrderGrain(storeId: string): Promise<RebuildResult> {
  const started = Date.now();
  const { grain, fromFinancify, cityAliases } = await computeOrderGrain(storeId);

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
    cityAliases,
  };
}

/**
 * Replace the grain rows of the orders a cycle touched, in one transaction:
 * each such order is deleted and, if it still exists, written again.
 */
export async function updateOrderGrain(
  storeId: string,
  changes: GrainChanges,
  cityAliases: ReadonlyMap<string, CityAlias>,
): Promise<{ considered: number; written: number; ms: number }> {
  const started = Date.now();
  const { orderIds, grain } = await computeOrderGrainFor(storeId, changes, cityAliases);
  if (orderIds.length) {
    await prisma.$transaction(async (tx) => {
      await tx.orderGrain.deleteMany({ where: { storeId, orderId: { in: orderIds } } });
      if (grain.length) await tx.orderGrain.createMany({ data: grain.map((g) => toRow(storeId, g)) });
    });
  }
  return { considered: orderIds.length, written: grain.length, ms: Date.now() - started };
}

/** Exposed for the comparison script: the row exactly as stored. */
export const grainRow = toRow;
