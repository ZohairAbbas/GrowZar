import type { SuiteApp, SyncEntity } from "@prisma/client";

/**
 * What Growzar pulls from whom, and what the canonical key for each row is
 * (API-CONTRACT §3, §6).
 *
 * "The owning app does the work" (§1.1): each app is asked only about the
 * facts it owns. Courierify is not asked for costs and Financify is not asked
 * for parcels, however convenient it might be.
 *
 * **Paths are per app, not per entity.** §1.5 says "Paths are `/api/v1/...`
 * for anything new", which Courierify read as `/api/v1/growzar/...` and this
 * code originally read as `/api/v1/...`. Both are defensible readings of the
 * same sentence, and the disagreement was only visible once a real app
 * existed: every list call 404'd. The contract should fix the prefix; until it
 * does, each app declares its own.
 */
export type EntityFeed = {
  entity: SyncEntity;
  path: string;
  /** Extra query parameters this feed always needs. */
  query?: Record<string, string>;
  /**
   * The field on each row holding its canonical id, in order of preference.
   *
   * Orders are keyed by the Shopify numeric order ID **as a string** (rule #6).
   * `orderName` (`#1001`) is display-only and is never a join key, so it is
   * deliberately absent from every list here.
   */
  idFields: string[];
  /**
   * Where this feed reports deletions (§6.2). Courierify uses `deletedIds` on
   * shipments but `deletedSettlements` on settlements, so it cannot be assumed.
   * A feed whose tombstone key is missed loses deletions silently, which is
   * the failure §6.2 exists to prevent.
   */
  tombstoneKeys: string[];
  /**
   * The flag this feed sets when it had more tombstones than it could return.
   * Courierify caps them, so "no tombstones" and "too many tombstones" have to
   * be distinguishable or a mass delete looks like nothing happened.
   */
  tombstoneTruncatedKey?: string;
  /**
   * The row field holding its change time, which the cursor and dedupe run
   * on. `updatedAt` everywhere except the event log, whose rows never change
   * and so carry only `createdAt`.
   */
  updatedAtField?: string;
  /** Rows per page, where the feed's own default suits it better than ours. */
  pageLimit?: number;
  /**
   * Where rows land. `raw` is `raw_records`, verbatim JSONB, one row per id.
   * `shipment_events` is the event log's own table (G-GZR2-1).
   */
  sink?: "raw" | "shipment_events";
};

/**
 * Courierify, verified against the live app on 2026-09-28.
 *
 * It has **no orders endpoint**: contract §12 listed `/orders` as "existing and
 * reusable as-is", but G-CFY-2 built confirmations instead, which is the thing
 * I8 actually needs. Asking for orders it does not serve would 404 every cycle.
 */
const COURIERIFY_FEEDS: EntityFeed[] = [
  {
    entity: "PARCEL",
    path: "/api/v1/growzar/shipments",
    // A parcel is never counted as an order (rule #1), so it keeps the owning
    // app's own shipment id and is stored at its own grain.
    idFields: ["shipmentId", "parcelId", "id"],
    tombstoneKeys: ["deletedIds"],
    tombstoneTruncatedKey: "deletedIdsTruncated",
  },
  {
    entity: "SETTLEMENT",
    path: "/api/v1/growzar/settlements",
    idFields: ["settlementLineId", "lineId", "id"],
    tombstoneKeys: ["deletedSettlements", "deletedIds"],
    tombstoneTruncatedKey: "deletedSettlementsTruncated",
  },
  {
    entity: "CONFIRMATION",
    path: "/api/v1/growzar/confirmations",
    // Two channels, one entity. WhatsApp and voice confirmations answer the
    // same question — was this order confirmed — and I8 wants both.
    query: { channel: "whatsapp" },
    idFields: ["confirmationId", "id"],
    tombstoneKeys: ["deletedIds"],
  },
  {
    // The status event log (G-CFY-3). Its backfill is pruned 90 days after it
    // ran — late December 2026 — so Growzar keeps its own copy.
    entity: "SHIPMENT_EVENT",
    path: "/api/v1/growzar/shipment-events",
    idFields: ["id"],
    // Events are immutable at the source; there is nothing to tombstone.
    tombstoneKeys: [],
    updatedAtField: "createdAt",
    // Courierify's default and our largest page: 4M rows at 200 a page is
    // 20k requests, at 500 it is 8k.
    pageLimit: 500,
    sink: "shipment_events",
  },
];

/**
 * Financify, verified against the live app on 2026-09-29 for `0dscam-qn`.
 *
 * Only orders are a list feed. There is no `/api/v1/costs` — it 404'd — and
 * COGS arrives on each order row instead (`cogs`, per line, at order-time
 * cost). Profit settings and ad spend are not incremental lists: settings is
 * one object per store and ad spend is a date-range read, so the metric layer
 * reads them when it needs them rather than syncing them here.
 */
const FINANCIFY_FEEDS: EntityFeed[] = [
  {
    entity: "ORDER",
    path: "/api/v1/orders",
    idFields: ["orderId", "shopifyOrderId", "id"],
    tombstoneKeys: ["deletedIds"],
  },
];

export const APP_FEEDS: Partial<Record<SuiteApp, EntityFeed[]>> = {
  COURIERIFY: COURIERIFY_FEEDS,
  FINANCIFY: FINANCIFY_FEEDS,
  // Phase 5 (R2) brings WhatKaBot's conversations and the other three apps'
  // reads. In R1 they report installation state and nothing else (§12).
};

export function feedsFor(app: SuiteApp): EntityFeed[] {
  return APP_FEEDS[app] ?? [];
}

/**
 * Pull the canonical id out of a row.
 *
 * Numbers are stringified rather than rejected: Shopify order ids are numeric
 * and JSON.parse turns a bare 5123456789012 into a float. The contract asks
 * apps to send it as a string (§3); this survives one that forgets, because
 * losing the row would be worse than accepting the id it clearly meant.
 */
export function extractId(row: unknown, feed: EntityFeed): string | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;

  for (const field of feed.idFields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

/** `updatedAt` is mandatory: without it a row cannot be deduplicated (§6.2). */
export function extractUpdatedAt(row: unknown, field = "updatedAt"): Date | null {
  if (!row || typeof row !== "object") return null;
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "string") return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Every tombstone this page reports, from whichever key the app uses. */
export function extractTombstones(
  page: Record<string, unknown>,
  feed: EntityFeed,
): { ids: string[]; truncated: boolean } {
  const ids: string[] = [];

  for (const key of feed.tombstoneKeys) {
    const value = page[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) ids.push(entry.trim());
      else if (typeof entry === "number" && Number.isFinite(entry)) {
        ids.push(String(entry));
      } else if (entry && typeof entry === "object") {
        // Courierify's deletedSettlements may carry objects rather than bare
        // ids; take the id and ignore the rest.
        const id = (entry as Record<string, unknown>).id;
        if (typeof id === "string" && id.trim()) ids.push(id.trim());
      }
    }
  }

  const truncated = feed.tombstoneTruncatedKey
    ? page[feed.tombstoneTruncatedKey] === true
    : false;

  return { ids: [...new Set(ids)], truncated };
}
