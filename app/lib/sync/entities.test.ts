import { describe, expect, it } from "vitest";

import { extractId, extractTombstones, feedOffered, feedsFor, reportsPurge, type EntityFeed } from "./entities";

const inventorify = feedsFor("INVENTORIFY");
const feed = (entity: string) => inventorify.find((f) => f.entity === entity) as EntityFeed;

describe("Inventorify feeds", () => {
  it("lists the seven feeds of its Phase 5 report, each behind its declared capability", () => {
    expect(inventorify.map((f) => f.capability)).toEqual([
      "variants:read",
      "stock-levels:read",
      "daily-sales:read",
      "stock-snapshots:read",
      "purchase-orders:read",
      "suppliers:read",
      "return-restocks:read",
    ]);
    expect(inventorify.every((f) => f.path.startsWith("/api/v1/growzar/"))).toBe(true);
  });

  it("keys rows by Inventorify's ids, natural keys included", () => {
    expect(extractId({ id: "880007", variantId: "880007" }, feed("INVENTORY_VARIANT"))).toBe("880007");
    expect(extractId({ id: "880007:2026-10-06", variantId: "880007" }, feed("DAILY_SALES"))).toBe("880007:2026-10-06");
    expect(extractId({ id: "880007:880077" }, feed("STOCK_LEVEL"))).toBe("880007:880077");
  });

  it("reads each feed's own tombstone key and truncation flag", () => {
    const page = { deletedPurchaseOrderIds: ["po1", "po2"], deletedPurchaseOrderIdsTruncated: true, deletedIds: ["other"] };
    expect(extractTombstones(page, feed("PURCHASE_ORDER"))).toEqual({ ids: ["po1", "po2"], truncated: true });
    expect(extractTombstones({ deletedVariantIds: ["v1"] }, feed("INVENTORY_VARIANT"))).toEqual({ ids: ["v1"], truncated: false });
    expect(extractTombstones({ deletedIds: ["x"] }, feed("DAILY_SALES"))).toEqual({ ids: [], truncated: false });
  });
});

describe("feedOffered", () => {
  it("asks for a gated feed only once the app declares it", () => {
    expect(feedOffered(feed("SUPPLIER"), [])).toBe(false);
    expect(feedOffered(feed("SUPPLIER"), ["variants:read"])).toBe(false);
    expect(feedOffered(feed("SUPPLIER"), ["suppliers:read"])).toBe(true);
  });

  it("always asks for the R1 feeds, which predate capabilities", () => {
    for (const f of [...feedsFor("COURIERIFY"), ...feedsFor("FINANCIFY")]) expect(feedOffered(f, [])).toBe(true);
  });
});

describe("reportsPurge", () => {
  it("is true only for a literal true", () => {
    expect(reportsPurge({ shopPurged: true })).toBe(true);
    for (const page of [{ shopPurged: false }, { shopPurged: "true" }, {}, null, undefined]) expect(reportsPurge(page)).toBe(false);
  });
});

const retainify = feedsFor("RETAINIFY");
const rfeed = (entity: string) => retainify.find((f) => f.entity === entity) as EntityFeed;

describe("Retainify feeds", () => {
  it("lists its six feeds, both consent feeds behind consent:read", () => {
    expect(retainify.map((f) => [f.entity, f.capability])).toEqual([
      ["MESSAGE", "messages:read"],
      ["JOURNEY", "journeys:read"],
      ["ENROLLMENT", "enrollments:read"],
      ["CHECKOUT", "checkouts:read"],
      ["CONSENT", "consent:read"],
      ["CONSENT_EVENT", "consent:read"],
    ]);
  });

  it("keys checkouts by token and consent by contact", () => {
    expect(extractId({ checkoutToken: "tok_1", checkoutId: "7001" }, rfeed("CHECKOUT"))).toBe("tok_1");
    expect(extractId({ contactId: "c1" }, rfeed("CONSENT"))).toBe("c1");
    expect(extractId({ id: "whatsapp:j1" }, rfeed("MESSAGE"))).toBe("whatsapp:j1");
  });

  it("matches consent-history tombstones on the contact, not the event id", () => {
    expect(rfeed("CONSENT_EVENT").tombstoneMatchField).toBe("contactId");
    expect(extractTombstones({ deletedContactIds: ["c1"], deletedContactIdsTruncated: false }, rfeed("CONSENT_EVENT"))).toEqual({
      ids: ["c1"],
      truncated: false,
    });
    expect(retainify.filter((f) => f.tombstoneMatchField).map((f) => f.entity)).toEqual(["CONSENT_EVENT"]);
  });
});
