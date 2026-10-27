import { describe, expect, it } from "vitest";

import { buildOrderGrain, localDayOf, type SourceRow } from "./order-grain";
import { CurrencyMismatchError, addMoney, sumByCurrency } from "./money";

const pkr = (amount: string) => ({ amount, currency: "PKR" });
const at = new Date("2026-09-25T10:00:00Z");

function financify(overrides: Record<string, unknown> = {}): SourceRow {
  return {
    app: "FINANCIFY",
    entity: "ORDER",
    externalId: "6599204044902",
    sourceUpdatedAt: at,
    payload: {
      orderId: "6599204044902",
      orderName: "#1748",
      createdAt: "2026-05-17T19:30:00.000Z", // 00:30 on the 18th in Karachi
      localDay: "2026-05-18",
      money: {
        placed: pkr("11877.30"),
        refunded: pkr("0.00"),
        discounts: pkr("1319.70"),
        shipping: pkr("0.00"),
        tax: pkr("0.00"),
        collected: null,
      },
      cogs: { total: pkr("4050.00"), complete: true, linesMissingCost: 0 },
      courierFee: { amount: null, source: "unpriced" },
      delivery: { category: "delivered", status: "DELIVERED", statusObservedAt: "2026-09-13T13:48:48Z" },
      lineItems: [{ variantId: "45586349097062", productId: "7993109413990", quantity: 3, sku: null }],
      ...overrides,
    },
  };
}

function parcel(status: string, extra: Record<string, unknown> = {}): SourceRow {
  return {
    app: "COURIERIFY",
    entity: "PARCEL",
    externalId: `shp-${status}-${Math.random().toString(36).slice(2, 7)}`,
    sourceUpdatedAt: at,
    payload: {
      status,
      orderId: "6599204044902",
      cod: pkr("11877.30"),
      settlement: { settled: false },
      ...extra,
    },
  };
}

const event = (status: string, observedAt: string, courierEventAt: string | null, id = 1n) => ({
  status,
  observedAt: new Date(observedAt),
  courierEventAt: courierEventAt ? new Date(courierEventAt) : null,
  sourceEventId: id,
  source: courierEventAt ? "tracking_poll" : "backfill",
});

function grain(opts: Partial<Parameters<typeof buildOrderGrain>[0]> = {}) {
  return buildOrderGrain({
    orderId: "6599204044902",
    timezone: "Asia/Karachi",
    order: financify(),
    parcels: [],
    confirmations: [],
    customer: null,
    ...opts,
  });
}

describe("rule #2: placed, delivered and collected are three numbers", () => {
  it("keeps them apart, each with its own source", () => {
    const g = grain({
      parcels: [{ row: parcel("delivered", { settlement: { settled: true } }), events: [] }],
    });
    expect(g.placed).toEqual(pkr("11877.30"));
    expect(g.delivered).toEqual(pkr("11877.30"));
    expect(g.collected).toEqual(pkr("11877.30"));
    expect(g.explain.placed?.source).toContain("financify");
    expect(g.explain.collected?.source).toContain("courierify");
  });

  it("collects nothing before a settlement covers the parcel", () => {
    expect(grain({ parcels: [{ row: parcel("delivered"), events: [] }] }).collected).toBeNull();
  });

  it("does not count a settled *returned* parcel as collected cash", () => {
    const g = grain({ parcels: [{ row: parcel("returned", { settlement: { settled: true } }), events: [] }] });
    expect(g.collected).toBeNull();
    expect(g.delivered).toEqual(pkr("0.00"));
  });

  it("has no placed revenue without Financify, rather than borrowing the COD", () => {
    const g = grain({ order: null, parcels: [{ row: parcel("delivered"), events: [] }] });
    expect(g.placed).toBeNull();
    expect(g.explain.placed?.note).toMatch(/COD amount, not an order total/);
  });
});

describe("rule #4: mixed currencies are never summed", () => {
  it("refuses to add PKR to AED", () => {
    expect(() => addMoney(pkr("1.00"), { amount: "1.00", currency: "AED" })).toThrow(CurrencyMismatchError);
  });

  it("totals per currency, exactly, with no float error", () => {
    expect(
      sumByCurrency([pkr("0.10"), pkr("0.20"), { amount: "5.00", currency: "AED" }, null]),
    ).toEqual([{ amount: "5.00", currency: "AED" }, pkr("0.30")]);
  });

  it("keeps an order in its own currency on a PKR store", () => {
    const g = grain({ order: financify({ money: { placed: { amount: "250.00", currency: "AED" } } }) });
    expect(g.currency).toBe("AED");
  });
});

describe("rule #5: the store's local day", () => {
  it("puts a 19:30 UTC order on the next Karachi day", () => {
    expect(grain().localDay).toBe("2026-05-18");
    expect(localDayOf(new Date("2026-05-17T18:59:59Z"), "Asia/Karachi")).toBe("2026-05-17");
  });

  it("has no local day when the store's timezone is unknown, instead of using UTC", () => {
    expect(grain({ timezone: null }).localDay).toBeNull();
  });
});

describe("rule #7: Courierify is the delivery authority when connected", () => {
  it("overrides Financify's category with the courier's status, and says so", () => {
    const g = grain({ parcels: [{ row: parcel("returned"), events: [] }] });
    expect(g.outcome).toBe("returned");
    expect(g.outcomeAuthority).toBe("courierify");
    expect(g.explain.outcome?.note).toMatch(/Financify says delivered/);
  });

  it("carries who booked the deciding parcel, so a 3PL parcel reads as 'not available', not slow", () => {
    const viaOrio = grain({ parcels: [{ row: parcel("delivered", { fulfilledVia: "orio" }), events: [] }] });
    expect(viaOrio.fulfilledVia).toBe("orio");
    expect(viaOrio.explain.fulfilledVia?.note).toMatch(/booked through orio/);
    expect(grain({ parcels: [{ row: parcel("delivered", { fulfilledVia: "Shopify" }), events: [] }] }).fulfilledVia).toBe("shopify");
    expect(grain({ parcels: [{ row: parcel("delivered", { fulfilledVia: null }), events: [] }] }).fulfilledVia).toBeNull();
    expect(grain().fulfilledVia).toBeNull();
    // A cancelled parcel does not decide: the live one does.
    const rebooked = grain({
      parcels: [
        { row: parcel("cancelled", { fulfilledVia: "orio" }), events: [] },
        { row: parcel("delivered", { fulfilledVia: null }), events: [] },
      ],
    });
    expect(rebooked.fulfilledVia).toBeNull();
  });

  it("says an order's delivery was reported by the 3PL when that is the only time, and why", () => {
    const ev = (source: string, courierEventAt: string | null) => ({
      shipmentId: "s", status: "delivered", previousStatus: null, source, courierEventAt: courierEventAt ? new Date(courierEventAt) : null,
      observedAt: new Date("2026-09-05T00:00:00Z"), raw: null, sourceEventId: 1n, sourceCreatedAt: new Date("2026-09-05T00:00:00Z"), eventKey: "k",
    });
    const g = grain({ parcels: [{ row: parcel("delivered", { fulfilledVia: "orio" }), events: [ev("shopify_fulfillment_event", "2026-09-04T13:01:00Z")] }] });
    expect(g.outcomeTiming).toMatchObject({ basis: "reported_by_3pl" });
    expect(g.explain.outcomeTiming?.note).toMatch(/3PL reported a time/);
    // Two parcels: one courier-timed, one 3PL-timed, so the order is not "happened on".
    const mixed = grain({
      parcels: [
        { row: parcel("delivered"), events: [ev("tracking_poll", "2026-09-03T09:00:00Z")] },
        { row: parcel("delivered", { fulfilledVia: "orio" }), events: [ev("shopify_fulfillment_event", "2026-09-04T13:01:00Z")] },
      ],
    });
    expect(mixed.outcomeTiming?.basis).toBe("reported_by_3pl");
  });

  it("keeps Financify's own outcome beside the authority's, so a disagreement can be counted", () => {
    const g = grain({ parcels: [{ row: parcel("returned"), events: [] }] });
    expect(g.outcome).toBe("returned");
    expect(g.financifyOutcome).toBe("delivered");
    expect(grain({ order: null, parcels: [{ row: parcel("returned"), events: [] }] }).financifyOutcome).toBeNull();
  });

  it("falls back to Financify without a parcel, flagging a failed attempt filed as returned", () => {
    const g = grain({
      order: financify({ delivery: { category: "returned", status: "FAILED_DELIVERY" } }),
    });
    expect(g.outcome).toBe("returned");
    expect(g.outcomeAuthority).toBe("financify");
    expect(g.explain.outcome?.note).toMatch(/failed delivery attempt/);
  });
});

describe("rule #8 inputs: an order with no outcome yet stays unknown money", () => {
  it("has no delivered revenue while in transit", () => {
    const g = grain({ parcels: [{ row: parcel("out_for_delivery"), events: [] }] });
    expect(g.outcome).toBe("in_transit");
    expect(g.delivered).toBeNull();
  });
});

describe("rule #9: 'happened on' needs a courier time", () => {
  it("uses the courier's time when the log has one", () => {
    const g = grain({
      parcels: [{ row: parcel("delivered"), events: [event("delivered", "2026-06-03T07:44:00Z", "2026-06-01T09:38:01Z")] }],
    });
    expect(g.outcomeTiming).toEqual({ basis: "happened_on", at: new Date("2026-06-01T09:38:01Z") });
  });

  it("says 'status as of' for a backfilled state-as-of event", () => {
    const g = grain({
      parcels: [{ row: parcel("delivered"), events: [event("delivered", "2026-09-28T05:00:00Z", null)] }],
    });
    expect(g.outcomeTiming?.basis).toBe("status_as_of");
  });
});

describe("rules #10 and #11: returned, cancelled and refunded stay apart", () => {
  it("records a refund without changing the delivery outcome", () => {
    const g = grain({
      order: financify({ money: { placed: pkr("100.00"), refunded: pkr("40.00") } }),
      parcels: [{ row: parcel("delivered"), events: [] }],
    });
    expect(g.outcome).toBe("delivered");
    expect(g.refunded).toEqual(pkr("40.00"));
  });

  it("tells a cancelled shipment from a cancelled order", () => {
    const shipment = grain({ parcels: [{ row: parcel("cancelled"), events: [] }] });
    expect(shipment.outcome).toBe("shipment_cancelled");
    expect(shipment.shipmentCancelled).toBe(true);
    expect(shipment.orderCancelled).toBe(false);

    const order = grain({ order: financify({ delivery: { category: "cancelled", status: "CANCELLED" } }) });
    expect(order.outcome).toBe("order_cancelled");
    expect(order.orderCancelled).toBe(true);
  });

  it("ignores a cancelled parcel beside a delivered one", () => {
    const g = grain({
      parcels: [
        { row: parcel("cancelled"), events: [] },
        { row: parcel("delivered"), events: [] },
      ],
    });
    expect(g.outcome).toBe("delivered");
  });

  it("does not pick a side when one parcel came back and one did not", () => {
    const g = grain({
      parcels: [
        { row: parcel("returned"), events: [] },
        { row: parcel("delivered"), events: [] },
      ],
    });
    expect(g.outcome).toBe("partially_delivered");
    expect(g.delivered).toBeNull();
  });
});

describe("rule #12: courier, with Financify's carrier as the fallback", () => {
  it("uses the Courierify parcel's courier when there is one", () => {
    const g = grain({ parcels: [{ row: parcel("delivered", { courier: "TCS" }), events: [] }] });
    expect(g.courier).toBe("tcs");
    expect(g.explain.courier?.source).toContain("courierify");
  });

  it("falls back to Financify's carrier, prefixed so the spellings are not merged", () => {
    const g = grain({ order: financify({ delivery: { category: "delivered", status: "DELIVERED", carrier: "NK Fulfilment" } }) });
    expect(g.courier).toBe("financify:nk fulfilment");
    expect(g.city).toBeNull();
    expect(g.explain.city?.note).toMatch(/no delivery city from Financify/);
  });

  it("uses Financify's delivery city without a parcel, in Courierify's name when the store's data says which", () => {
    const cityAliases = new Map([["karachi city", { canonical: "Karachi", votes: 40, of: 41, how: "learned" as const }]]);
    const withCity = (raw: string) => financify({ delivery: { category: "delivered", status: "DELIVERED", city: { raw, country: "Pakistan" } } });
    const g = grain({ order: withCity("Karachi City"), cityAliases });
    expect([g.city, g.cityRaw]).toEqual(["Karachi", "Karachi City"]);
    expect(g.explain.city?.note).toMatch(/is Karachi on 40 of 41 orders both apps know/);
    const u = grain({ order: withCity("Gulshan Block 7"), cityAliases });
    expect([u.city, u.cityRaw]).toEqual([null, "Gulshan Block 7"]);
    expect(u.explain.city?.note).toMatch(/no learned match: unmapped/);
  });

  it("keeps Courierify's city when there is a parcel, whatever Financify says", () => {
    const cityAliases = new Map([["karachi", { canonical: "Karachi", votes: 0, of: 0, how: "name" as const }]]);
    const g = grain({
      order: financify({ delivery: { category: "delivered", status: "DELIVERED", city: { raw: "Karachi" } } }),
      parcels: [{ row: parcel("delivered", { city: { raw: "lahore cantt", canonical: "Lahore", match: "exact" } }), events: [] }],
      cityAliases,
    });
    expect(g.city).toBe("Lahore");
  });
});

describe("rules #13, #14: costs from Financify", () => {
  it("leaves an unpriced courier fee null with its reason, never zero", () => {
    const g = grain();
    expect(g.courierFee).toBeNull();
    expect(g.explain.courierFee?.note).toMatch(/unpriced/);
  });

  it("says when COGS is incomplete", () => {
    const g = grain({ order: financify({ cogs: { total: pkr("10.00"), complete: false, linesMissingCost: 2 } }) });
    expect(g.cogsComplete).toBe(false);
    expect(g.explain.cogs?.note).toMatch(/2 line/);
  });
});

describe("Shopify order edits (W1 finance edits)", () => {
  // Two lines as placed: 2 × 1,000 less 100 off, and 1 × 500. Shipping 200.
  const line = (lineId: string, quantity: number, price: string, cost: string | null, extra: Record<string, unknown> = {}) => ({
    lineId,
    variantId: `v${lineId}`,
    productId: `p${lineId}`,
    quantity,
    currentQuantity: quantity,
    unitPrice: pkr(price),
    unitCost: cost ? pkr(cost) : null,
    totalDiscount: pkr("0.00"),
    isGiftCard: false,
    ...extra,
  });
  const removal = (lines: Array<{ lineId: string; quantity: number; amount: string; tax?: string }>) => ({
    id: `r${Math.random().toString(36).slice(2, 7)}`,
    kind: "edit_removal",
    total: pkr("0.00"),
    amount: pkr("0.00"),
    lines: lines.map((l) => ({ lineId: l.lineId, quantity: l.quantity, amount: pkr(l.amount), tax: pkr(l.tax ?? "0.00"), restocked: true, isGiftCard: false })),
  });
  const moneyRefund = (amount: string) => ({ id: "rf1", kind: "refund", total: pkr(amount), amount: pkr(amount), lines: [] });
  const asPlaced = {
    placed: pkr("2600.00"),
    refunded: pkr("0.00"),
    discounts: pkr("100.00"),
    shipping: pkr("200.00"),
    tax: pkr("0.00"),
    collected: null,
  };
  const order = (extra: Record<string, unknown>) =>
    financify({
      money: asPlaced,
      cogs: { total: pkr("1500.00"), complete: true, linesMissingCost: 0 },
      lineItems: [line("1", 2, "1000.00", "600.00", { totalDiscount: pkr("100.00") }), line("2", 1, "500.00", "300.00")],
      current: { subtotal: pkr("2400.00"), tax: pkr("0.00"), total: pkr("2600.00"), edited: false, editedAt: null, editCount: 0 },
      refunds: [],
      ...extra,
    });
  const edited = (total: string) => ({ subtotal: pkr(total), tax: pkr("0.00"), total: pkr(total), edited: true, editedAt: "2026-09-20T10:00:00Z", editCount: 1 });

  it("an order edited to remove one of two lines: sales, lines and cost lose that line", () => {
    const g = grain({
      order: order({
        current: edited("2100.00"),
        refunds: [removal([{ lineId: "2", quantity: 1, amount: "500.00" }])],
        lineItems: [line("1", 2, "1000.00", "600.00", { totalDiscount: pkr("100.00") }), line("2", 1, "500.00", "300.00", { currentQuantity: 0 })],
      }),
      parcels: [{ row: parcel("delivered"), events: [] }],
    });
    expect(g.placed).toEqual(pkr("2100.00"));
    expect(g.delivered).toEqual(pkr("2100.00"));
    expect(g.lines[1]).toMatchObject({ quantity: 0, editedOff: 1, value: pkr("0.00"), cost: pkr("0.00") });
    expect(g.lines[0]).toMatchObject({ quantity: 2, value: pkr("1900.00"), cost: pkr("1200.00") });
    expect(g.lines[0]).not.toHaveProperty("editedOff");
    expect(g.cogs).toEqual(pkr("1200.00"));
    expect(g.cogsComplete).toBe(true);
    expect(g.explain.placed?.source).toMatch(/Shopify's edited total/);
    expect(g.explain.placed?.note).toMatch(/PKR 2600.00 as placed, less 500.00 of items removed in an edit/);
    expect(g.explain.cogs?.source).toMatch(/after Shopify's edits/);
    expect(g.explain.lines?.source).toMatch(/Shopify's edited quantities/);
  });

  it("an order edited to change a quantity: the line keeps its share of its own discount", () => {
    // One of the two discounted units removed: Shopify's removal carries
    // 950 (half the line after its discount).
    const g = grain({
      order: order({
        current: edited("1650.00"),
        refunds: [removal([{ lineId: "1", quantity: 1, amount: "950.00" }])],
      }),
    });
    expect(g.placed).toEqual(pkr("1650.00"));
    expect(g.lines[0]).toMatchObject({ quantity: 1, editedOff: 1, value: pkr("950.00"), cost: pkr("600.00") });
    expect(g.cogs).toEqual(pkr("900.00"));
  });

  it("takes the removed items' tax off placed and tax", () => {
    const g = grain({
      order: order({
        money: { ...asPlaced, placed: pkr("2675.00"), tax: pkr("75.00") },
        current: edited("2100.00"),
        refunds: [removal([{ lineId: "2", quantity: 1, amount: "500.00", tax: "75.00" }])],
      }),
    });
    expect(g.placed).toEqual(pkr("2100.00"));
    expect(g.tax).toEqual(pkr("0.00"));
    expect(g.explain.tax?.source).toMatch(/edit_removal/);
  });

  it("an edit plus a refund: the edit comes off placed, the refund stays in refunded (rule #10)", () => {
    // Shopify's current.total (1,800) is after both; Growzar keeps them apart.
    const g = grain({
      order: order({
        money: { ...asPlaced, refunded: pkr("300.00") },
        current: edited("1800.00"),
        refunds: [removal([{ lineId: "2", quantity: 1, amount: "500.00" }]), moneyRefund("300.00")],
      }),
    });
    expect(g.placed).toEqual(pkr("2100.00"));
    expect(g.refunded).toEqual(pkr("300.00"));
    expect(g.lines.map((l) => l.quantity)).toEqual([2, 0]);
  });

  it("an edited order later cancelled keeps its edited total and remaining units (rule #11)", () => {
    // Shopify's current.total and currentQuantity go to 0 on cancel.
    const g = grain({
      order: order({
        current: edited("0.00"),
        cancelledAt: "2026-09-21T10:00:00Z",
        delivery: { category: "cancelled", status: "CANCELLED", statusObservedAt: "2026-09-21T10:00:00Z" },
        refunds: [removal([{ lineId: "2", quantity: 1, amount: "500.00" }]), { id: "c1", kind: "cancellation", total: pkr("0.00"), amount: pkr("0.00"), lines: [{ lineId: "1", quantity: 2 }] }],
        lineItems: [line("1", 2, "1000.00", "600.00", { totalDiscount: pkr("100.00"), currentQuantity: 0 }), line("2", 1, "500.00", "300.00", { currentQuantity: 0 })],
      }),
    });
    expect(g.placed).toEqual(pkr("2100.00"));
    expect(g.delivered).toEqual(pkr("0.00"));
    expect(g.lines.map((l) => l.quantity)).toEqual([2, 0]);
    expect(g.cogs).toEqual(pkr("1200.00"));
  });

  it("an edited order with a remaining line missing its cost is incomplete", () => {
    const g = grain({
      order: order({
        current: edited("2100.00"),
        refunds: [removal([{ lineId: "2", quantity: 1, amount: "500.00" }])],
        lineItems: [line("1", 2, "1000.00", null, { totalDiscount: pkr("100.00") }), line("2", 1, "500.00", "300.00")],
        cogs: { total: pkr("300.00"), complete: false, linesMissingCost: 1 },
      }),
    });
    expect(g.cogs).toEqual(pkr("0.00"));
    expect(g.cogsComplete).toBe(false);
    expect(g.explain.cogs?.note).toMatch(/1 line\(s\) have no cost/);
  });

  it("a line with no cost that was edited off no longer makes the cost incomplete", () => {
    const g = grain({
      order: order({
        current: edited("2100.00"),
        refunds: [removal([{ lineId: "2", quantity: 1, amount: "500.00" }])],
        lineItems: [line("1", 2, "1000.00", "600.00", { totalDiscount: pkr("100.00") }), line("2", 1, "500.00", null)],
        cogs: { total: pkr("1200.00"), complete: false, linesMissingCost: 1 },
      }),
    });
    expect(g.cogs).toEqual(pkr("1200.00"));
    expect(g.cogsComplete).toBe(true);
  });

  it("a gift-card line carries no cost and does not make the cost incomplete", () => {
    const g = grain({
      order: order({
        lineItems: [line("1", 2, "1000.00", "600.00", { totalDiscount: pkr("100.00") }), line("2", 1, "500.00", null, { isGiftCard: true })],
        cogs: { total: pkr("1200.00"), complete: false, linesMissingCost: 1 },
      }),
    });
    expect(g.lines[1]?.cost).toEqual(pkr("0.00"));
    expect(g.cogs).toEqual(pkr("1200.00"));
    expect(g.cogsComplete).toBe(true);
    expect(g.placed).toEqual(pkr("2600.00"));
    expect(g.explain.cogs?.source).toMatch(/gift cards at no cost/);
  });

  it("an order without `current` keeps today's figures exactly", () => {
    const before = order({});
    delete before.payload.current;
    delete before.payload.refunds;
    const g = grain({ order: before });
    expect(g.placed).toEqual(pkr("2600.00"));
    expect(g.tax).toEqual(pkr("0.00"));
    expect(g.cogs).toEqual(pkr("1500.00"));
    expect(g.cogsComplete).toBe(true);
    expect(g.lines.map((l) => [l.quantity, l.value, l.cost])).toEqual([
      [2, pkr("1900.00"), pkr("1200.00")],
      [1, pkr("500.00"), pkr("300.00")],
    ]);
    expect(g.explain.placed).toMatchObject({ source: "financify.orders.money.placed", note: undefined });
    expect(g.explain.cogs?.source).toBe("financify.orders.cogs");
  });

  it("a refunded or cancelled order that was not edited keeps today's figures, whatever currentQuantity says", () => {
    const g = grain({
      order: order({
        money: { ...asPlaced, refunded: pkr("500.00") },
        current: { ...edited("0.00"), edited: false },
        refunds: [moneyRefund("500.00")],
        lineItems: [line("1", 2, "1000.00", "600.00", { totalDiscount: pkr("100.00"), currentQuantity: 0 }), line("2", 1, "500.00", "300.00", { currentQuantity: 0 })],
      }),
    });
    expect(g.placed).toEqual(pkr("2600.00"));
    expect(g.cogs).toEqual(pkr("1500.00"));
    expect(g.lines.map((l) => l.quantity)).toEqual([2, 1]);
  });

  it("an edit that removed nothing keeps the total as placed, and says so", () => {
    const g = grain({ order: order({ current: edited("2550.00") }) });
    expect(g.placed).toEqual(pkr("2600.00"));
    expect(g.explain.placed?.note).toMatch(/without removing items/);
  });

  it("an edit in another currency than the order is not applied (rule #4)", () => {
    const g = grain({
      order: order({
        current: edited("2100.00"),
        refunds: [{ ...removal([]), lines: [{ lineId: "2", quantity: 1, amount: { amount: "20.00", currency: "AED" } }] }],
      }),
    });
    expect(g.placed).toEqual(pkr("2600.00"));
    expect(g.lines[1]?.quantity).toBe(1);
    expect(g.explain.placed?.note).toMatch(/in AED and the order in PKR/);
  });
});

describe("rule #25: confirmation from Courierify's OrderConfirmation", () => {
  it("uses the latest confirmation row", () => {
    const older: SourceRow = { app: "COURIERIFY", entity: "CONFIRMATION", externalId: "c1", sourceUpdatedAt: new Date("2026-09-01Z"), payload: { status: "timed_out" } };
    const newer: SourceRow = { ...older, externalId: "c2", sourceUpdatedAt: new Date("2026-09-02Z"), payload: { status: "confirmed" } };
    expect(grain({ confirmations: [older, newer] }).confirmation).toBe("confirmed");
  });
});

describe("every field explains itself", () => {
  it("names the exact input rows", () => {
    const g = grain();
    expect(g.explain.placed?.inputs[0]).toMatch(/^financify\/order\/6599204044902@2026-09-25T10:00:00.000Z#money.placed$/);
  });
});
