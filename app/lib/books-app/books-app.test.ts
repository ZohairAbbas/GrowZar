import { describe, expect, it } from "vitest";

import { booksServerOn, canClosePeriod, scopeAllowsBooks } from "./access";
import { storeCoverage } from "./coverage";
import { checkSetup, fiscalYearStartOn, planStores, rateToBp, sharedTimeZone, type SetupInput, type SetupStore } from "./setup";

const stores: SetupStore[] = [
  { id: "a", name: "Store A", currency: "PKR", timezone: "Asia/Karachi" },
  { id: "b", name: "Store B", currency: "PKR", timezone: "Asia/Karachi" },
  { id: "c", name: "Store C", currency: "AED", timezone: "Asia/Dubai" },
  { id: "d", name: "Store D", currency: null, timezone: null },
];

const input = (patch: Partial<SetupInput> = {}): SetupInput => ({
  startDate: "2026-07-01",
  fiscalYearStartMonth: 7,
  timeZone: "Asia/Karachi",
  codBasis: "delivery",
  storeIds: ["a", "b"],
  moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: "1,250,000.50" }],
  taxRates: [{ name: "Sales tax 18%", kind: "sales", rate: "18" }],
  ...patch,
});
const ctx = { currency: "PKR", today: "2026-10-22", stores, timeZones: ["Asia/Karachi"] };

describe("who may use Books (D-70, D-81, D-91)", () => {
  it("the server switch reads like Ask's", () => {
    expect(booksServerOn("on")).toBe(true);
    expect(booksServerOn(" TRUE ")).toBe(true);
    expect(booksServerOn(undefined)).toBe(false);
    expect(booksServerOn("off")).toBe(false);
  });
  it("only members scoped to every store", () => {
    expect(scopeAllowsBooks(null)).toBe(true);
    expect(scopeAllowsBooks(["a", "b"])).toBe(false);
    expect(scopeAllowsBooks([])).toBe(false);
  });
  it("only owners and admins close a period, whatever else they hold", () => {
    expect(canClosePeriod("owner")).toBe(true);
    expect(canClosePeriod("admin")).toBe(true);
    expect(canClosePeriod("accountant,admin")).toBe(true);
    expect(canClosePeriod("accountant")).toBe(false);
    expect(canClosePeriod("manager")).toBe(false);
  });
});

describe("setup", () => {
  it("one currency: other currencies and unknown ones are left out with the reason (D-89)", () => {
    const plan = planStores(stores, "PKR");
    expect(plan.included.map((s) => s.id)).toEqual(["a", "b"]);
    expect(plan.excluded.map((s) => [s.id, s.reason])).toEqual([
      ["c", "Its sales are in AED; Books keeps one currency (PKR) for now."],
      ["d", "Growzar doesn't know this store's currency yet."],
    ]);
  });

  it("the stores' shared time zone, or none when they differ (D-90)", () => {
    expect(sharedTimeZone(stores.slice(0, 2))).toBe("Asia/Karachi");
    expect(sharedTimeZone(stores)).toBeNull();
    expect(sharedTimeZone([stores[3]!])).toBeNull();
  });

  it("starts on the first day of the current fiscal year (D-75)", () => {
    expect(fiscalYearStartOn("2026-10-22", 7)).toBe("2026-07-01");
    expect(fiscalYearStartOn("2026-03-05", 7)).toBe("2025-07-01");
    expect(fiscalYearStartOn("2026-07-01", 7)).toBe("2026-07-01");
    expect(fiscalYearStartOn("2026-10-22", 1)).toBe("2026-01-01");
  });

  it("rates are percentages, in basis points", () => {
    expect(rateToBp("18")).toBe(1800);
    expect(rateToBp("4.5")).toBe(450);
    expect(rateToBp("4.5%")).toBe(450);
    expect(rateToBp("0.25")).toBe(25);
    expect(rateToBp("abc")).toBeNull();
    expect(rateToBp("4.555")).toBeNull();
  });

  it("a good setup becomes a plan with amounts in minor units", () => {
    const plan = checkSetup(input(), ctx);
    expect(plan).toMatchObject({
      currency: "PKR",
      codBasis: "delivery",
      storeIds: ["a", "b"],
      moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 125_000_050n }],
      taxRates: [{ name: "Sales tax 18%", kind: "sales", rateBp: 1800 }],
    });
  });

  it("empty money rows are skipped; a negative balance is kept (a card in credit)", () => {
    const plan = checkSetup(input({ moneyAccounts: [{ subtype: "cash", name: "", opening: "" }, { subtype: "card", name: "Card", opening: "-500" }] }), ctx);
    expect("moneyAccounts" in plan && plan.moneyAccounts).toEqual([{ subtype: "card", name: "Card", opening: -50_000n }]);
  });

  it("each mistake names its field", () => {
    const err = (patch: Partial<SetupInput>) => (checkSetup(input(patch), ctx) as { field: string }).field;
    expect(err({ startDate: "2026-11-01" })).toBe("startDate");
    expect(err({ startDate: "2024-01-01" })).toBe("startDate");
    expect(err({ startDate: "nope" })).toBe("startDate");
    expect(err({ fiscalYearStartMonth: 13 })).toBe("fiscalYearStartMonth");
    expect(err({ timeZone: "Asia/Dubai" })).toBe("timeZone");
    expect(err({ codBasis: "whenever" })).toBe("codBasis");
    expect(err({ storeIds: [] })).toBe("storeIds");
    expect(err({ storeIds: ["a", "c"] })).toBe("storeIds");
    expect(err({ moneyAccounts: [] })).toBe("moneyAccounts");
    expect(err({ moneyAccounts: [{ subtype: "bank", name: "", opening: "10" }] })).toBe("moneyAccounts.0.name");
    expect(err({ moneyAccounts: [{ subtype: "bank", name: "X", opening: "ten" }] })).toBe("moneyAccounts.0.opening");
    expect(err({ moneyAccounts: [{ subtype: "loan", name: "X", opening: "" }] })).toBe("moneyAccounts.0.subtype");
    expect(err({ taxRates: [{ name: "GST", kind: "sales", rate: "x" }] })).toBe("taxRates.0.rate");
    expect(err({ taxRates: [{ name: "GST", kind: "vat", rate: "5" }] })).toBe("taxRates.0.kind");
    expect(err({ taxRates: [{ name: "GST", kind: "sales", rate: "5" }, { name: "gst", kind: "sales", rate: "6" }] })).toBe("taxRates.1.name");
  });
});

describe("where entries come from (D-66, D-78, D-90)", () => {
  const status = (connections: Parameters<typeof storeCoverage>[0]) => Object.fromEntries(storeCoverage(connections).map((c) => [c.source, c.status.kind]));
  const conn = (app: "FINANCIFY" | "COURIERIFY" | "INVENTORIFY", capabilities: string[] = [], s = "CONNECTED") => ({ app, status: s, capabilities });

  it("all three apps: everything automatic but the bank", () => {
    expect(status([conn("FINANCIFY"), conn("COURIERIFY"), conn("INVENTORIFY", ["receipts:read", "supplier-ledger:read"])])).toEqual({
      sales: "auto",
      cost: "auto",
      courier_payouts: "auto",
      ad_spend: "auto",
      goods_received: "auto",
      bank: "by_hand",
    });
  });

  it("no apps: install nudges, and cost from Books' own list", () => {
    expect(status([])).toEqual({ sales: "missing", cost: "by_hand", courier_payouts: "missing", ad_spend: "missing", goods_received: "missing", bank: "by_hand" });
  });

  it("cost falls back to Inventorify's unit cost; an old Inventorify needs an update", () => {
    const rows = storeCoverage([conn("INVENTORIFY")]);
    expect(rows.find((r) => r.source === "cost")?.status).toMatchObject({ kind: "auto", app: "INVENTORIFY" });
    expect(rows.find((r) => r.source === "goods_received")?.status.kind).toBe("update");
  });

  it("a disconnected app counts as missing", () => {
    expect(status([conn("FINANCIFY", [], "DISCONNECTED")]).sales).toBe("missing");
  });
});
