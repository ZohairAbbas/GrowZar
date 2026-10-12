/**
 * Does the incremental grain build exactly what the full build does?
 *
 *   npx tsx --env-file=.env scripts/check-incremental-grain.ts <shop-domain> [sample]
 *
 * Builds the store's grain in full (writing nothing), then rebuilds a sample
 * of its orders the way the worker's incremental path does, once by order id
 * and once from their parcels' shipment ids, with the aliases the full build
 * learned. Every incremental row must equal its full-build row, field for
 * field, as stored. Read-only. Exits 1 on any difference.
 */
import { prisma } from "../app/lib/db.server";
import { computeOrderGrain, computeOrderGrainFor, grainRow } from "../app/lib/metrics/order-grain.server";

const shop = process.argv[2]?.toLowerCase();
const sample = Number(process.argv[3] ?? 300);
if (!shop) throw new Error("usage: check-incremental-grain.ts <shop-domain> [sample]");
const store = await prisma.store.findUniqueOrThrow({ where: { shopDomain: shop }, select: { id: true } });

const t0 = Date.now();
const full = await computeOrderGrain(store.id);
const fullMs = Date.now() - t0;
const byId = new Map(full.grain.map((g) => [g.orderId, JSON.stringify(grainRow(store.id, g))]));

// Every order with a parcel, plus a random spread of the rest, up to `sample`.
const ids = [...byId.keys()];
const withParcels = full.grain.filter((g) => g.parcelCount > 0).map((g) => g.orderId);
const picked = [...new Set([...withParcels.slice(0, sample / 2), ...ids.sort(() => Math.random() - 0.5)])].slice(0, sample);

let differ = 0;
const check = (label: string, built: Awaited<ReturnType<typeof computeOrderGrainFor>>, expected: string[]) => {
  const got = new Map(built.grain.map((g) => [g.orderId, JSON.stringify(grainRow(store.id, g))]));
  for (const id of expected) {
    if (got.get(id) !== byId.get(id)) {
      differ += 1;
      if (differ <= 5) console.log(`DIFFERS (${label}) order ${id}\n  full: ${byId.get(id)?.slice(0, 300)}\n  incr: ${got.get(id)?.slice(0, 300)}`);
    }
  }
  console.log(`${label}: ${expected.length} orders compared`);
};

const t1 = Date.now();
check("by order id", await computeOrderGrainFor(store.id, { orderIds: picked, shipmentIds: [] }, full.cityAliases), picked);
const incrMs = Date.now() - t1;

// From shipment ids alone: the parcels of the picked orders that have any.
const parcels = await prisma.rawRecord.findMany({
  where: { storeId: store.id, app: "COURIERIFY", entity: "PARCEL", deletedAt: null },
  select: { externalId: true, payload: true },
});
const pickedSet = new Set(withParcels.slice(0, sample / 2));
const orderOf = (payload: unknown) => {
  const id = (payload as Record<string, unknown> | null)?.orderId;
  return typeof id === "string" ? id : null;
};
const shipmentIds = parcels.filter((p) => pickedSet.has(orderOf(p.payload) ?? "")).map((p) => p.externalId);
check("by shipment id", await computeOrderGrainFor(store.id, { orderIds: [], shipmentIds }, full.cityAliases), [...pickedSet]);

console.log(`${shop}: full build ${full.grain.length} orders in ${fullMs} ms; ${picked.length} orders incrementally in ${incrMs} ms; ${differ} differ`);
await prisma.$disconnect();
process.exit(differ ? 1 : 0);
