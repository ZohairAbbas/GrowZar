import { describe, expect, it } from "vitest";

import { buyerNetworkView, figuresText, lineOf, parseAnswer, pickRefresh, STALE_MS, type StoredAnswer } from "./buyer-network";
import { matchesFilter, orderFilterQuery, parseOrderFilter } from "./findings";
import { readsCapabilities } from "../sync/entities";
import type { RollupOrder } from "./rollups";

// Made-up numbers throughout; nothing here comes from a real store.
const NOW = new Date("2026-10-12T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const item = (o: Record<string, unknown> = {}) => ({
  phone: "+923000001234",
  status: "ok",
  store: { orders: 5, shipments: 6, delivered: 3, returned: 1, active: 1, cancelled: 0, codTotal: { amount: "5000.00", currency: "PKR" } },
  network: { otherStores: 3, orders: 50, shipments: 52, carriedShipments: 4, delivered: 40, returned: 9, active: 1, firstSeen: null, lastSeen: null, topCities: [{ city: "Multan", orders: 6 }] },
  risk: { level: "medium", basis: "made-up basis" },
  ...o,
});

describe("parseAnswer", () => {
  it("keeps counts and Courierify's label, never cities, couriers or money", () => {
    const a = parseAnswer(item())!;
    expect(a).toMatchObject({ status: "ok", otherStores: 3, riskLevel: "medium", storeFigures: { orders: 5, delivered: 3 }, network: { orders: 50, delivered: 40 } });
    expect(JSON.stringify(a)).not.toMatch(/Multan|PKR|5000/);
  });

  it("drops other stores' figures under 2 other stores, as Courierify does", () => {
    expect(parseAnswer(item({ network: { otherStores: 1, orders: 4, delivered: 1 } }))!.network).toBeNull();
  });

  it("reads a not-your-customer item, and an unknown risk level as none", () => {
    expect(parseAnswer({ phone: "+923000001234", status: "not_your_customer", store: null, network: null, risk: null })).toMatchObject({ status: "not_your_customer", storeFigures: null, riskLevel: null });
    expect(parseAnswer(item({ risk: { level: "extreme" } }))!.riskLevel).toBeNull();
  });
});

describe("pickRefresh", () => {
  const c = (customerId: string, lastOrderDays: number, hasOpenOrder = false) => ({ customerId, phone: `+92300000${customerId.padStart(4, "0")}`, lastOrderAt: daysAgo(lastOrderDays), hasOpenOrder });

  it("asks open orders' buyers first, then the never-asked, then the stale; skips the fresh", () => {
    const fetched = new Map([
      ["1", { fetchedAt: daysAgo(1), phone: "+923000000001" }], // fresh
      ["2", { fetchedAt: daysAgo(10), phone: "+923000000002" }], // stale
      ["4", { fetchedAt: daysAgo(3), phone: "+923000000004" }], // ordered since
    ]);
    const picked = pickRefresh([c("1", 5), c("2", 20), c("3", 30), c("4", 2), c("5", 40, true)], fetched, NOW, 10).map((x) => x.customerId);
    expect(picked).toEqual(["5", "3", "4", "2"]);
  });

  it("asks again when the buyer's phone changed, and stops at the limit", () => {
    const fetched = new Map([["1", { fetchedAt: new Date(NOW.getTime() - STALE_MS + 1000), phone: "+923009999999" }]]);
    expect(pickRefresh([c("1", 5)], fetched, NOW, 10)).toHaveLength(1);
    expect(pickRefresh([c("1", 5), c("2", 5), c("3", 5)], new Map(), NOW, 2)).toHaveLength(2);
  });

  it("asks a not-your-customer buyer again after a day, an ok one only after a week", () => {
    const at = (status: string) => new Map([["1", { fetchedAt: daysAgo(2), phone: "+923000000001", status }]]);
    expect(pickRefresh([c("1", 5)], at("not_your_customer"), NOW, 10)).toHaveLength(1);
    expect(pickRefresh([c("1", 5)], at("ok"), NOW, 10)).toHaveLength(0);
  });
});

describe("buyerNetworkView", () => {
  const stored = (customerId: string, riskLevel: string, network: boolean, returned = 1): StoredAnswer => ({
    customerId,
    status: "ok",
    storeFigures: { orders: 2, delivered: 1, returned: 1, active: 0 },
    network: network ? { orders: 10, delivered: 9 - returned, returned, active: 1 } : null,
    otherStores: network ? 3 : 1,
    riskLevel,
    riskBasis: "made-up basis",
    fetchedAt: daysAgo(2),
  });

  it("counts the period's buyers by Courierify's label, and lists open orders of high-risk buyers, most returns first", () => {
    const answers = new Map([
      ["a", stored("a", "high", true, 2)],
      ["b", stored("b", "high", true, 6)],
      ["c", stored("c", "low", false)],
      ["d", { ...stored("d", "high", false), status: "not_your_customer" }],
    ]);
    const open = (orderId: string, customerId: string, highAtOrder: boolean | null = null) => ({ orderId, orderName: `#${orderId}`, customerId, createdAt: daysAgo(1), outcome: "not_shipped", phoneTail: "1234", highAtOrder });
    const v = buyerNetworkView({ periodBuyers: new Set(["a", "b", "c", "d", "e"]), answers, openOrders: [open("1", "a"), open("2", "b"), open("3", "c"), open("4", "e")] });
    expect(v).toMatchObject({ buyers: 5, answered: 3, withNetwork: 2, levels: { high: 2, low: 1, medium: 0 }, openHighTotal: 2, openOrders: 4, openAnswered: 3, openNotShippedHere: 0 });
    // The label when the order was placed wins over today's, either way.
    const atOrder = buyerNetworkView({ periodBuyers: new Set(), answers, openOrders: [open("1", "a", false), open("3", "c", true)] });
    expect(atOrder.openHigh.map((o) => o.orderId)).toEqual(["3"]);
    const first = buyerNetworkView({ periodBuyers: new Set(["d"]), answers, openOrders: [open("5", "d")] });
    expect(first).toMatchObject({ answered: 0, openAnswered: 0, openNotShippedHere: 1 });
    expect(v.openHigh.map((o) => o.orderId)).toEqual(["2", "1"]);
  });

  it("shows nothing for an item that isn't the store's customer", () => {
    expect(lineOf({ ...stored("x", "high", true), status: "invalid_phone" })).toBeNull();
  });

  it("writes exact counts, never a band", () => {
    expect(figuresText({ orders: 50, delivered: 40, returned: 9, active: 1 })).toBe("40 of 50 delivered, 9 returned, 1 on the way");
    expect(figuresText({ orders: 0, delivered: 0, returned: 0, active: 0 })).toBe("No parcels with you yet");
  });
});

describe("network=high on the Orders list", () => {
  const order = (o: Partial<RollupOrder>) => ({ orderId: "o1", customerId: "a", outcome: "not_shipped", createdAt: daysAgo(3), ...o }) as RollupOrder;
  it("keeps open orders of the last 30 days counted high risk", () => {
    const filter = parseOrderFilter(new URLSearchParams("network=high"))!;
    expect(orderFilterQuery(filter)).toBe("network=high");
    const ctx = { asOf: NOW, highRisk: new Set(["o1"]) };
    expect(matchesFilter(order({}), filter, "PKR", ctx)).toBe(true);
    expect(matchesFilter(order({ orderId: "o2" }), filter, "PKR", ctx)).toBe(false);
    expect(matchesFilter(order({ outcome: "delivered" }), filter, "PKR", ctx)).toBe(false);
    expect(matchesFilter(order({ createdAt: daysAgo(31) }), filter, "PKR", ctx)).toBe(false);
  });
});

describe("capabilities", () => {
  it("re-reads Courierify's status for the buyer network, though no Courierify feed is gated", () => {
    expect(readsCapabilities("COURIERIFY")).toBe(true);
  });
});
