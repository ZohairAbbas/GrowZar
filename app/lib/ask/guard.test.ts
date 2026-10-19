import { describe, expect, it } from "vitest";

import { guard, mask, MAX_ROWS } from "./guard";
import { FAKE_BUYER } from "./test-fixtures";
import type { ToolResult } from "./types";

const result = (o: Partial<ToolResult> = {}): ToolResult => ({
  tool: "t",
  status: "ok",
  title: "t",
  columns: [
    { key: "label", label: "City", kind: "text" },
    { key: "orders", label: "Orders", kind: "count" },
    { key: "profit", label: "Profit", kind: "money", currency: "PKR" },
    { key: "margin", label: "Margin", kind: "percent", money: true },
  ],
  rows: [{ label: "Lahore", orders: 3, profit: 120.5, margin: 12.5 }],
  meta: { stores: [{ id: "s1", name: "Shop" }], currency: "PKR", rules: [], gaps: [], notes: [] },
  link: null,
  ...o,
});

describe("guard", () => {
  it("drops money and money-derived columns for a viewer without Finance", () => {
    const g = guard(result(), false);
    expect(g.columns.map((c) => c.key)).toEqual(["label", "orders"]);
    expect(g.rows).toEqual([{ label: "Lahore", orders: 3 }]);
    expect(g.meta.currency).toBeUndefined();
  });

  it("keeps them for a viewer with Finance", () => {
    expect(guard(result(), true).rows[0]).toEqual({ label: "Lahore", orders: 3, profit: 120.5, margin: 12.5 });
  });

  it("drops any column named like a buyer's identity, whatever the role", () => {
    const g = guard(
      result({
        columns: [
          { key: "label", label: "City", kind: "text" },
          { key: "customerName", label: "Buyer", kind: "text" },
          { key: "x", label: "Phone", kind: "text" },
          { key: "email", label: "Contact", kind: "text" },
        ],
        rows: [{ label: "Lahore", customerName: FAKE_BUYER.name, x: FAKE_BUYER.phone, email: FAKE_BUYER.email, customer_id: "c1" }],
      }),
      true,
    );
    expect(g.columns.map((c) => c.key)).toEqual(["label"]);
    expect(g.rows).toEqual([{ label: "Lahore" }]);
  });

  it("masks emails and phone numbers in any text", () => {
    expect(mask(`call ${FAKE_BUYER.phone} or +92 300 1234567 or mail ${FAKE_BUYER.email}`)).toBe("call [phone removed] or [phone removed] or mail [email removed]");
    expect(mask("923001234567 wrote")).toBe("[phone removed] wrote");
    // Order names, amounts and a 14-digit variant id are not phones.
    expect(mask("#1234 for 3,000.00 PKR, variant 45678901234567")).toBe("#1234 for 3,000.00 PKR, variant 45678901234567");
    const g = guard(result({ meta: { stores: [], rules: [], gaps: [], notes: [`buyer ${FAKE_BUYER.email}`] } }), true);
    expect(g.meta.notes).toEqual(["buyer [email removed]"]);
  });

  it("caps rows and says so", () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ label: `c${i}`, orders: i }));
    const g = guard(result({ rows }), true);
    expect(g.rows).toHaveLength(MAX_ROWS);
    expect(g.meta.truncated).toEqual({ shown: MAX_ROWS, total: 80 });
  });
});

describe("links that name a store", async () => {
  const { rememberLinkedStore } = await import("../store-cookie.server");
  it("remembers a visible store and reloads the screen without the parameter", () => {
    const r = rememberLinkedStore(new URL("http://x/shipping?store=s1&days=30&city=Lahore"), [{ id: "s1" }])!;
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/shipping?days=30&city=Lahore");
    expect(r.headers.get("Set-Cookie")).toMatch(/^growzar_store=s1;/);
  });
  it("ignores a store outside the viewer's scope, setting nothing", () => {
    const r = rememberLinkedStore(new URL("http://x/home?store=other"), [{ id: "s1" }])!;
    expect(r.headers.get("Location")).toBe("/home");
    expect(r.headers.get("Set-Cookie")).toBeNull();
  });
  it("does nothing without the parameter", () => {
    expect(rememberLinkedStore(new URL("http://x/home?days=7"), [{ id: "s1" }])).toBeNull();
  });
});
