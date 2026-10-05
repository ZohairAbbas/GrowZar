/**
 * One test per display rule in CONFLICTING-DATA-POINTS.md (G-GZR2-6).
 *
 * Thirty-two rules, thirty-two `describe` blocks, each named "rule #N" and
 * for the rule it defends — this is what stops Phase 3 quietly changing a
 * number. Fixture data only. The detailed behaviour of each builder has its
 * own tests beside it; these pin the *rule*, at the level a screen shows it.
 */
import { describe, expect, it } from "vitest";

import { APP_FEEDS, extractId, type EntityFeed } from "../sync/entities";
import { buyerFromOrderPayload } from "../customers/resolve.server";
import { normalizePhone } from "../customers/phone";
import { currentStatusTiming } from "../shipments/events";
import { buildOrderGrain, localDayOf, type OrderGrain, type SourceRow } from "./order-grain";
import { CurrencyMismatchError, addMoney, sumByCurrency } from "./money";
import { NO_FX_SOURCE, convertDated } from "./fx";
import { compareSettings } from "./profit-settings";
import {
  averageOrderValue,
  bucketOf,
  byCity,
  byCourier,
  productLines,
  profitAfterReturns,
  roas,
  rollup,
  type RollupOrder,
} from "./rollups";
import { DISPLAY_RULES } from "./rules";

// ── Fixtures ────────────────────────────────────────────────────────────────

const pkr = (amount: string) => ({ amount, currency: "PKR" });
const at = new Date("2026-09-25T10:00:00Z");
let seq = 0;

function financify(payload: Record<string, unknown> = {}, id = "5100000000001"): SourceRow {
  return {
    app: "FINANCIFY",
    entity: "ORDER",
    externalId: id,
    sourceUpdatedAt: at,
    payload: {
      orderId: id,
      orderName: "#1001",
      createdAt: "2026-09-20T12:00:00.000Z",
      money: { placed: pkr("1000.00"), refunded: pkr("0.00") },
      cogs: { total: pkr("300.00"), complete: true, linesMissingCost: 0 },
      // Financify's live shape: the money is nested under `amount`.
      courierFee: { amount: { amount: "200.00", currency: "PKR" }, source: "courierify_metafield" },
      delivery: { category: "delivered", status: "DELIVERED" },
      lineItems: [{ variantId: "v1", productId: "p1", quantity: 1, unitPrice: pkr("1000.00"), unitCost: pkr("300.00"), sku: "DUP" }],
      ...payload,
    },
  };
}

function parcel(status: string, extra: Record<string, unknown> = {}): SourceRow {
  seq += 1;
  return {
    app: "COURIERIFY",
    entity: "PARCEL",
    externalId: `shp-${seq}`,
    sourceUpdatedAt: at,
    payload: {
      status,
      orderId: "5100000000001",
      courier: "tcs",
      fulfilledVia: null,
      cityRaw: null,
      city: { raw: "lahore cantt", canonical: "Lahore", match: "exact" },
      cod: pkr("1000.00"),
      settlement: { settled: false },
      ...extra,
    },
  };
}

function grain(opts: Partial<Parameters<typeof buildOrderGrain>[0]> = {}): OrderGrain {
  return buildOrderGrain({
    orderId: "5100000000001",
    timezone: "Asia/Karachi",
    order: financify(),
    parcels: [],
    confirmations: [],
    customer: null,
    ...opts,
  });
}

function row(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`,
    localDay: "2026-09-20",
    createdAt: new Date("2026-09-20T06:00:00Z"),
    currency: "PKR",
    placed: pkr("1000.00"),
    delivered: pkr("1000.00"),
    refunded: pkr("0.00"),
    collected: null, uncollected: null,
    cogs: pkr("300.00"),
    cogsComplete: true,
    courierFee: pkr("200.00"),
    outcome: "delivered",
    outcomeTiming: { basis: "happened_on", at: new Date("2026-09-23T06:00:00Z") },
    financifyOutcome: "delivered",
    parcelCount: 1,
    courier: "tcs",
    fulfilledVia: null,
    cityRaw: null,
    city: "Lahore",
    confirmation: "confirmed",
    customerId: null,
    lines: [{ variantId: "v1", productId: "p1", quantity: 1, value: pkr("1000.00"), cost: pkr("300.00") }],
    ...o,
  };
}

const allFeeds: EntityFeed[] = Object.values(APP_FEEDS).flat() as EntityFeed[];
const feedText = allFeeds.map((f) => `${f.entity} ${f.path}`).join(" ").toLowerCase();
const grainKeys = Object.keys(grain()).join(" ").toLowerCase();

/** A deferred rule's guard: no feed and no grain field for its data exists yet. */
function expectNotSynced(pattern: RegExp) {
  expect(feedText).not.toMatch(pattern);
  expect(grainKeys).not.toMatch(pattern);
}

// ── The registry itself ─────────────────────────────────────────────────────

describe("the display rules registry", () => {
  it("holds exactly rules #1 to #32, once each", () => {
    expect(DISPLAY_RULES.map((r) => r.id)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  });
});

// ── A. Orders and money ─────────────────────────────────────────────────────

describe("rule #1: number of orders — one order list keyed by Shopify id; parcels are not orders", () => {
  it("counts an order with two parcels once, and keeps the parcels as a separate number", () => {
    const g = grain({ parcels: [{ row: parcel("delivered"), events: [] }, { row: parcel("delivered"), events: [] }] });
    expect(bucketOf("d", [row({ parcelCount: g.parcelCount })]).orders).toBe(1);
    expect(g.parcelCount).toBe(2);
  });
});

describe("rule #2: revenue — placed, delivered and collected are three numbers, never summed", () => {
  it("keeps the three apart, each from its own source", () => {
    const g = grain({ parcels: [{ row: parcel("delivered", { settlement: { settled: true } }), events: [] }] });
    expect([g.placed, g.delivered, g.collected]).toEqual([pkr("1000.00"), pkr("1000.00"), pkr("1000.00")]);
    expect(g.explain.placed?.source).toMatch(/^financify/);
    expect(g.explain.collected?.source).toMatch(/^courierify/);
    const b = bucketOf("d", [row()]);
    expect(Object.keys(b)).toEqual(expect.arrayContaining(["placed", "deliveredRevenue", "collected"]));
  });
});

describe("rule #3: average order value — derived from #1 and #2", () => {
  it("is placed revenue ÷ orders with a total, per currency, to the cent", () => {
    expect(averageOrderValue([row({ placed: pkr("1000.00") }), row({ placed: pkr("500.01") }), row({ placed: null })])).toEqual([pkr("750.01")]);
  });
});

describe("rule #4: currency — never add mixed currencies; convert at the day's rate, shown", () => {
  it("refuses to add, totals per currency, and leaves unconvertible money listed", () => {
    expect(() => addMoney(pkr("1.00"), { amount: "1.00", currency: "AED" })).toThrow(CurrencyMismatchError);
    expect(sumByCurrency([pkr("1.00"), { amount: "2.00", currency: "AED" }])).toHaveLength(2);
    const c = convertDated([{ day: "2026-07-12", money: { amount: "10.00", currency: "AED" } }], "PKR", NO_FX_SOURCE);
    expect(c.unconverted).toHaveLength(1);
    expect(c.total).toEqual(pkr("0.00"));
  });
});

describe("rule #5: what counts as a day — always the store's local day", () => {
  it("puts 19:30 UTC in Karachi on the next day, and has no day without a timezone", () => {
    expect(localDayOf(new Date("2026-09-20T19:30:00Z"), "Asia/Karachi")).toBe("2026-09-21");
    expect(grain({ timezone: null }).localDay).toBeNull();
  });
});

describe("rule #6: order ID — Shopify's numeric id as a string; the order name is display-only", () => {
  it("stringifies a numeric id and never keys by name", () => {
    const feed = allFeeds.find((f) => f.entity === "ORDER")!;
    expect(extractId({ orderId: 5123456789012, orderName: "#1001" }, feed)).toBe("5123456789012");
    expect(feed.idFields).not.toContain("orderName");
    expect(grain().orderId).toBe("5100000000001");
  });
});

// ── B. Delivery and returns ─────────────────────────────────────────────────

describe("rule #7: delivery status — Courierify when connected, otherwise Financify", () => {
  it("follows the courier over Financify, and falls back to Financify without a parcel", () => {
    expect(grain({ parcels: [{ row: parcel("returned"), events: [] }] })).toMatchObject({ outcome: "returned", outcomeAuthority: "courierify" });
    expect(grain()).toMatchObject({ outcome: "delivered", outcomeAuthority: "financify" });
  });
});

describe("rule #8: delivery rate — delivered ÷ (delivered + returned), by order, by order date, with in-transit beside it", () => {
  it("never gives a rate without the still-open count", () => {
    const b = bucketOf("d", [row(), row(), row({ outcome: "returned" }), row({ outcome: "in_transit" })]);
    expect(b.deliveryRate).toMatchObject({ rate: 2 / 3, delivered: 2, returned: 1, stillOpen: 1 });
  });
});

describe("rule #9: delivery date — 'status as of' until the courier gives a time", () => {
  it("says happened_on only with a courier time", () => {
    const ev = (courierEventAt: string | null) => [{ status: "delivered", observedAt: new Date("2026-09-28Z"), courierEventAt: courierEventAt ? new Date(courierEventAt) : null, sourceEventId: 1n, source: "backfill" }];
    expect(currentStatusTiming(ev(null))?.basis).toBe("status_as_of");
    expect(currentStatusTiming(ev("2026-09-26T10:00:00Z"))?.basis).toBe("happened_on");
  });
});

describe("rule #10: 'returned' — returned to origin, cancelled and refunded are three numbers", () => {
  it("keeps a refund out of the outcome and a cancellation out of returns", () => {
    const refunded = grain({ order: financify({ money: { placed: pkr("1000.00"), refunded: pkr("400.00") } }), parcels: [{ row: parcel("delivered"), events: [] }] });
    expect(refunded.outcome).toBe("delivered");
    expect(refunded.refunded).toEqual(pkr("400.00"));
    const b = bucketOf("d", [row({ outcome: "returned" }), row({ outcome: "order_cancelled" })]);
    expect(b.deliveryRate.returned).toBe(1);
    expect(b.cancelled).toBe(1);
  });
});

describe("rule #11: cancelled — a cancelled order is not a cancelled shipment", () => {
  it("records each separately", () => {
    expect(grain({ parcels: [{ row: parcel("cancelled"), events: [] }] })).toMatchObject({ shipmentCancelled: true, orderCancelled: false });
    expect(grain({ order: financify({ delivery: { category: "cancelled", status: "CANCELLED" } }) })).toMatchObject({ orderCancelled: true, shipmentCancelled: false });
  });
});

describe("rule #12: delivery by courier and by city — the same rule as #7 and #8", () => {
  it("uses the #8 formula per courier and per canonical city, with unmapped grouped", () => {
    const orders = [row({ city: "Lahore" }), row({ city: "Lahore", outcome: "returned" }), row({ city: null })];
    const cities = new Map(rollup(orders, byCity).map((b) => [b.key, b.deliveryRate.rate]));
    expect(cities.get("Lahore")).toBe(0.5);
    expect(cities.has("unmapped")).toBe(true);
    expect(rollup(orders, byCourier)[0]!.deliveryRate.rate).toBeCloseTo(2 / 3);
  });
});

// ── C. Costs, profit and cash ───────────────────────────────────────────────

describe("rule #13: courier cost per order — one source (Financify's courier_costs metafield)", () => {
  it("takes the fee from Financify even when the parcel carries fee fields, and leaves unpriced as null", () => {
    const g = grain({ parcels: [{ row: parcel("delivered", { deliveryFee: pkr("999.00"), codFee: pkr("99.00") }), events: [] }] });
    expect(g.courierFee).toEqual(pkr("200.00"));
    expect(grain({ order: financify({ courierFee: { amount: null, source: "unpriced" } }) }).courierFee).toBeNull();
  });
});

describe("rule #14: product cost — Financify owns it", () => {
  it("takes COGS from Financify and keeps whether it is complete", () => {
    const g = grain({ order: financify({ cogs: { total: pkr("10.00"), complete: false, linesMissingCost: 1 } }) });
    expect(g.cogs).toEqual(pkr("10.00"));
    expect(g.cogsComplete).toBe(false);
  });
});

describe("rule #15: net profit — Financify's alone; settings shown; mismatched stores flagged", () => {
  it("flags stores whose settings differ, and Growzar's own figure lists what it lacks", () => {
    const c = compareSettings([
      { storeId: "a", shopDomain: "a", settingsHash: "h1", settings: { realizedVsExpected: { value: "expected" } } },
      { storeId: "b", shopDomain: "b", settingsHash: "h2", settings: { realizedVsExpected: { value: "realized" } } },
    ]);
    expect(c.consistent).toBe(false);
    expect(c.differences[0]!.setting).toBe("realizedVsExpected");
    const p = profitAfterReturns(bucketOf("d", [row({ courierFee: null })]), "PKR", null);
    expect(p.complete).toBe(false);
  });
});

describe("rule #16: ROAS — delivered revenue ÷ ad spend", () => {
  it("uses delivered, not placed, revenue", () => {
    const b = bucketOf("d", [row(), row({ outcome: "returned", delivered: pkr("0.00") })]);
    expect(roas(b, [pkr("500.00")], "PKR")).toBe(2);
  });
});

describe("rule #17: cash collected — 'paid by courier' now; 'received in bank' when it exists", () => {
  it("counts only settled, delivered parcels as collected", () => {
    expect(grain({ parcels: [{ row: parcel("delivered"), events: [] }] }).collected).toBeNull();
    expect(grain({ parcels: [{ row: parcel("returned", { settlement: { settled: true } }), events: [] }] }).collected).toBeNull();
    expect(grain({ parcels: [{ row: parcel("delivered", { settlement: { settled: true } }), events: [] }] }).collected).toEqual(pkr("1000.00"));
  });
});

describe("rule #18: suppliers and purchase orders — deferred (Phase 5)", () => {
  it("has no purchasing feed yet", () => expectNotSynced(/supplier|purchase|\bpo\b/));
});

// ── D. Customers ────────────────────────────────────────────────────────────

describe("rule #19: number of customers — Growzar's own record, one person per normalised phone", () => {
  it("reads the same person from both apps' shapes and phone spellings", () => {
    const a = normalizePhone(buyerFromOrderPayload({ customer: { phone: "0300 1234567" } }).phone, "PK").e164;
    const b = normalizePhone(buyerFromOrderPayload({ buyer: { phone: { e164: "+923001234567", raw: "03001234567" } } }).phone, "PK").e164;
    expect(a).toBe("+923001234567");
    expect(b).toBe(a);
  });
});

describe("rule #20: customer lifetime value and order count — computed in Growzar from the order list", () => {
  it("rolls orders up by Growzar's customer id", () => {
    const [c] = rollup([row({ customerId: "c1" }), row({ customerId: "c1", outcome: "returned", delivered: pkr("0.00") })], (o) => [o.customerId!]);
    expect(c).toMatchObject({ key: "c1", orders: 2, deliveredRevenue: [pkr("1000.00")] });
  });
});

describe("rule #21: buyer risk — deferred (not in Growzar's feeds)", () => {
  it("has no risk feed or grain field, so no screen can show a risk from the wrong engine", () => expectNotSynced(/risk|fraud/));
});

describe("rule #22: consent / opted out — deferred (Phase 5)", () => {
  it("has no consent feed or grain field", () => expectNotSynced(/consent|opt.?out|unsubscrib/));
});

// ── E. Checkout, recovery and confirmation ──────────────────────────────────

describe("rule #23: abandoned carts — deferred", () => {
  it("has no cart or checkout feed", () => expectNotSynced(/cart|checkout|abandon/));
});

describe("rule #24: recovered carts — deferred; recovered = message sent, then an order within 7 days", () => {
  it("has no recovery feed, so no raw 'recovered' stamp can be shown", () => expectNotSynced(/recover/));
});

describe("rule #25: COD confirmation — Courierify's OrderConfirmation, else WhatKaBot", () => {
  it("takes the latest Courierify confirmation row", () => {
    const c = (id: string, status: string, day: string): SourceRow => ({ app: "COURIERIFY", entity: "CONFIRMATION", externalId: id, sourceUpdatedAt: new Date(day), payload: { status } });
    expect(grain({ confirmations: [c("1", "timed_out", "2026-09-20Z"), c("2", "confirmed", "2026-09-21Z")] }).confirmation).toBe("confirmed");
    expect(allFeeds.find((f) => f.entity === "CONFIRMATION")!.path).toMatch(/confirmations/);
  });
});

describe("rule #26: checkout conversion — deferred (Preventify, Phase 5)", () => {
  it("has no form-open or conversion feed", () => expectNotSynced(/conversion|form.?open|visitor/));
});

describe("rule #27: upsell performance — deferred (Preventify, Phase 5)", () => {
  it("has no upsell feed", () => expectNotSynced(/upsell|impression/));
});

// ── F. Products and inventory ───────────────────────────────────────────────

describe("rule #28: units sold per product — Inventorify when connected, otherwise Financify", () => {
  it("counts ordered units from Financify's lines", () => {
    const lines = productLines([row({ lines: [{ variantId: "v1", productId: "p1", quantity: 3, value: null, cost: null }] })]);
    expect(lines[0]).toMatchObject({ variantId: "v1", units: 3 });
  });
});

describe("rule #29: return rate per product — computed in Growzar from lines × outcome", () => {
  it("rates each variant by the outcome of the orders containing it", () => {
    const lines = productLines([row(), row({ outcome: "returned", delivered: pkr("0.00") })]);
    expect(lines[0]!.deliveryRate).toMatchObject({ delivered: 1, returned: 1, rate: 0.5 });
  });
});

describe("rule #30: product identity — the variant id; SKU is display-only", () => {
  it("keys lines by variant id even when SKUs collide", () => {
    const g = grain();
    expect(g.lines[0]!.variantId).toBe("v1");
    expect(JSON.stringify(g.lines)).not.toContain("DUP");
  });
});

// ── G. Messaging ────────────────────────────────────────────────────────────

describe("rule #31: WhatsApp messages and cost — deferred", () => {
  it("has no messaging feed", () => expectNotSynced(/message|conversation|whatsapp/));
});

describe("rule #32: campaigns — deferred; both apps shown, labelled by source, once read", () => {
  it("has no messaging-campaign feed (Financify's ad campaigns are ad spend, not this)", () => expectNotSynced(/campaign/));
});
