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
