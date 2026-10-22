import { describe, expect, it } from "vitest";

import { RECORD_TYPES, RecordError, isBlankRow, isRecordType, toDocData, toMinor } from "./record";
import { RECORD_FORMS, accountFits } from "./record-forms";
import type { TaxRateView } from "../books/tax";

const rates: TaxRateView[] = [
  { id: "gst-in", name: "Sales tax 18% (claimable)", kind: "purchase", rateBp: 1800, accountId: "claim", archived: false },
  { id: "wht", name: "WHT on services 10%", kind: "withholding", rateBp: 1000, accountId: "wht-acc", archived: false },
];
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof RecordError ? e.field : "other";
  }
  return null;
};

describe("recording by hand", () => {
  it("amounts as typed to minor units; negatives only where they belong", () => {
    expect(toMinor("1,250.50", 2, "amount")).toBe("125050");
    expect(toMinor(" 7 ", 2, "amount")).toBe("700");
    expect(toMinor("", 2, "amount")).toBeNull();
    expect(toMinor("−300", 2, "received", true)).toBe("-30000");
    expect(err(() => toMinor("-3", 2, "lines.0.amount"))).toBe("lines.0.amount");
    expect(err(() => toMinor("12.345", 2, "lines.1.amount"))).toBe("lines.1.amount");
  });

  it("a line's tax is worked out on its amount and snapshotted; tax withheld from the rate", () => {
    const data = toDocData("expense", { paidFrom: "bank", lines: [{ accountId: "pack", amount: "1000", description: "", taxRateId: "gst-in" }], withheld: { rateId: "wht", amount: "" } }, 2, rates);
    expect(data).toEqual({
      paidFrom: "bank",
      lines: [{ accountId: "pack", amount: "100000", description: "", tax: { rateId: "gst-in", name: "Sales tax 18% (claimable)", rateBp: 1800, accountId: "claim", amount: "18000" } }],
      withheld: { accountId: "wht-acc", amount: "10000", rateId: "wht", name: "WHT on services 10%", rateBp: 1000 },
    });
    // A typed withholding amount wins over the rate's.
    expect(toDocData("expense", { paidFrom: "b", lines: [{ accountId: "x", amount: "1000" }], withheld: { rateId: "wht", amount: "95" } }, 2, rates).withheld).toMatchObject({ amount: "9500" });
    expect(toDocData("expense", { paidFrom: "b", lines: [{ accountId: "x", amount: "1000" }], withheld: null }, 2, rates).withheld).toBeNull();
  });

  it("each mistake names its field", () => {
    expect(err(() => toDocData("expense", { paidFrom: "b", lines: [{ accountId: "x", amount: "10", taxRateId: "gone" }] }, 2, rates))).toBe("lines.0.taxRateId");
    expect(err(() => toDocData("expense", { paidFrom: "b", lines: [{ accountId: "x", amount: "10" }], withheld: { rateId: "gst-in", amount: "" } }, 2, rates))).toBe("withheld.rateId");
    expect(err(() => toDocData("manual", { lines: [{ accountId: "a", debit: "ten" }] }, 2, rates))).toBe("lines.0.debit");
  });

  it("a courier's invoice and kept-back money may be negative; nothing else may", () => {
    expect(toDocData("courier_payout", { receivable: "r", receivedIn: "b", received: "-300", deductions: [{ accountId: "d", amount: "-50" }] }, 2, rates)).toMatchObject({ received: "-30000", deductions: [{ amount: "-5000" }] });
    expect(err(() => toDocData("transfer", { from: "a", to: "b", amount: "-1" }, 2, rates))).toBe("amount");
  });

  it("blank rows are the form's to drop; every type has a form; account choices fit the field", () => {
    expect(isBlankRow({ key: "3", accountId: "", amount: " ", description: "" })).toBe(true);
    expect(isBlankRow({ key: "3", accountId: "x", amount: "" })).toBe(false);
    for (const t of RECORD_TYPES) expect(RECORD_FORMS[t.type], t.type).toBeDefined();
    expect(isRecordType("expense")).toBe(true);
    expect(isRecordType("sales_summary")).toBe(false);
    const bank = { type: "asset", subtype: "bank", name: "Meezan", money: true };
    const stock = { type: "asset", subtype: "stock", name: "Stock", money: false };
    const owed = { type: "asset", subtype: "receivable", name: "Owed by couriers", money: false };
    expect(accountFits("money", bank)).toBe(true);
    expect(accountFits("cost", stock)).toBe(true);
    expect(accountFits("cost", owed)).toBe(false);
    expect(accountFits("receivable", owed)).toBe(true);
  });
});
