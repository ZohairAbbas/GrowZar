import { describe, expect, it } from "vitest";

import { profitAfterReturns, type Bucket } from "../metrics/rollups";
import { decimalToMinor } from "../books/connectors/shopify-sales";
import { booksRows, classifyAccounts, compareRows, financeRows, sameish, type CompareAccount } from "./compare-finance";

const accounts: CompareAccount[] = [
  { id: "sales", code: "4000", name: "Sales", type: "income", systemKey: null },
  { id: "ship", code: "4010", name: "Shipping charged", type: "income", systemKey: null },
  { id: "held", code: "4050", name: "COD sales held back", type: "income", systemKey: null },
  { id: "cogs", code: "5000", name: "Cost of what you sold", type: "expense", systemKey: "cogs" },
  { id: "deliv", code: "5010", name: "Delivery charges", type: "expense", systemKey: null },
  { id: "unexp", code: "5011", name: "Courier charges not explained", type: "expense", systemKey: null },
  { id: "gw", code: "5040", name: "Payment gateway fees", type: "expense", systemKey: null },
  { id: "ads", code: "6000", name: "Advertising", type: "expense", systemKey: null },
  { id: "rent", code: "6020", name: "Rent", type: "expense", systemKey: null },
  { id: "owed", code: "1200", name: "Owed by couriers", type: "asset", systemKey: null },
];

describe("Books next to Finance (B6, D-69)", () => {
  const classes = classifyAccounts(accounts, { salesAccounts: ["sales", "ship", "held"], cogs: "cogs", adAccounts: ["ads"], courierAccounts: ["deliv"] });

  it("every income and expense account lands on one row; nothing else does", () => {
    expect(Object.fromEntries(classes)).toEqual({ sales: "sales", ship: "sales", held: "sales", cogs: "cogs", deliv: "courier", unexp: "courier", gw: "payment", ads: "ads", rent: "other" });
  });

  it("the Books column adds up to the store's profit, with entries for the whole business on their own row", () => {
    // Ledger sign: income credit (−), costs debit (+).
    const store = new Map([["sales", -100_000n], ["ship", -5_000n], ["cogs", 40_000n], ["deliv", 6_000n], ["ads", 20_000n], ["owed", 105_000n]]);
    const none = new Map([["rent", 15_000n]]);
    const b = booksRows(classes, store, none);
    expect(b).toMatchObject({ sales: 105_000n, cogs: -40_000n, courier: -6_000n, ads: -20_000n, unassigned: -15_000n, other: 0n });
    expect(Object.values(b).reduce((s, v) => s + v, 0n)).toBe(105_000n - 40_000n - 6_000n - 20_000n - 15_000n);
  });

  it("Finance's rows add up to Finance's own profit", () => {
    const bucket = {
      placed: [{ amount: "1500.00", currency: "PKR" }],
      deliveredRevenue: [{ amount: "1180.00", currency: "PKR" }],
      cogsDelivered: [{ amount: "400.00", currency: "PKR" }],
      courierFees: [{ amount: "150.00", currency: "PKR" }],
      otherCosts: { orders: 1, payment: [{ amount: "10.50", currency: "PKR" }], shipping: [{ amount: "20.00", currency: "PKR" }], taxes: [{ amount: "180.00", currency: "PKR" }], custom: [{ amount: "5.00", currency: "PKR" }] },
      deliveryRate: { stillOpen: 0, partial: 0 },
      shippedOrdersWithoutFee: 0,
      shippedOrders: 1,
      cogsIncompleteOrders: 0,
    } as unknown as Bucket;
    const p = profitAfterReturns(bucket, "PKR", [{ amount: "100.00", currency: "PKR" }]);
    const f = financeRows(p.parts, (s) => decimalToMinor(s, 2));
    expect(f.net).toBe(decimalToMinor(p.amount, 2));
    expect(f.rows).toMatchObject({ sales: 118_000n, cogs: -40_000n, courier: -17_000n, ads: -10_000n, payment: -1_050n, taxes: -18_000n, other: -500n, unassigned: 0n });
  });

  it("rows carry both figures and the difference; a rupee either way is the same", () => {
    const rows = compareRows({ sales: 100n, cogs: 0n, courier: 0n, ads: 0n, payment: 0n, taxes: -18n, other: 0n, unassigned: 0n }, { sales: 90n, cogs: 0n, courier: 0n, ads: 0n, payment: 0n, taxes: 0n, other: 0n, unassigned: -5n });
    expect(rows.find((r) => r.key === "sales")).toMatchObject({ finance: 100n, books: 90n, difference: -10n });
    expect(rows.map((r) => r.key)).toEqual(["sales", "cogs", "courier", "ads", "payment", "taxes", "other", "unassigned"]);
    expect(sameish(10_000n, 10_099n, 2)).toBe(true);
    expect(sameish(10_000n, 10_101n, 2)).toBe(false);
  });
});
