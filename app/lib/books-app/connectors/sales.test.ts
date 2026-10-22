import { describe, expect, it } from "vitest";

import { releaseDays, statusFromOutcome, toShopOrder, type FeedOrder } from "./sales";

const $ = (amount: string) => ({ amount, currency: "PKR" });

const row: FeedOrder = {
  orderId: "123",
  orderName: "#1001",
  createdAt: "2026-10-10T10:00:00+05:00",
  cancelledAt: null,
  test: false,
  currency: { code: "PKR" },
  money: { placed: $("2360.00"), discounts: $("100.00"), shipping: $("200.00"), tax: $("360.00") },
  payment: { gateways: ["Cash on Delivery (COD)", "card"] },
  transactions: [{ kind: "sale", gateway: "card", amount: $("500.00") }],
  unpaidGateway: "Cash on Delivery (COD)",
  everShipped: false,
  lineItems: [
    { lineId: "L1", variantId: "v1", quantity: 2, unitPrice: $("700.00"), totalDiscount: $("100.00"), unitCost: $("250.00"), isGiftCard: false },
    { lineId: "L2", variantId: "v2", quantity: 1, unitPrice: $("300.00"), totalDiscount: $("0"), unitCost: null, isGiftCard: false },
  ],
  refunds: [{ createdAt: "2026-10-12T09:00:00+05:00", total: $("354.00"), tax: $("54.00"), gateways: [{ gateway: "card", amount: $("354.00") }], lines: [{ lineId: "L2", quantity: 1, amount: $("300.00"), restocked: true, isGiftCard: false }] }],
  orderFacts: { available: true },
};

describe("Financify's order row as the sales rules read it", () => {
  it("money, lines after discounts, transactions, the unpaid gateway and shipping", () => {
    const o = toShopOrder(row, new Map([["v2", "120"]]));
    expect(o).toMatchObject({ id: "123", name: "#1001", total: "2360.00", discounts: "100.00", shipping: "200.00", tax: "360.00", received: "500.000000", unpaidGateway: "Cash on Delivery (COD)", shipped: false, gateways: ["Cash on Delivery (COD)", "card"] });
    expect(o.transactions).toEqual([{ kind: "SALE", status: "SUCCESS", gateway: "card", amount: "500.00" }]);
    expect(o.lines.map((l) => [l.total, l.unitCost])).toEqual([["1300.000000", "250.00"], ["300.000000", "120"]]);
  });

  it("cost: Financify's at sale first, Inventorify's when it has none, nothing when neither (D-78)", () => {
    expect(toShopOrder(row).lines[1]!.unitCost).toBeNull();
    expect(toShopOrder({ ...row, lineItems: [{ ...row.lineItems![0]!, unitCost: $("0") }] }, new Map([["v1", "99"]])).lines[0]!.unitCost).toBe("99");
  });

  it("refunds are dated, paid back through their gateways, and carry the refunded line's cost", () => {
    const [r] = toShopOrder(row, new Map([["v2", "120"]])).refunds;
    expect(r).toMatchObject({ createdAt: "2026-10-12T09:00:00+05:00", total: "354.00", tax: "54.00", transactions: [{ kind: "REFUND", status: "SUCCESS", gateway: "card", amount: "354.00" }] });
    expect(r!.lines).toEqual([{ quantity: 1, restock: true, giftCard: false, total: "300.00", unitCost: "120", lineId: "L2" }]);
  });

  it("outcomes in the rules' words", () => {
    expect(statusFromOutcome("delivered")).toBe("DELIVERED");
    expect(statusFromOutcome("partially_delivered")).toBe("DELIVERED");
    expect(statusFromOutcome("returned")).toBe("RETURNED");
    expect(statusFromOutcome("in_transit")).toBe("");
    expect(statusFromOutcome("order_cancelled")).toBe("");
  });

  it("the day a held sale counts, by basis, earliest evidence first", () => {
    const grain = [
      { orderId: "1", outcome: "delivered", day: "2026-10-12" },
      { orderId: "2", outcome: "in_transit", day: "2026-10-11" },
      { orderId: "3", outcome: "returned", day: "2026-10-13" },
    ];
    const parcels = [
      { orderId: "1", deliveredDay: "2026-10-12", returnedDay: null, settledDay: "2026-10-15" },
      { orderId: "4", deliveredDay: null, returnedDay: null, settledDay: "2026-10-14" },
    ];
    expect(Object.fromEntries(releaseDays("delivery", { grain, parcels }))).toEqual({ "1": "2026-10-12", "4": "2026-10-14" });
    expect(Object.fromEntries(releaseDays("dispatch", { grain, parcels }))).toEqual({ "1": "2026-10-12", "2": "2026-10-11", "3": "2026-10-13", "4": "2026-10-14" });
    // When paid: only money lets a sale in (D-83).
    expect(Object.fromEntries(releaseDays("money", { grain, parcels }))).toEqual({ "1": "2026-10-15", "4": "2026-10-14" });
  });
});
