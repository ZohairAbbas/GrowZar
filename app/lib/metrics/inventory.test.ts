import { describe, expect, it } from "vitest";

import {
  inventoryView,
  isOnTheWay,
  parseDailySales,
  parsePurchaseOrder,
  parseVariant,
  shiftDay,
  type DailySales,
  type InventoryVariant,
} from "./inventory";

const TODAY = "2026-10-08";
const pkr = (amount: string) => ({ amount, currency: "PKR" });

function variant(id: string, o: Partial<InventoryVariant> = {}): InventoryVariant {
  return { variantId: id, title: `Item ${id}`, variantTitle: null, sku: null, stock: 10, leadTimeDays: 7, unitCost: pkr("100.00"), archived: false, ...o };
}

/** `units` sold on each of the `days` full days before today. */
function sales(id: string, units: number, days = 30): DailySales[] {
  return Array.from({ length: days }, (_, i) => ({ variantId: id, date: shiftDay(TODAY, -(i + 1)), units }));
}

const view = (o: Partial<Parameters<typeof inventoryView>[0]> = {}) =>
  inventoryView({ variants: [], sales: [], snapshots: [], purchaseOrders: [], period: { from: "2026-09-09", to: TODAY }, today: TODAY, currency: "PKR", ...o });

describe("parsing Inventorify rows", () => {
  it("reads a variant, its cost as exact money, and refuses a row without stock", () => {
    expect(parseVariant({ variantId: "880007", title: "Kurta", stock: 12, leadTimeDays: 9, unitCost: { amount: "1250.50", currency: "PKR" } })).toMatchObject({
      variantId: "880007",
      stock: 12,
      unitCost: pkr("1250.50"),
    });
    expect(parseVariant({ variantId: "1", title: "x" })).toBeNull();
    expect(parseVariant({ variantId: "1", stock: 3, unitCost: null })?.unitCost).toBeNull();
  });

  it("reads days only as YYYY-MM-DD, and drops purchase-order lines with nothing due", () => {
    expect(parseDailySales({ variantId: "1", date: "2026-10-06T00:00:00Z", units: 2 })).toBeNull();
    const po = parsePurchaseOrder({ id: "p", poNumber: "PO-1", status: "SENT", items: [{ variantId: "1", onOrder: 5 }, { variantId: "2", onOrder: 0 }] })!;
    expect(po.items).toEqual([{ variantId: "1", onOrder: 5 }]);
    expect(isOnTheWay(po)).toBe(true);
    expect(isOnTheWay({ ...po, status: "draft" })).toBe(false);
  });
});

describe("inventoryView", () => {
  it("measures the rate over the last 30 full days, never today", () => {
    const v = view({ variants: [variant("a", { stock: 30 })], sales: [...sales("a", 1), { variantId: "a", date: TODAY, units: 50 }] });
    expect(v.rateWindow).toEqual({ from: "2026-09-08", to: "2026-10-07" });
    expect(v.rows[0]).toMatchObject({ perDay: 1, daysOfCover: 30 });
  });

  it("flags a selling variant that runs out within its lead time, unless stock is already on order", () => {
    const v = view({
      variants: [variant("a", { stock: 5 }), variant("b", { stock: 5 }), variant("c", { stock: 100 })],
      sales: [...sales("a", 1), ...sales("b", 1), ...sales("c", 1)],
      purchaseOrders: [{ id: "p", poNumber: "PO-1", status: "sent", supplierName: null, expectedDeliveryDate: null, items: [{ variantId: "b", onOrder: 20 }] }],
    });
    const state = Object.fromEntries(v.rows.map((r) => [r.variantId, r.state]));
    expect(state).toEqual({ a: "reorder", b: "on_order", c: "ok" });
    expect(v.reorderNow).toBe(1);
    expect(v.openOrders).toEqual([{ id: "p", poNumber: "PO-1", status: "sent", supplierName: null, expected: null, units: 20, variants: 1 }]);
  });

  it("counts an empty shelf as out only for a variant that has been selling", () => {
    const v = view({ variants: [variant("a", { stock: 0 }), variant("dead", { stock: 0 })], sales: sales("a", 2) });
    expect(v.outNow).toBe(1);
    expect(v.rows.map((r) => [r.variantId, r.state])).toEqual([["a", "out"], ["dead", "not_selling"]]);
  });

  it("values stock at cost exactly, counting variants with no cost instead of guessing", () => {
    const v = view({ variants: [variant("a", { stock: 3, unitCost: pkr("1250.50") }), variant("b", { stock: 2, unitCost: null }), variant("c", { stock: 0 })] });
    expect(v.stockValue).toEqual(pkr("3751.50"));
    expect(v.uncosted).toBe(1);
  });

  it("counts days that opened with no stock, within the period only", () => {
    const v = view({
      variants: [variant("a")],
      snapshots: [
        { variantId: "a", date: "2026-09-01", stock: 0 },
        { variantId: "a", date: "2026-10-01", stock: 0 },
        { variantId: "a", date: "2026-10-02", stock: 4 },
      ],
    });
    expect(v.rows[0]).toMatchObject({ daysOut: 1, daysSnapshotted: 2 });
  });

  it("leaves archived variants out, and sorts by urgency then cover", () => {
    const v = view({
      variants: [variant("ok", { stock: 100 }), variant("gone", { archived: true }), variant("low", { stock: 3 }), variant("out", { stock: 0 })],
      sales: [...sales("ok", 1), ...sales("low", 1), ...sales("out", 1), ...sales("gone", 1)],
    });
    expect(v.rows.map((r) => r.variantId)).toEqual(["out", "low", "ok"]);
    expect(v.variants).toBe(3);
  });

  it("has no stock value at all when the shop's currency is unknown", () => {
    expect(view({ currency: null, variants: [variant("a")] }).stockValue).toBeNull();
  });

  it("does not call a shelf empty when the variant keeps selling off it", () => {
    const zeroDays = [1, 2, 3].map((i) => ({ variantId: "a", date: shiftDay(TODAY, -i), stock: 0 }));
    const v = view({ variants: [variant("a", { stock: 0 }), variant("b", { stock: 0 })], sales: [...sales("a", 1), ...sales("b", 1)], snapshots: zeroDays });
    const a = v.rows.find((r) => r.variantId === "a")!;
    expect(a).toMatchObject({ state: "untracked", soldAtZeroDays: 3, daysOfCover: null });
    expect(v.rows.find((r) => r.variantId === "b")!.state).toBe("out");
    expect([v.outNow, v.untracked]).toEqual([1, 1]);
  });

  it("allows a sale or two off an empty opening shelf (a restock during the day)", () => {
    const zeroDays = [1, 2].map((i) => ({ variantId: "a", date: shiftDay(TODAY, -i), stock: 0 }));
    expect(view({ variants: [variant("a", { stock: 0 })], sales: sales("a", 1), snapshots: zeroDays }).rows[0]!.state).toBe("out");
  });

  it("forgets empty-shelf sales from before the rate window (a restock since)", () => {
    const old = [31, 32, 33].map((i) => ({ variantId: "a", date: shiftDay(TODAY, -i), stock: 0 }));
    const v = view({ variants: [variant("a", { stock: 50 })], sales: sales("a", 1, 40), snapshots: old });
    expect(v.rows[0]).toMatchObject({ state: "ok", soldAtZeroDays: 0 });
  });

  it("says a stocked variant with no sale in 30 days is slow, not enough", () => {
    const v = view({ variants: [variant("a", { stock: 10 })], sales: [{ variantId: "a", date: shiftDay(TODAY, -60), units: 1 }] });
    expect(v.rows[0]).toMatchObject({ state: "slow", daysOfCover: null });
  });

  it("decodes the HTML entities Shopify titles arrive with", () => {
    expect(parseVariant({ variantId: "1", stock: 1, title: "Charging &amp; Travel Kit", variantTitle: "&quot;Red&quot;" })).toMatchObject({
      title: "Charging & Travel Kit",
      variantTitle: '"Red"',
    });
  });
});
