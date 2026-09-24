import type { SuiteApp, SyncEntity } from "@prisma/client";

/**
 * What Growzar pulls from whom, and what the canonical key for each row is
 * (API-CONTRACT §3, §6).
 *
 * "The owning app does the work" (§1.1): each app is asked only about the
 * facts it owns. Courierify is not asked for costs and Financify is not asked
 * for parcels, however convenient it might be.
 */
export type EntityFeed = {
  entity: SyncEntity;
  path: string;
  /**
   * The field on each row holding its canonical id, in order of preference.
   *
   * Orders are keyed by the Shopify numeric order ID **as a string** (rule #6).
   * `orderName` (`#1001`) is display-only and is never a join key, so it is
   * deliberately absent from every list here.
   */
  idFields: string[];
};

const ORDER_FEED: EntityFeed = {
  entity: "ORDER",
  path: "/api/v1/orders",
  idFields: ["orderId", "shopifyOrderId", "id"],
};

const PARCEL_FEED: EntityFeed = {
  entity: "PARCEL",
  path: "/api/v1/shipments",
  // A parcel is never counted as an order (rule #1), so it keeps the owning
  // app's own shipment id and is stored at its own grain.
  idFields: ["shipmentId", "parcelId", "id"],
};

const SETTLEMENT_FEED: EntityFeed = {
  entity: "SETTLEMENT",
  path: "/api/v1/settlements",
  idFields: ["settlementLineId", "lineId", "id"],
};

const COST_FEED: EntityFeed = {
  entity: "COST",
  path: "/api/v1/costs",
  idFields: ["costId", "id"],
};

/**
 * Courierify carries the delivery outcome, the booked fee per parcel and the
 * settlement lines — which is why I4 and I11 now depend entirely on it
 * (phase-g1/README.md, D-47). Financify carries cost and ad spend per product.
 */
export const APP_FEEDS: Partial<Record<SuiteApp, EntityFeed[]>> = {
  COURIERIFY: [ORDER_FEED, PARCEL_FEED, SETTLEMENT_FEED],
  FINANCIFY: [ORDER_FEED, COST_FEED],
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
export function extractUpdatedAt(row: unknown): Date | null {
  if (!row || typeof row !== "object") return null;
  const value = (row as Record<string, unknown>).updatedAt;
  if (typeof value !== "string") return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
