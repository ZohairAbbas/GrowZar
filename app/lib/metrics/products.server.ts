import { prisma } from "../db.server";

export type CatalogEntry = { title: string | null; imageUrl: string | null; status: string | null };

/**
 * Titles and images for variants, from Financify's product catalogue as
 * Growzar stores it (`/api/v1/products`). Display only: nothing is counted
 * from it, and a variant missing here keeps the title its order lines carry.
 */
export async function loadCatalog(storeId: string, variantIds: readonly string[]): Promise<Map<string, CatalogEntry>> {
  if (!variantIds.length) return new Map();
  const rows = await prisma.$queryRaw<Array<{ variantId: string; product: string | null; variant: string | null; imageUrl: string | null; status: string | null }>>`
    SELECT "externalId" AS "variantId", payload->>'productTitle' AS product, payload->>'variantTitle' AS variant,
           payload->>'imageUrl' AS "imageUrl", payload->>'status' AS status
    FROM raw_records
    WHERE "storeId" = ${storeId} AND app = 'FINANCIFY' AND entity = 'PRODUCT' AND "deletedAt" IS NULL
      AND "externalId" = ANY(${[...variantIds]})`;
  return new Map(
    rows.map((r) => [
      r.variantId,
      {
        title: r.product ? (r.variant && r.variant !== "Default Title" ? `${r.product} — ${r.variant}` : r.product) : null,
        imageUrl: r.imageUrl && /^https:\/\//.test(r.imageUrl) ? r.imageUrl : null,
        status: r.status,
      },
    ]),
  );
}

export type PaymentSplit = { cod: number; prepaid: number; unknown: number; orders: number };

/**
 * COD against prepaid for the given orders, by Financify's own rule (G-FIN3-4,
 * `payment.method`, the dashboards' isCODOrder). An order whose stored row
 * predates the field is not counted.
 */
export async function loadPaymentSplit(storeId: string, orderIds: readonly string[]): Promise<PaymentSplit | null> {
  if (!orderIds.length) return null;
  const rows = await prisma.$queryRaw<Array<{ method: string | null; n: bigint }>>`
    SELECT payload->'payment'->>'method' AS method, count(*) AS n
    FROM raw_records
    WHERE "storeId" = ${storeId} AND app = 'FINANCIFY' AND entity = 'ORDER' AND "deletedAt" IS NULL
      AND payload ? 'payment' AND "externalId" = ANY(${[...orderIds]})
    GROUP BY 1`;
  const count = (m: string) => Number(rows.find((r) => r.method === m)?.n ?? 0n);
  const orders = rows.reduce((n, r) => n + Number(r.n), 0);
  return orders ? { cod: count("cod"), prepaid: count("prepaid"), unknown: orders - count("cod") - count("prepaid"), orders } : null;
}
