import { prisma } from "../db.server";
import {
  inventoryView,
  parseDailySales,
  parsePurchaseOrder,
  parseSnapshot,
  parseVariant,
  shiftDay,
  RATE_DAYS,
  SELLING_DAYS,
  type InventoryView,
} from "./inventory";

type Payload = { payload: unknown };

/**
 * The Inventory section for one store, from the Inventorify rows Growzar has
 * synced (G-GZR5-1). Daily rows are read only as far back as the view needs:
 * the period, or the selling window, whichever starts earlier.
 */
export async function inventorySection(
  storeId: string,
  period: { from: string; to: string; today: string },
  currency: string | null,
): Promise<InventoryView> {
  const since = [period.from, shiftDay(period.today, -SELLING_DAYS)].sort()[0]!;
  // Snapshots for the period, and for the rate window (sales off an empty shelf).
  const snapshotsFrom = [period.from, shiftDay(period.today, -RATE_DAYS)].sort()[0]!;
  const [variants, sales, snapshots, purchaseOrders] = await Promise.all([
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'INVENTORIFY' AND entity = 'INVENTORY_VARIANT' AND "deletedAt" IS NULL`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'INVENTORIFY' AND entity = 'DAILY_SALES' AND "deletedAt" IS NULL
        AND payload->>'date' >= ${since}`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'INVENTORIFY' AND entity = 'STOCK_SNAPSHOT' AND "deletedAt" IS NULL
        AND payload->>'date' >= ${snapshotsFrom} AND payload->>'date' <= ${period.to}`,
    prisma.$queryRaw<Payload[]>`
      SELECT payload FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'INVENTORIFY' AND entity = 'PURCHASE_ORDER' AND "deletedAt" IS NULL`,
  ]);
  const keep = <T,>(rows: Payload[], parse: (p: unknown) => T | null) => rows.map((r) => parse(r.payload)).filter((x): x is T => x !== null);
  return inventoryView({
    variants: keep(variants, parseVariant),
    sales: keep(sales, parseDailySales),
    snapshots: keep(snapshots, parseSnapshot),
    purchaseOrders: keep(purchaseOrders, parsePurchaseOrder),
    period,
    today: period.today,
    currency,
  });
}
