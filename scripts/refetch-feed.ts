/**
 * Re-read a feed from the beginning and refresh stored payloads whose
 * content changed, whatever their `updatedAt`.
 *
 *   npx tsx --env-file=.env scripts/refetch-feed.ts <shop> <APP> <ENTITY> [--dry-run]
 *   e.g. … refetch-feed.ts 0dscam-qn.myshopify.com COURIERIFY PARCEL
 *
 * Why it exists: an app that adds a field to a feed (additively, as the
 * contract asks) does not bump the rows' `updatedAt`. Growzar's sync dedupes
 * on `(entity, id, updatedAt)` (§6.2), so a concluded row — which will never
 * change again — keeps its old payload forever and never shows the new field.
 * Courierify's `fulfilledVia` (G-CFY2-1a, 2026-10-01) was the first case: 0 of
 * 3,252 stored parcels on 0dscam-qn had it after Courierify deployed.
 *
 * Compares canonical JSON, so an unchanged row is not rewritten. Keeps each
 * row's `sourceUpdatedAt` (the app's own), so the incremental cursor is not
 * disturbed. Afterwards, run resolve-customers.ts and rebuild-order-grain.ts
 * if the new field feeds identity or the grain.
 */
import type { Prisma, SuiteApp, SyncEntity } from "@prisma/client";

import { prisma } from "../app/lib/db.server";
import { appRequest } from "../app/lib/apps/client.server";
import { getAppCredentials } from "../app/lib/apps/registry.server";
import { extractId, feedsFor } from "../app/lib/sync/entities";
import { canonicalize } from "../app/lib/sync/snapshots.server";

const [shopArg, appArg, entityArg] = process.argv.slice(2);
const dryRun = process.argv.includes("--dry-run");
if (!shopArg || !appArg || !entityArg) {
  console.error("Usage: refetch-feed.ts <shop> <APP> <ENTITY> [--dry-run]");
  process.exit(1);
}
const app = appArg.toUpperCase() as SuiteApp;
const entity = entityArg.toUpperCase() as SyncEntity;
const feed = feedsFor(app).find((f) => f.entity === entity);
if (!feed) throw new Error(`No ${app} feed for ${entity}`);
if (feed.sink === "shipment_events") throw new Error("Events are immutable; nothing to refresh");

const store = await prisma.store.findUniqueOrThrow({ where: { shopDomain: shopArg.toLowerCase() } });
const credentials = getAppCredentials(app);
if (!credentials) throw new Error(`${app} is not configured`);

let cursor: string | null = null;
let seen = 0, refreshed = 0, unchanged = 0, notStored = 0, pages = 0;
do {
  const params = new URLSearchParams({ limit: String(feed.pageLimit ?? 200), ...(feed.query ?? {}) });
  if (cursor) params.set("cursor", cursor);
  const response = await appRequest<{ data?: unknown[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } }>(app, {
    pathWithQuery: `${feed.path}?${params}`,
    shopDomain: store.shopDomain,
    credentials,
  });
  if (!response.ok) throw new Error(`${feed.path}: ${response.reason} ${response.message}`);
  pages += 1;

  for (const row of response.data.data ?? []) {
    const externalId = extractId(row, feed);
    if (!externalId) continue;
    seen += 1;
    const stored = await prisma.rawRecord.findUnique({
      where: { storeId_app_entity_externalId: { storeId: store.id, app, entity, externalId } },
      select: { id: true, payload: true },
    });
    // Rows the incremental sync has not stored yet are its job, not ours.
    if (!stored) { notStored += 1; continue; }
    if (canonicalize(stored.payload) === canonicalize(row)) { unchanged += 1; continue; }
    if (!dryRun) {
      await prisma.rawRecord.update({
        where: { id: stored.id },
        data: { payload: row as Prisma.InputJsonValue, lastSeenAt: new Date() },
      });
    }
    refreshed += 1;
  }
  cursor = response.data.pagination?.hasMore ? (response.data.pagination.nextCursor ?? null) : null;
} while (cursor);

console.log(
  `${store.shopDomain} ${app}/${entity}: ${pages} page(s), ${seen} rows — ` +
    `${refreshed} ${dryRun ? "would be refreshed" : "refreshed"}, ${unchanged} unchanged, ${notStored} not stored yet`,
);
await prisma.$disconnect();
