import { describe, expect, it } from "vitest";

import { inventoryView, shiftDay, type DailySales, type InventoryVariant } from "./inventory";
import { MAX_STOCKOUTS, stockoutFindings } from "./stockout";

const TODAY = "2026-10-08";
const variant = (id: string, o: Partial<InventoryVariant> = {}): InventoryVariant => ({
  variantId: id, title: `Item ${id}`, variantTitle: null, sku: null, stock: 10, leadTimeDays: 10, unitCost: null, archived: false, supplierId: null, ...o,
});
const sales = (id: string, units: number): DailySales[] =>
  Array.from({ length: 30 }, (_, i) => ({ variantId: id, date: shiftDay(TODAY, -(i + 1)), units }));
/** Three purchase orders received last month: a store that reorders through Inventorify. */
const received = [1, 2, 3].map((i) => ({ id: `r${i}`, poNumber: `R${i}`, status: "received", supplierName: null, expectedDeliveryDate: null, receivedOn: shiftDay(TODAY, -10 * i), items: [] }));
const inv = (variants: InventoryVariant[], s: DailySales[], purchaseOrders = received as Parameters<typeof inventoryView>[0]["purchaseOrders"]) =>
  inventoryView({ variants, sales: s, snapshots: [], purchaseOrders, period: { from: "2026-09-09", to: TODAY }, today: TODAY, currency: "PKR", limit: Infinity });

describe("I3: stock-outs that cost sales", () => {
  it("finds a selling variant that runs out before a reorder could arrive, with the days and units short", () => {
    const f = stockoutFindings({ inventory: inv([variant("a", { stock: 4 })], sales("a", 1)), rows: [] });
    expect(f).toEqual([expect.objectContaining({ variantId: "a", situation: "runs_out", daysOfCover: 4, leadTimeDays: 10, shortDays: 6, unitsShort: 6 })]);
  });

  it("finds one that has just run out, short for its whole lead time", () => {
    const f = stockoutFindings({ inventory: inv([variant("a", { stock: 0 })], sales("a", 2)), rows: [] });
    expect(f).toEqual([expect.objectContaining({ situation: "out", shortDays: 10, unitsShort: 20 })]);
  });

  it("ignores slow sellers, stock already on order, and enough cover", () => {
    const po = { id: "p", poNumber: "PO", status: "sent", supplierName: null, expectedDeliveryDate: null, receivedOn: null, items: [{ variantId: "b", onOrder: 5 }] };
    const f = stockoutFindings({
      inventory: inv(
        [variant("slow", { stock: 1 }), variant("b", { stock: 2 }), variant("c", { stock: 100 })],
        [...sales("slow", 0).map((s, i) => ({ ...s, units: i % 3 === 0 ? 1 : 0 })), ...sales("b", 1), ...sales("c", 1)],
        [po, ...received],
      ),
      rows: [],
    });
    expect(f).toMatchObject({ kind: "skip", status: "nothing_found" });
  });

  it("says it has no data, not nothing found, before Inventorify has sent stock", () => {
    expect(stockoutFindings({ inventory: null, rows: [] })).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });

  it("keeps the few with the most units short", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const f = stockoutFindings({ inventory: inv(ids.map((id) => variant(id, { stock: 0 })), ids.flatMap((id, i) => sales(id, i + 1))), rows: [] });
    expect(Array.isArray(f) && f.map((x) => x.variantId)).toEqual(["e", "d", "c"].slice(0, MAX_STOCKOUTS));
  });

  it("forecasts only for a store that reorders through Inventorify; a stock-out shows everywhere", () => {
    const variants = [variant("low", { stock: 4 }), variant("gone", { stock: 0 })];
    const s = [...sales("low", 1), ...sales("gone", 1)];
    const elsewhere = stockoutFindings({ inventory: inv(variants, s, []), rows: [] });
    expect(Array.isArray(elsewhere) && elsewhere.map((f) => [f.variantId, f.situation])).toEqual([["gone", "out"]]);
    const through = stockoutFindings({ inventory: inv(variants, s), rows: [] });
    expect(Array.isArray(through) && through.map((f) => f.situation).sort()).toEqual(["out", "runs_out"]);
  });

  it("says how close a store is to forecasts when nothing is out", () => {
    const f = stockoutFindings({ inventory: inv([variant("low", { stock: 4 })], sales("low", 1), [received[0]!]), rows: [] });
    expect(f).toMatchObject({ kind: "skip", status: "nothing_found", reason: expect.stringMatching(/\(1 so far\)/) });
  });
});
