import { describe, expect, it } from "vitest";

import { entityKeyOf, parseEnvelope } from "./envelope";

const valid = {
  eventId: "01JB8Z",
  topic: "shipment.delivered",
  occurredAt: "2026-09-23T06:04:11Z",
  shop: "acme.myshopify.com",
  actor: { type: "courier", id: "postex" },
  data: { shipmentId: "SHP-1" },
};

const envelope = (overrides: Record<string, unknown> = {}) =>
  parseEnvelope(JSON.stringify({ ...valid, ...overrides }));

describe("parseEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const result = envelope();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.envelope.eventId).toBe("01JB8Z");
    expect(result.envelope.shopDomain).toBe("acme.myshopify.com");
    expect(result.envelope.occurredAt.toISOString()).toBe("2026-09-23T06:04:11.000Z");
  });

  it("lowercases the shop domain", () => {
    const result = envelope({ shop: "ACME.myshopify.com" });
    expect(result.ok && result.envelope.shopDomain).toBe("acme.myshopify.com");
  });

  it("refuses an internal UUID in place of a shop", () => {
    // Courierify's outbound webhooks send an internal UUID as shopId today
    // (§3). Growzar never maps UUIDs, and guessing would attach one app's
    // event to the wrong store.
    const result = envelope({ shop: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
    expect(result).toEqual({ ok: false, problem: "missing_shop" });
  });

  it("names what is missing", () => {
    expect(envelope({ eventId: "" })).toEqual({ ok: false, problem: "missing_eventId" });
    expect(envelope({ topic: undefined })).toEqual({ ok: false, problem: "missing_topic" });
    expect(envelope({ occurredAt: "whenever" })).toEqual({
      ok: false,
      problem: "bad_occurredAt",
    });
    expect(parseEnvelope("{not json")).toEqual({ ok: false, problem: "not_json" });
  });

  it("tolerates a missing data object", () => {
    const result = envelope({ data: undefined });
    expect(result.ok && result.envelope.data).toEqual({});
  });
});

describe("entityKeyOf", () => {
  const keyFor = (overrides: Record<string, unknown>) => {
    const result = envelope(overrides);
    if (!result.ok) throw new Error("envelope should parse");
    return entityKeyOf(result.envelope);
  };

  it("keys shipment topics by the shipment", () => {
    expect(keyFor({ topic: "shipment.delivered", data: { shipmentId: "SHP-1" } })).toBe(
      "shipment:SHP-1",
    );
    // A return is about the same parcel, so it must share the key — otherwise
    // a late `delivered` would not be recognised as overtaken by the return.
    expect(keyFor({ topic: "shipment.returned", data: { shipmentId: "SHP-1" } })).toBe(
      "shipment:SHP-1",
    );
    expect(keyFor({ topic: "return.received", data: { shipmentId: "SHP-1" } })).toBe(
      "shipment:SHP-1",
    );
  });

  it("keys order topics by the Shopify order id, as a string", () => {
    expect(keyFor({ topic: "order.updated", data: { orderId: 5123456789012 } })).toBe(
      "order:5123456789012",
    );
  });

  it("treats an app topic as being about the connection", () => {
    expect(keyFor({ topic: "app.uninstalled", data: {} })).toBe("app");
  });

  it("returns null rather than an invented key", () => {
    // A wrong key would silently suppress real events as "overtaken".
    expect(keyFor({ topic: "shipment.delivered", data: {} })).toBeNull();
    expect(keyFor({ topic: "something.new", data: { id: "1" } })).toBeNull();
  });
});
