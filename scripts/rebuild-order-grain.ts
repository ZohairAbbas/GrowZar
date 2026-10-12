/**
 * Rebuild the order grain for one store, or every store.
 *
 *   npx tsx --env-file=.env scripts/rebuild-order-grain.ts [<shop-domain>]
 *
 * The worker rebuilds in full once per store after it starts, after a
 * deletion and hourly, and incrementally in between; this is for doing a
 * full rebuild by hand.
 */
import { prisma } from "../app/lib/db.server";
import { rebuildOrderGrain } from "../app/lib/metrics/order-grain.server";

const shop = process.argv[2]?.toLowerCase();
const stores = await prisma.store.findMany({ where: shop ? { shopDomain: shop } : {}, select: { id: true, shopDomain: true } });
if (shop && !stores.length) throw new Error(`No store ${shop}`);
for (const s of stores) {
  const r = await rebuildOrderGrain(s.id);
  console.log(`${s.shopDomain}: ${r.orders} orders, ${r.withCustomer} with a customer, ${r.ms} ms`);
}
await prisma.$disconnect();
