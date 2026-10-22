import { describe, expect, it } from "vitest";
import { courierAccounts, openAmount, owedFigures, parcelStage, readCourierify, settledGross, type StageInput } from "../connectors/parcels";
import type { SalesMapping, ShopOrder } from "../connectors/shopify-sales";

const M: SalesMapping = { sales: "sales", shipping: "ship", discounts: "disc", returns: "ret", tax: "tax", gateways: { "Cash on Delivery - PostEx": "cod2" }, cod: "cod", prepaid: "pre", giftCards: "gift", cogs: "cogs", stock: "stock" };
const TZ = "Asia/Karachi";
const at = (day: string, h = 10) => `${day}T${String(h).padStart(2, "0")}:00:00+05:00`;
const order = (p: Partial<ShopOrder>): ShopOrder => ({ id: "gid://shopify/Order/1", name: "#1", createdAt: at("2026-10-01"), cancelledAt: null, test: false, currency: "PKR", gateways: ["Cash on Delivery (COD)"], total: "1000", received: "0", discounts: "0", shipping: "0", tax: "0", transactions: [], lines: [], refunds: [], ...p });
const refund = (day: string, total: string, lines: Array<{ total: string }> = [], paid?: string) => ({ createdAt: at(day, 15), total, tax: "0", transactions: paid ? [{ kind: "REFUND", status: "SUCCESS", gateway: "JazzCash", amount: paid }] : [], lines: lines.map((l) => ({ quantity: 1, restock: true, giftCard: false, total: l.total, unitCost: "100" })) });
const owe = (o: ShopOrder, asOf = "2026-10-10", lines: Record<string, string>[] = []) => owedFigures(o, M, 2, TZ, asOf, lines);

describe("what a parcel owes", () => {
  it("COD orders owe their total through the COD account; COD gateways mapped elsewhere count too", () => {
    expect(courierAccounts(M)).toEqual(new Set(["cod", "cod2"]));
    expect(owe(order({}))).toEqual({ accountId: "cod", saleOwed: 100000n, owed: 100000n });
    expect(owe(order({ gateways: ["Cash on Delivery - PostEx"] }))?.accountId).toBe("cod2");
  });
  it("prepaid orders aren't parcels to chase; a part paid upfront isn't owed by the courier", () => {
    expect(owe(order({ gateways: ["shopify_payments"], received: "1000", transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amount: "1000" }] }))).toBeNull();
    expect(owe(order({ gateways: ["JazzCash", "Cash on Delivery (COD)"], received: "300", transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "JazzCash", amount: "300" }] }))?.saleOwed).toBe(70000n);
  });
  it("a COD order marked paid in Shopify is still owed by the courier until it pays out", () => {
    expect(owe(order({ received: "1000", transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "Cash on Delivery (COD)", amount: "1000" }] }))?.saleOwed).toBe(100000n);
  });
  it("edits, unpaid refunds and cancellation come off, as of the day; later ones don't yet", () => {
    const edited = order({ refunds: [refund("2026-10-03", "0", [{ total: "400" }])] });
    expect(owe(edited)?.owed).toBe(60000n);
    expect(owe(edited, "2026-10-02")?.owed).toBe(100000n);
    expect(owe(order({ cancelledAt: at("2026-10-04") }))?.owed).toBe(0n);
    expect(owe(order({ refunds: [refund("2026-10-03", "250")] }))?.owed).toBe(75000n);
    // A refund paid back in money (to a wallet) doesn't change what the courier owes.
    expect(owe(order({ refunds: [refund("2026-10-03", "250", [], "250")] }))?.owed).toBe(100000n);
  });
  it("Books' own parcel entries (came back, written off) come off too, never below zero", () => {
    expect(owe(order({}), "2026-10-10", [{ cod: "-100000", ret: "100000" }])?.owed).toBe(0n);
    expect(owe(order({}), "2026-10-10", [{ cod: "-150000" }])?.owed).toBe(0n);
  });
});

describe("where a parcel is", () => {
  const base: StageInput = { saleOwed: 100000n, owed: 100000n, paid: 0n, writtenOff: 0n, shipped: true, trackingStatus: "IN_TRANSIT", trackingAt: new Date("2026-10-05T00:00:00Z"), placedDay: "2026-10-04", settledAt: null, settledNet: null, settledFees: null };
  const st = (p: Partial<StageInput>, today = "2026-10-10") => parcelStage({ ...base, ...p }, today);
  it("on its way, then stuck after the set days", () => {
    expect(st({})).toBe("in_transit");
    expect(st({}, "2026-10-26")).toBe("stuck");
    expect(st({ trackingStatus: "OUT_FOR_DELIVERY" }, "2026-10-26")).toBe("stuck");
  });
  it("not shipped, then stuck after the unshipped days", () => {
    expect(st({ shipped: false, trackingStatus: null, trackingAt: null })).toBe("not_shipped");
    expect(st({ shipped: false, trackingStatus: "PENDING", trackingAt: null }, "2026-10-20")).toBe("stuck");
  });
  it("delivered, then paid by the courier (not yet in the books), then cleared", () => {
    expect(st({ trackingStatus: "DELIVERED" })).toBe("delivered");
    expect(st({ trackingStatus: "DELIVERED", settledAt: new Date(), settledNet: 95000n, settledFees: 5000n })).toBe("paid_not_recorded");
    expect(st({ trackingStatus: "DELIVERED", paid: 100000n })).toBe("cleared");
  });
  it("paid short, paid more, written off", () => {
    expect(st({ paid: 90000n })).toBe("short_paid");
    expect(st({ paid: 110000n })).toBe("overpaid");
    expect(st({ paid: 90000n, writtenOff: 10000n })).toBe("cleared");
    expect(st({ writtenOff: 100000n })).toBe("written_off");
  });
  it("taken off: came back, or cancelled/refunded", () => {
    expect(st({ owed: 0n, trackingStatus: "RETURNED" })).toBe("came_back");
    expect(st({ owed: 0n, trackingStatus: "DISPATCHED" })).toBe("cancelled");
    expect(openAmount({ owed: 100000n, paid: 30000n, writtenOff: 5000n })).toBe(65000n);
  });
});

describe("Courierify on the order", () => {
  const costs = JSON.stringify({ trackingNumber: "T1", courier: "postex", costs: { deliveryFee: 135, codFee: 21.6, insuranceFee: null, taxAmount: null, grossCharges: null, netAmount: 3993.4, codAmount: 4150, currency: "PKR" } });
  const settlement = JSON.stringify({ courier: "postex", settlementRef: "CPR-1", fees: { deliveryFee: 135, codFee: 21.6, reversalFee: 0, netAmount: 3993.4, currency: "PKR" }, status: "received", settledAt: "2026-09-29T12:50:25.000Z" });
  it("reads the booking and the payout", () => {
    expect(readCourierify(costs, settlement, 2, "PKR")).toEqual({ courier: "postex", trackingNumber: "T1", bookedFees: 15660n, codAmount: 415000n, settlementRef: "CPR-1", settledAt: new Date("2026-09-29T12:50:25.000Z"), settledNet: 399340n, settledFees: 15660n });
    expect(settledGross(399340n, 15660n)).toBe(415000n);
  });
  it("a returned parcel's payout: charges only, nothing collected", () => {
    const back = JSON.stringify({ courier: "postex", settlementRef: "CPR-2", fees: { deliveryFee: 274.05, codFee: 0, reversalFee: 0, netAmount: -274.05 }, status: "received", settledAt: "2026-10-01T00:00:00Z" });
    const r = readCourierify(null, back, 2, "PKR");
    expect(settledGross(r.settledNet, r.settledFees)).toBe(0n);
    expect(r.settledFees).toBe(27405n);
  });
  it("tax and gross charges: the larger of itemised + tax and the gross", () => {
    const tcs = JSON.stringify({ courier: "tcs", costs: { deliveryFee: 200, codFee: null, insuranceFee: null, taxAmount: 30, grossCharges: 240, codAmount: 1000 } });
    expect(readCourierify(tcs, null, 0, "PKR").bookedFees).toBe(240n);
  });
  it("anything missing, malformed, not yet received or in another currency is left out", () => {
    expect(readCourierify("{not json", "null", 2, "PKR")).toMatchObject({ courier: null, settledAt: null, bookedFees: null });
    expect(readCourierify(null, JSON.stringify({ status: "pending", settlementRef: "X", fees: { netAmount: 1 }, settledAt: "2026-10-01" }), 2, "PKR").settlementRef).toBeNull();
    expect(readCourierify(JSON.stringify({ courier: "x", costs: { deliveryFee: 5, currency: "AED" } }), null, 2, "PKR").bookedFees).toBeNull();
    expect(readCourierify(null, JSON.stringify({ status: "received", settlementRef: "X", fees: { netAmount: 1, currency: "AED" }, settledAt: "2026-10-01" }), 2, "PKR").settledAt).toBeNull();
  });
});
