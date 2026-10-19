import { describe, expect, it } from "vitest";

import { runCalculate } from "./tools/calculate.server";
import type { AskContext, ToolResult } from "./types";

const table = (rows: ToolResult["rows"], columns: ToolResult["columns"]): ToolResult => ({ tool: "breakdown", status: "ok", title: "t", columns, rows, meta: { stores: [], rules: [], gaps: [], notes: [] }, link: null });
const cities = table(
  [
    { key: "Lahore", label: "Lahore", orders: 98, revenue: 300000, delivery_rate: 93.2 },
    { key: "Karachi", label: "Karachi", orders: 111, revenue: 200000, delivery_rate: 89 },
  ],
  [
    { key: "key", label: "Key", kind: "text" },
    { key: "label", label: "City", kind: "text" },
    { key: "orders", label: "Orders", kind: "count" },
    { key: "revenue", label: "Delivered revenue", kind: "money", currency: "PKR", money: true },
    { key: "delivery_rate", label: "Delivery rate", kind: "percent" },
  ],
);
const total = table([{ orders: 511, revenue: 781092.75 }], [{ key: "orders", label: "Orders", kind: "count" }, { key: "revenue", label: "Delivered revenue", kind: "money", currency: "PKR", money: true }]);
const aed = table([{ revenue: 1000 }], [{ key: "revenue", label: "Delivered revenue", kind: "money", currency: "AED", money: true }]);
const ctx = { tables: [cities, total, aed] } as unknown as AskContext;
const cell = (t: number, row: string | null, column: string) => ({ table: t, row, column });

describe("calculate", () => {
  it("computes a share, a difference, a ratio, a change and a sum from named cells", async () => {
    const share = await runCalculate({ op: "share", values: [cell(1, "Lahore", "orders"), cell(2, null, "orders")] }, ctx);
    expect(share.rows[0]!.value).toBe(19.2);
    expect(share.columns[1]).toMatchObject({ kind: "percent" });
    expect((await runCalculate({ op: "difference", values: [cell(1, "lahore", "delivery_rate"), cell(1, "Karachi", "delivery_rate")] }, ctx)).rows[0]!.value).toBe(4.2);
    expect((await runCalculate({ op: "ratio", values: [cell(1, "Lahore", "revenue"), cell(1, "Karachi", "revenue")] }, ctx)).rows[0]!.value).toBe(1.5);
    expect((await runCalculate({ op: "percent_change", values: [cell(1, "Karachi", "orders"), cell(1, "Lahore", "orders")] }, ctx)).rows[0]!.value).toBe(13.3);
    const sum = await runCalculate({ op: "sum", values: [cell(1, "Lahore", "revenue"), cell(1, "Karachi", "revenue")] }, ctx);
    expect(sum.rows[0]!.value).toBe(500000);
    expect(sum.columns[1]).toMatchObject({ kind: "money", currency: "PKR", money: true });
  });

  it("refuses what would be wrong: two currencies, adding rates, mixed kinds, missing cells", async () => {
    expect((await runCalculate({ op: "sum", values: [cell(2, null, "revenue"), cell(3, null, "revenue")] }, ctx)).title).toMatch(/different currencies/);
    expect((await runCalculate({ op: "sum", values: [cell(1, "Lahore", "delivery_rate"), cell(1, "Karachi", "delivery_rate")] }, ctx)).title).toMatch(/Rates can't be added/);
    expect((await runCalculate({ op: "difference", values: [cell(1, "Lahore", "orders"), cell(1, "Lahore", "revenue")] }, ctx)).title).toMatch(/like figures/);
    expect((await runCalculate({ op: "ratio", values: [cell(9, null, "orders"), cell(2, null, "orders")] }, ctx)).title).toMatch(/no table 9/);
    expect((await runCalculate({ op: "ratio", values: [cell(1, null, "orders"), cell(2, null, "orders")] }, ctx)).title).toMatch(/several rows/);
    expect((await runCalculate({ op: "ratio", values: [cell(1, "Multan", "orders"), cell(2, null, "orders")] }, ctx)).title).toMatch(/no single row/);
    expect((await runCalculate({ op: "ratio", values: [cell(1, "Lahore", "label"), cell(2, null, "orders")] }, ctx)).title).toMatch(/not a figure/);
  });
});
