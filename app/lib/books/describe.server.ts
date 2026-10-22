/**
 * Plain words for a document in a list ("Packaging", "Main bank → Cash"),
 * and the list loader shared by Spending, All entries and a contact's page.
 */

import type { BkDocument } from "@prisma/client";
import { draftTotals, listAccounts, listDocuments, type BookView, type DocumentFilter } from "./books.server";
import { DOC_LABELS, type DocType } from "./posting";

export function describe(doc: Pick<BkDocument, "type" | "data">, names: Map<string, string>): string {
  const d = (doc.data ?? {}) as Record<string, any>;
  const n = (id: unknown) => (typeof id === "string" ? names.get(id) ?? "?" : "?");
  const lines = Array.isArray(d.lines) ? d.lines : [];
  switch (doc.type as DocType) {
    case "expense":
    case "money_in":
      return lines.length === 1 ? n(lines[0].accountId) : lines.length > 1 ? `${n(lines[0].accountId)} and ${lines.length - 1} more` : DOC_LABELS[doc.type as DocType];
    case "transfer":
      return `${n(d.from)} → ${n(d.to)}`;
    case "owner_in":
      return `Owner's money into ${n(d.to)}`;
    case "owner_out":
      return `Owner took from ${n(d.from)}`;
    case "opening":
      return `Opening balances (${lines.length} account${lines.length === 1 ? "" : "s"})`;
    case "manual":
      return `Journal voucher (${lines.length} lines)`;
    case "sales_summary":
      return "Sales";
    case "courier_payout":
    case "gateway_payout":
      return `Into ${n(d.receivedIn)}`;
    case "bill":
      return d.reference ? `Bill ${d.reference}` : lines.length === 1 ? n(lines[0].accountId) : "Bill";
    case "ad_spend":
      return `${{ facebook: "Meta", google: "Google", tiktok: "TikTok", snapchat: "Snapchat" }[String(d.platform)] ?? "Ad"} ad spend`;
    case "stock_adjustment":
      return d.method === "damaged" ? `Came back damaged${d.orderName ? ` (${d.orderName})` : ""}` : d.method === "count" ? "Stock count" : "Stock checked against Shopify";
    case "production":
      return { materials: "Materials used", cost: "Cost added", finish: `${d.units ?? ""} finished`.trim(), waste: `${d.units ? `${d.units} ` : ""}wasted` }[String(d.step)] ?? "Production";
    case "returns_allowance":
      return d.reverses ? `Expected returns for ${d.month} reversed` : `Expected returns at the end of ${d.month}`;
    case "parcel_writeoff": {
      const k = Array.isArray(d.parcels) ? d.parcels.length : 0;
      return `${k} parcel${k === 1 ? "" : "s"} ${d.reason === "lost" ? "lost" : "paid short"}`;
    }
    case "invoice":
      return d.reference ? `Invoice for ${d.reference}` : lines.length === 1 ? (lines[0].description || n(lines[0].accountId)) : `${lines.length} items`;
    case "supplier_credit": {
      const k = Array.isArray(d.allocations) ? d.allocations.length : 0;
      return k === 0 ? "Kept as credit" : `Against ${k} bill${k === 1 ? "" : "s"}`;
    }
    case "customer_payment":
    case "credit_note": {
      const k = Array.isArray(d.allocations) ? d.allocations.length : 0;
      if (doc.type === "credit_note" && k === 0) return "Kept as credit";
      return `${doc.type === "credit_note" ? "Against" : "For"} ${k} invoice${k === 1 ? "" : "s"}${doc.type === "customer_payment" ? ` into ${n(d.receivedIn)}` : ""}`;
    }
    case "tax_payment":
      return `Tax ${lines.length === 1 ? n(lines[0].accountId) : "paid"} from ${n(d.paidFrom)}`;
    case "bill_payment": {
      const k = Array.isArray(d.allocations) ? d.allocations.length : 0;
      return `Paid ${k} bill${k === 1 ? "" : "s"} from ${n(d.paidFrom)}`;
    }
    default:
      return doc.type;
  }
}

export async function loadDocumentRows(book: BookView, filter: DocumentFilter) {
  const [list, accounts] = await Promise.all([listDocuments(book, filter), listAccounts(book, { includeArchived: true })]);
  // Drafts have no stored total yet: show what they come to.
  const drafted = await draftTotals(book, list.rows.filter((r) => r.status === "draft"));
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  return {
    count: list.count,
    page: list.page,
    pageSize: list.pageSize,
    rows: list.rows.map((r) => ({
      id: r.id,
      type: r.type,
      number: r.number,
      status: r.status,
      date: r.date.toISOString().slice(0, 10),
      total: (r.status === "draft" ? drafted.get(r.id) ?? 0n : r.total).toString(),
      memo: r.memo,
      contactName: r.contactName,
      what: describe(r, names),
    })),
  };
}
