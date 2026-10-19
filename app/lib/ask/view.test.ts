import { describe, expect, it } from "vitest";

import { cellText, chartOf, drawn, shownColumns, spansOf } from "./view";
import type { ToolResult } from "./types";

const r = (o: Partial<ToolResult>): ToolResult => ({ tool: "breakdown", status: "ok", title: "Orders by city", columns: [], rows: [], meta: { stores: [], rules: [], gaps: [], notes: [] }, link: null, ...o });

describe("cellText", () => {
  it("prints figures as the screens do, and an empty value as a dash, never a zero", () => {
    expect(cellText({ key: "p", label: "Profit", kind: "money", currency: "PKR" }, -36877.29)).toBe("PKR −36,877.29");
    expect(cellText({ key: "r", label: "Rate", kind: "percent" }, 93.25)).toBe("93.3%");
    expect(cellText({ key: "c", label: "Change", kind: "points" }, 2.6)).toBe("+2.6 pts");
    expect(cellText({ key: "o", label: "Orders", kind: "count" }, 1710)).toBe("1,710");
    expect(cellText({ key: "r", label: "Rate", kind: "percent" }, null)).toBe("—");
  });
});

describe("tables and charts", () => {
  const cities = r({
    columns: [
      { key: "key", label: "Key", kind: "text" },
      { key: "label", label: "City", kind: "text" },
      { key: "delivery_rate", label: "Delivery rate", kind: "percent" },
      { key: "decided", label: "Decided", kind: "count" },
    ],
    rows: [
      { key: "Lahore", label: "Lahore", delivery_rate: 93.2, decided: 74 },
      { key: "Multan", label: "Multan", delivery_rate: null, decided: 5 },
      { key: "Karachi", label: "Karachi", delivery_rate: 89, decided: 82 },
    ],
  });

  it("hides the id column behind the label", () => {
    expect(shownColumns(cities).map((c) => c.key)).toEqual(["label", "delivery_rate", "decided"]);
  });

  it("charts one figure, keeping a missing value as a gap", () => {
    const c = chartOf(cities)!;
    expect(c.value.key).toBe("delivery_rate");
    expect(c.points).toEqual([
      { label: "Lahore", value: 93.2 },
      { label: "Multan", value: null },
      { label: "Karachi", value: 89 },
    ]);
    expect(c.time).toBe(false);
    expect(chartOf(r({ ...cities, title: "Orders by week" }))!.time).toBe(true);
  });

  it("draws no chart for one row or a refusal, and no card for the store list", () => {
    expect(chartOf(r({ ...cities, rows: cities.rows.slice(0, 1) }))).toBeNull();
    expect(chartOf(r({ ...cities, status: "forbidden" }))).toBeNull();
    expect(drawn(r({ ...cities, tool: "list_stores" }))).toBe(false);
    expect(drawn(cities)).toBe(true);
  });
});

describe("spansOf", () => {
  it("reads bold and table citations and nothing else", () => {
    expect(spansOf("Lahore is **93.2%** (table 1), <b>not</b> html")).toEqual([
      { text: "Lahore is " },
      { text: "93.2%", bold: true },
      { text: " " },
      { text: "(table 1)", table: 1 },
      { text: ", <b>not</b> html" },
    ]);
  });
});
