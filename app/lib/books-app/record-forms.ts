/**
 * What each "Record" form asks for (B4). One screen draws every form from
 * this list; the posting engine (posting.ts) decides whether it posts. Plain
 * words for owners, as Financify's forms (porting guide §7).
 */
import type { RecordType } from "./record";

export type AccountFilter = "money" | "cost" | "income" | "any" | "receivable" | "payable" | "tax" | "incomeOnly" | "expenseOnly";

export type FieldSpec =
  | { kind: "account"; key: string; label: string; filter: AccountFilter; default?: "lastPaidFrom" | "lastReceivedIn" | "owedByCouriers" | "payables" | "returns" | "shortfall"; help?: string }
  | { kind: "amount"; key: string; label: string; signed?: boolean; help?: string }
  | { kind: "text"; key: string; label: string; help?: string }
  | { kind: "date"; key: string; label: string; help?: string }
  | { kind: "choice"; key: string; label: string; options: Array<{ value: string; label: string }> }
  | { kind: "lines"; key: "lines" | "deductions"; label: string; filter: AccountFilter; taxKind?: "purchase" | "sales"; signed?: boolean }
  | { kind: "journal"; label: string }
  | { kind: "taxLines"; label: string }
  | { kind: "allocations"; label: string }
  | { kind: "parcels"; label: string }
  | { kind: "withheld"; label: string };

export interface FormSpec {
  /** Who it's with: required for bills, optional otherwise, or not asked. */
  contact?: { kind: "supplier" | "courier" | "customer"; required: boolean; label: string };
  fields: FieldSpec[];
}

export const RECORD_FORMS: Record<RecordType, FormSpec> = {
  expense: {
    contact: { kind: "supplier", required: false, label: "Paid to (optional)" },
    fields: [
      { kind: "account", key: "paidFrom", label: "Paid from", filter: "money", default: "lastPaidFrom" },
      { kind: "lines", key: "lines", label: "What for", filter: "cost", taxKind: "purchase" },
      { kind: "withheld", label: "Tax you withheld from them" },
    ],
  },
  money_in: {
    contact: { kind: "customer", required: false, label: "From (optional)" },
    fields: [
      { kind: "account", key: "receivedIn", label: "Received in", filter: "money", default: "lastReceivedIn" },
      { kind: "lines", key: "lines", label: "What for", filter: "income", taxKind: "sales" },
    ],
  },
  bill: {
    contact: { kind: "supplier", required: true, label: "Supplier" },
    fields: [
      { kind: "account", key: "payable", label: "Owed in", filter: "payable", default: "payables" },
      { kind: "text", key: "reference", label: "Their bill number", help: "Books refuses the same number twice from one supplier." },
      { kind: "date", key: "dueDate", label: "Due on" },
      { kind: "lines", key: "lines", label: "What for", filter: "cost", taxKind: "purchase" },
    ],
  },
  bill_payment: {
    contact: { kind: "supplier", required: true, label: "Supplier" },
    fields: [
      { kind: "account", key: "payable", label: "Owed in", filter: "payable", default: "payables" },
      { kind: "account", key: "paidFrom", label: "Paid from", filter: "money", default: "lastPaidFrom" },
      { kind: "allocations", label: "Which bills" },
      { kind: "withheld", label: "Tax you withheld from them" },
    ],
  },
  supplier_credit: {
    contact: { kind: "supplier", required: true, label: "Supplier" },
    fields: [
      { kind: "account", key: "payable", label: "Owed in", filter: "payable", default: "payables" },
      { kind: "text", key: "reference", label: "Their credit note number" },
      { kind: "lines", key: "lines", label: "What for", filter: "cost" },
    ],
  },
  courier_payout: {
    contact: { kind: "courier", required: false, label: "Courier" },
    fields: [
      { kind: "account", key: "receivable", label: "Owed by", filter: "receivable", default: "owedByCouriers" },
      { kind: "account", key: "receivedIn", label: "Arrived in", filter: "money", default: "lastReceivedIn" },
      { kind: "amount", key: "received", label: "What arrived", signed: true, help: "Negative for a courier's invoice you paid." },
      { kind: "lines", key: "deductions", label: "What the courier kept", filter: "cost", signed: true },
    ],
  },
  parcel_writeoff: {
    contact: { kind: "courier", required: false, label: "Courier" },
    fields: [
      {
        kind: "choice",
        key: "reason",
        label: "Why",
        options: [
          { value: "lost", label: "Lost: the sale didn't happen" },
          { value: "short_paid", label: "Paid short: the courier paid less than it owed" },
        ],
      },
      { kind: "account", key: "receivable", label: "Owed by", filter: "receivable", default: "owedByCouriers" },
      { kind: "account", key: "account", label: "Comes off", filter: "incomeOnly", default: "returns", help: "Returns for a lost parcel; for one paid short, leave it to Books (\"Courier shortfalls\") or choose a cost." },
      { kind: "parcels", label: "Parcels" },
    ],
  },
  tax_payment: {
    fields: [
      { kind: "account", key: "paidFrom", label: "Paid from", filter: "money", default: "lastPaidFrom" },
      { kind: "taxLines", label: "Settles" },
    ],
  },
  transfer: {
    fields: [
      { kind: "account", key: "from", label: "From", filter: "money" },
      { kind: "account", key: "to", label: "To", filter: "money" },
      { kind: "amount", key: "amount", label: "Amount" },
    ],
  },
  owner_in: {
    fields: [
      { kind: "account", key: "to", label: "Into", filter: "money" },
      { kind: "amount", key: "amount", label: "Amount" },
    ],
  },
  owner_out: {
    fields: [
      { kind: "account", key: "from", label: "From", filter: "money" },
      { kind: "amount", key: "amount", label: "Amount" },
    ],
  },
  manual: { fields: [{ kind: "journal", label: "Lines" }] },
};

/** Which accounts a field offers. */
export function accountFits(filter: AccountFilter, a: { type: string; subtype: string; name: string; money: boolean }): boolean {
  switch (filter) {
    case "money":
      return a.money;
    case "cost":
      return a.type === "expense" || (a.type === "asset" && !a.money && a.subtype !== "receivable");
    case "income":
      return a.type === "income" || a.type === "liability";
    case "receivable":
      return a.type === "asset" && a.subtype === "receivable";
    case "payable":
      return a.type === "liability" && a.subtype === "payable";
    case "tax":
      return a.subtype === "tax";
    case "incomeOnly":
      return a.type === "income";
    case "expenseOnly":
      return a.type === "expense";
    default:
      return true;
  }
}
