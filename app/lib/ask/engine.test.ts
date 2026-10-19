import { describe, expect, it } from "vitest";

import { profitTable } from "../metrics/profit-table";
import { bucketOf, profitAfterReturns } from "../metrics/rollups";
import { breakdownTable, mergeRaws, rawGroups, unsupported, valueOf, weekOf, type StoreSlice } from "./engine";
import { month, order, times } from "./test-fixtures";

const slice = (rows = month(), o: Partial<StoreSlice> = {}): StoreSlice => ({
  storeId: "s1",
  currency: "PKR",
  period: { from: "2026-09-20", to: "2026-10-19" },
  rows,
  profit: profitAfterReturns(bucketOf("s1", rows), "PKR", null),
  ...o,
});

describe("rawGroups and valueOf", () => {
  it("counts and rates a dimension as the screens' roll-up does", () => {
    const g = rawGroups(slice(), "city");
    const lahore = g.get("Lahore")!;
    expect(valueOf("orders", lahore)).toBe(43);
    expect(valueOf("delivered", lahore)).toBe(30);
    expect(valueOf("returned", lahore)).toBe(10);
    expect(valueOf("still_open", lahore)).toBe(3);
    expect(valueOf("delivery_rate", lahore)).toBe(75);
    expect(valueOf("return_rate", lahore)).toBe(25);
    expect(valueOf("delivered_revenue", lahore)).toBe(30000);
  });

  it("has no rate under 20 decided orders, never a zero", () => {
    const g = rawGroups(slice([...times(5, () => order()), ...times(2, () => order({ outcome: "returned", delivered: null }))]), "none");
    expect(valueOf("delivery_rate", g.get("total")!)).toBeNull();
    expect(valueOf("orders", g.get("total")!)).toBe(7);
  });

  it("gives the total row the headline profit", () => {
    const s = slice();
    const g = rawGroups(s, "none");
    expect(valueOf("profit", g.get("total")!)).toBe(Number(s.profit!.amount));
  });

  it("splits product money by line value, from Finance's product tab, and adds up to the headline", () => {
    const rows = [
      ...month(),
      order({
        lines: [
          { variantId: "11", productId: "1", title: "Lawn Suit", variantTitle: "Red", quantity: 1, value: { amount: "700.00", currency: "PKR" }, cost: { amount: "300.00", currency: "PKR" } },
          { variantId: "22", productId: "2", title: "Dupatta", variantTitle: null, quantity: 2, value: { amount: "300.00", currency: "PKR" }, cost: { amount: "100.00", currency: "PKR" } },
        ],
      }),
    ];
    const s = slice(rows);
    const table = profitTable("product", { rows, currency: "PKR", ads: null, maxRows: Infinity });
    const g = rawGroups({ ...s, profitBy: { product: table, city: table, courier: table, campaign: table } }, "variant");
    const dupatta = g.get("22")!;
    expect(valueOf("delivered_revenue", dupatta)).toBe(300);
    expect(valueOf("product_cost", dupatta)).toBe(100);
    expect(valueOf("units", dupatta)).toBe(2);
    const total = [...g.values()].reduce((a, r) => a + (valueOf("profit", r) ?? 0), 0);
    expect(total).toBeCloseTo(Number(s.profit!.amount), 2);
  });

  it("groups by product (all its variants) as well as by variant", () => {
    const rows = [order(), order({ lines: [{ variantId: "12", productId: "1", title: "Lawn Suit", variantTitle: "Blue", quantity: 3, value: null, cost: null }] })];
    const g = rawGroups(slice(rows), "product");
    expect([...g.keys()]).toEqual(["product:1"]);
    expect(valueOf("units", g.get("product:1")!)).toBe(4);
  });

  it("tells a first order from a repeat one by the buyer's first order ever", () => {
    const first = new Date("2026-10-01T00:00:00Z");
    const rows = [order({ customerId: "a", createdAt: first }), order({ customerId: "a" }), order({ customerId: null })];
    const g = rawGroups(slice(rows, { firstOrderAt: new Map([["a", first]]) }), "buyer_type");
    expect(valueOf("orders", g.get("first")!)).toBe(1);
    expect(valueOf("orders", g.get("repeat")!)).toBe(1);
    expect(valueOf("orders", g.get("no_buyer")!)).toBe(1);
  });

  it("puts days into 7-day blocks ending on the period's last day", () => {
    const week = weekOf("2026-09-20", "2026-10-19");
    expect(week("2026-10-19")).toBe("2026-10-13 to 2026-10-19");
    expect(week("2026-10-12")).toBe("2026-10-06 to 2026-10-12");
    expect(week("2026-09-20")).toBe("2026-09-20 to 2026-09-21");
  });
});

describe("unsupported pairs", () => {
  it("refuses per-order money by product, and profit by day", () => {
    expect(unsupported("refunded", "variant")).toMatch(/per order/);
    expect(unsupported("aov", "product")).toMatch(/per order/);
    expect(unsupported("profit", "day")).toMatch(/only by product, city, courier or campaign/);
    expect(unsupported("profit", "city")).toBeNull();
    expect(unsupported("delivery_rate", "week")).toBeNull();
  });
});

describe("mergeRaws", () => {
  it("adds stores' counts, and recomputes the rate from the sums", () => {
    const a = rawGroups(slice(), "courier");
    const b = rawGroups({ ...slice(), storeId: "s2" }, "courier");
    const m = mergeRaws([a, b], true);
    expect(valueOf("orders", m.get("leopards")!)).toBe(86);
    expect(valueOf("delivery_rate", m.get("leopards")!)).toBe(75);
    expect(valueOf("delivered_revenue", m.get("tcs")!)).toBe(50000);
  });

  it("drops money when the stores' currencies differ", () => {
    const m = mergeRaws([rawGroups(slice(), "none"), rawGroups({ ...slice(month("AED")), storeId: "s2", currency: "AED" }, "none")], false);
    expect(valueOf("delivered_revenue", m.get("total")!)).toBeNull();
    expect(valueOf("orders", m.get("total")!)).toBe(136);
  });

  it("counts a buyer of two stores twice: each store's customer is its own", () => {
    const m = mergeRaws([rawGroups(slice(), "none"), rawGroups({ ...slice(), storeId: "s2" }, "none")], false);
    expect(valueOf("buyers", m.get("total")!)).toBe(14);
  });
});

describe("breakdownTable", () => {
  it("ranks by the first metric and never ranks a row without a rate", () => {
    const rows = [...month(), ...times(5, () => order({ city: "Multan", cityRaw: "Multan" }))];
    const t = breakdownTable({ groups: rawGroups(slice(rows), "city"), dimension: "city", metrics: ["delivery_rate"], currency: "PKR", labels: {}, sort: "bottom", limit: 10 });
    expect(t.rows.map((r) => r.key)).toEqual(["Lahore", "Karachi", "Multan"]);
    expect(t.rows[2]!.delivery_rate).toBeNull();
    expect(t.notes.join(" ")).toMatch(/1 row\(s\) have under 20 decided orders/);
    // The sample travels with the rate (rule #8).
    expect(t.columns.map((c) => c.key)).toEqual(["key", "label", "delivery_rate", "decided", "still_open"]);
  });

  it("marks money columns with their currency and as money", () => {
    const t = breakdownTable({ groups: rawGroups(slice(), "courier"), dimension: "courier", metrics: ["delivered_revenue", "margin"], currency: "PKR", labels: {}, sort: "top", limit: 1 });
    expect(t.columns.find((c) => c.key === "delivered_revenue")).toMatchObject({ kind: "money", currency: "PKR", money: true });
    expect(t.columns.find((c) => c.key === "margin")).toMatchObject({ kind: "percent", money: true });
    expect(t.rows).toHaveLength(1);
    expect(t.total).toBe(2);
    expect(t.rows[0]!.label).toBe("Leopards");
  });
});

describe("only negative or positive rows", () => {
  it("keeps the rows below zero and says how many of all", () => {
    const rows = [...month(), ...times(3, () => order({ city: "Multan", cityRaw: "Multan", outcome: "returned", delivered: null }))];
    const s = slice(rows);
    const table = profitTable("city", { rows, currency: "PKR", ads: 50_000_000_000n, maxRows: Infinity });
    const t = breakdownTable({ groups: rawGroups({ ...s, profitBy: { product: table, city: table, courier: table, campaign: table } }, "city"), dimension: "city", metrics: ["profit"], currency: "PKR", labels: {}, sort: "bottom", limit: 10, only: "negative" });
    expect(t.rows.every((r) => (r.profit as number) < 0)).toBe(true);
    expect(t.notes[0]).toMatch(new RegExp(`^${t.total} of 3 rows have a negative profit`));
  });
});
