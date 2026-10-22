import { describe, expect, it } from "vitest";
import { decimalToMinorUnits, planLedgerEntry, planReceipt, type InvLedgerEntry, type InvReceipt } from "../connectors/inventorify";

const A = { payable: "pay", stock: "stock", awaitingClaim: "claim", purchaseDiffs: "diffs" };
const O = { currency: "PKR", decimals: 2, startDate: "2026-10-01" };
const money = (amount: string) => ({ amount, currency: "PKR" });

const receipt = (over: Partial<InvReceipt> = {}): InvReceipt => ({
  id: "rcpt_abc123456",
  poId: "po_1",
  poNumber: "PO-1001",
  supplierId: "sup_1",
  locationId: "777",
  receivedOn: "2026-10-10",
  lines: [
    { variantId: "890001", inventoryItemId: "990001", quantity: 10, quantityDamaged: 2, unitCost: money("150.00") },
    { variantId: "890002", inventoryItemId: "990002", quantity: 5, quantityDamaged: 0, unitCost: money("99.50") },
  ],
  billLedgerEntryId: "led_bill1",
  currency: "PKR",
  createdAt: "2026-10-10T09:00:00.000Z",
  ...over,
});

const entry = (over: Partial<InvLedgerEntry> = {}): InvLedgerEntry => ({
  id: "led_xyz987654",
  supplierId: "sup_1",
  kind: "adjustment",
  amount: money("500.00"),
  currency: "PKR",
  date: "2026-10-11",
  sourceKey: null,
  reference: "INV-77",
  poId: null,
  receiptId: null,
  claimId: null,
  reversalOf: null,
  createdAt: "2026-10-11T09:00:00.000Z",
  ...over,
});

describe("Inventorify amounts", () => {
  it("decimal strings to minor units, rounding half up; junk is null", () => {
    expect(decimalToMinorUnits("1234.5", 2)).toBe(123450n);
    expect(decimalToMinorUnits("-0.005", 2)).toBe(-1n);
    expect(decimalToMinorUnits("10", 0)).toBe(10n);
    expect(decimalToMinorUnits("abc", 2)).toBeNull();
    expect(decimalToMinorUnits(null, 2)).toBeNull();
  });
});

describe("goods received", () => {
  it("bills the whole quantity: good units into Stock, damaged ones awaiting the claim", () => {
    const p = planReceipt(receipt(), A, O);
    expect(p.action).toBe("post");
    if (p.action !== "post") return;
    expect(p).toMatchObject({ type: "bill", date: "2026-10-10", supplierId: "sup_1", sourceRef: "receipt:rcpt_abc123456" });
    const lines = (p.data as { lines: Array<{ accountId: string; amount: string }> }).lines;
    expect(lines).toEqual([
      expect.objectContaining({ accountId: "stock", amount: String(8 * 15000 + 5 * 9950) }),
      expect.objectContaining({ accountId: "claim", amount: String(2 * 15000) }),
    ]);
    // One PO, several deliveries: each bill's reference is different.
    expect((p.data as { reference: string }).reference).toBe("PO-1001-R123456");
    expect((p.data as { inventorify: { ledgerId: string } }).inventorify.ledgerId).toBe("led_bill1");
  });
  it("leaves out what Books can't book: before the first day, another currency, no supplier, a line with no cost", () => {
    expect(planReceipt(receipt({ receivedOn: "2026-09-30" }), A, O)).toEqual({ action: "skip", reason: "before the first day" });
    expect(planReceipt(receipt({ currency: "USD" }), A, O).action).toBe("skip");
    expect(planReceipt(receipt({ supplierId: null }), A, O)).toMatchObject({ action: "skip", reason: expect.stringMatching(/no supplier/) });
    expect(planReceipt(receipt({ lines: [{ variantId: "1", inventoryItemId: "2", quantity: 1, quantityDamaged: 0, unitCost: null }] }), A, O)).toMatchObject({ action: "skip", reason: expect.stringMatching(/without a cost/) });
  });
  it("all damaged: the whole bill waits on the claim", () => {
    const p = planReceipt(receipt({ lines: [{ variantId: "1", inventoryItemId: "2", quantity: 3, quantityDamaged: 3, unitCost: money("10") }] }), A, O);
    if (p.action !== "post") throw new Error("expected a bill");
    expect((p.data as { lines: unknown[] }).lines).toEqual([expect.objectContaining({ accountId: "claim", amount: "3000" })]);
  });
});

describe("supplier ledger", () => {
  it("a receipt's bill is skipped (the receipt posts it)", () => {
    expect(planLedgerEntry(entry({ kind: "bill", sourceKey: "receipt:rcpt_1", amount: money("1000") }), A, O)).toEqual({ action: "skip", reason: "posted with its receipt" });
  });
  it("units invoiced but never sent wait on the claim account", () => {
    const p = planLedgerEntry(entry({ kind: "bill", sourceKey: "claim:clm_1:bill", claimId: "clm_1", amount: money("300") }), A, O);
    expect(p).toMatchObject({ action: "post", type: "bill", sourceRef: "ledger:led_xyz987654" });
    if (p.action === "post") expect((p.data as { lines: Array<{ accountId: string }> }).lines[0]!.accountId).toBe("claim");
  });
  it("owe more → a bill; owe less → a supplier credit; a claim's credit clears the claim account", () => {
    const more = planLedgerEntry(entry({ amount: money("500") }), A, O);
    expect(more).toMatchObject({ action: "post", type: "bill" });
    const less = planLedgerEntry(entry({ kind: "credit_note", amount: money("-200") }), A, O);
    expect(less).toMatchObject({ action: "post", type: "supplier_credit" });
    if (less.action === "post") expect((less.data as { lines: Array<{ accountId: string; amount: string }> }).lines[0]).toMatchObject({ accountId: "diffs", amount: "20000" });
    const claimCredit = planLedgerEntry(entry({ kind: "credit_note", claimId: "clm_1", amount: money("-300") }), A, O);
    if (claimCredit.action === "post") expect((claimCredit.data as { lines: Array<{ accountId: string }> }).lines[0]!.accountId).toBe("claim");
    // References stay unique per supplier; the supplier's own goes on the line.
    if (more.action === "post") expect((more.data as { reference: string; lines: Array<{ description: string }> })).toMatchObject({ reference: "INV-987654", lines: [expect.objectContaining({ description: expect.stringContaining("INV-77") })] });
  });
  it("payments and refunds are never posted — Books is where money moves", () => {
    expect(planLedgerEntry(entry({ kind: "payment", amount: money("-1000") }), A, O)).toMatchObject({ action: "payment", entry: { kind: "payment", amount: "100000" } });
    expect(planLedgerEntry(entry({ kind: "refund", amount: money("250") }), A, O)).toMatchObject({ action: "payment", entry: { kind: "refund", amount: "25000" } });
  });
  it("a reversal names the entry it undoes", () => {
    expect(planLedgerEntry(entry({ kind: "reversal", reversalOf: "led_bill1", amount: money("-1000") }), A, O)).toMatchObject({ action: "reverse", ledgerId: "led_bill1" });
    expect(planLedgerEntry(entry({ kind: "reversal", reversalOf: null }), A, O).action).toBe("skip");
  });
});
