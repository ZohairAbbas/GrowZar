/**
 * The activity log in plain words. Pure and browser-safe; the loader looks up
 * the names (accounts, contacts, documents) an event refers to.
 */

import { CONNECTORS } from "./connectors/registry";

export const ACTIVITY_KINDS = [
  { value: "", label: "Everything" },
  { value: "document", label: "Entries" },
  { value: "account", label: "Accounts" },
  { value: "contact", label: "Contacts" },
  { value: "bank", label: "Bank statements and reconciling" },
  { value: "settings", label: "Settings, taxes and closing" },
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]["value"];

/** Action prefixes for a kind filter. */
export function actionPrefixes(kind: string): string[] | null {
  switch (kind) {
    case "document":
      return ["document."];
    case "account":
      return ["account."];
    case "contact":
      return ["contact."];
    case "settings":
      return ["book.", "connector.", "tax_rate.", "recurring.", "settings.", "batch.", "stock."];
    case "bank":
      return ["statement.", "reconciliation.", "bank_rule."];
    default:
      return null;
  }
}

export interface ActivityEvent {
  action: string;
  detail: Record<string, unknown>;
  documentId: string | null;
}

export interface ActivityNames {
  account: (id: unknown) => string | null;
  contact: (id: unknown) => string | null;
  /** "EXP-0004 · Packaging", or the kind of entry for a draft. */
  document: (id: unknown) => string | null;
}

export interface ActivityLine {
  text: string;
  /** Where clicking the line goes, when the thing still exists. */
  link: string | null;
}

/** Growzar's page for each connector's settings. */
const CONNECTOR_PATHS: Record<string, string> = { shopify_sales: "sales", ad_spend: "ad-spend", courierify_payouts: "courier-payouts", inventorify: "inventorify" };

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const connectorName = (key: unknown) => CONNECTORS.find((c) => c.key === key)?.name ?? (key === "stock_check" ? "Stock check" : key === "recurring" ? "a recurring entry" : s(key) || "A connector");

export function activityText(e: ActivityEvent, names: ActivityNames): ActivityLine {
  const d = e.detail ?? {};
  const docId = e.documentId ?? (typeof d.documentId === "string" ? d.documentId : null);
  const doc = names.document(docId) || "an entry";
  const docLink = e.documentId ? `/books/entries/${e.documentId}` : null;
  const acc = names.account(d.accountId) || s(d.name) || "an account";
  const accLink = typeof d.accountId === "string" ? "/books/accounts" : null;
  const con = names.contact(d.contactId) || s(d.name) || "a contact";
  // Growzar has no contact page yet.
  const conLink: string | null = null;

  switch (e.action) {
    case "document.draft_created":
      return { text: `Started a draft: ${doc}${d.source ? ` (from ${connectorName(d.source)})` : ""}`, link: docLink };
    case "document.draft_saved":
      return { text: `${d.source ? `${connectorName(d.source)} refreshed` : "Changed"} a draft: ${doc}`, link: docLink };
    case "document.posted":
      return { text: `Saved to the books: ${doc}`, link: docLink };
    case "document.attached":
      return { text: `Attached ${s(d.fileName) || "a file"} to ${doc}`, link: docLink };
    case "document.detached":
      return { text: `Removed ${s(d.fileName) || "a file"} from ${doc}`, link: docLink };
    case "document.tagged": {
      const after = Array.isArray(d.after) ? (d.after as string[]) : [];
      return { text: after.length ? `Tagged ${doc}: ${after.join(", ")}` : `Removed the tags from ${doc}`, link: docLink };
    }
    case "document.credit_applied":
      return { text: `Used credit from ${doc}`, link: docLink };
    case "document.cancelled":
      return { text: `Cancelled ${doc}${d.reason ? ` — “${s(d.reason)}”` : ""}${d.date ? `, reversed on ${s(d.date)}` : ""}`, link: docLink };
    case "document.draft_discarded":
      return { text: `Discarded a draft${d.type ? ` (${s(d.type).replace(/_/g, " ")})` : ""}`, link: null };
    case "account.created":
      return { text: `Added the account ${acc}`, link: accLink };
    case "account.renamed":
      return { text: `Renamed the account “${s(d.from)}” to “${s(d.to)}”`, link: accLink };
    case "account.updated": {
      const before = (d.before ?? {}) as { name?: string; subtype?: string; parentId?: string | null };
      const after = (d.after ?? {}) as { name?: string; subtype?: string; parentId?: string | null };
      const what = [before.name !== after.name ? `renamed it to “${s(after.name)}”` : null, before.subtype !== after.subtype ? "changed its kind" : null, before.parentId !== after.parentId ? (after.parentId ? "made it a sub-account" : "made it a top-level account") : null].filter(Boolean);
      return { text: `Changed the account ${acc}${what.length ? `: ${what.join(", ")}` : ""}`, link: accLink };
    }
    case "account.archived":
      return { text: `Archived the account ${acc}`, link: accLink };
    case "account.restored":
      return { text: `Brought back the account ${acc}`, link: accLink };
    case "contact.created":
      return { text: `Added the contact ${con}`, link: conLink };
    case "contact.updated": {
      const before = (d.before ?? {}) as { name?: string };
      const after = (d.after ?? {}) as { name?: string };
      return { text: before.name && after.name && before.name !== after.name ? `Renamed the contact “${before.name}” to “${after.name}”` : `Changed the contact ${con}`, link: conLink };
    }
    case "contact.archived":
      return { text: `Archived the contact ${con}`, link: conLink };
    case "contact.restored":
      return { text: `Brought back the contact ${con}`, link: conLink };
    case "book.store_added":
      return { text: `Added ${s(d.name)} to the books${d.currency ? ` (in ${s(d.currency)})` : ""}`, link: "/books/sources" };
    case "book.created":
      return { text: "Set up the books", link: null };
    case "book.fiscal_year_changed":
      return { text: `Changed the financial year's first month (${s(d.from)} → ${s(d.to)})`, link: null };
    case "book.closed":
      return { text: `Closed the books through ${s(d.to)}`, link: "/books" };
    case "book.close_prepared":
      return { text: `Prepared closing the books through ${s(d.to)}, for an owner or admin to confirm${d.note ? ` — “${s(d.note)}”` : ""}`, link: "/books/close" };
    case "book.close_withdrawn":
      return { text: `Withdrew the prepared close through ${s(d.from)}`, link: "/books/close" };
    case "book.reopened":
      return { text: `${d.to ? `Reopened the books after ${s(d.to)}` : "Reopened every date"}${d.reason ? ` — “${s(d.reason)}”` : ""}`, link: "/books" };
    case "connector.rebuilt":
      return { text: `Brought ${connectorName(d.key)} in again from ${s(d.from)} (${s(d.cancelled)} entr${d.cancelled === 1 ? "y" : "ies"} cancelled)`, link: typeof d.key === "string" && CONNECTOR_PATHS[d.key] ? `/books/connectors/${CONNECTOR_PATHS[d.key]}` : null };
    case "connector.saved":
      return {
        text: `${d.enabled === false ? "Switched off" : "Saved the settings of"} ${connectorName(d.key)}${d.restart ? " and started it again from its start date" : ""}`,
        link: typeof d.key === "string" && CONNECTOR_PATHS[d.key] ? `/books/connectors/${CONNECTOR_PATHS[d.key]}` : null,
      };
    case "recurring.created":
      return { text: `Made “${s(d.name)}” repeat (${s(d.schedule)})`, link: null };
    case "recurring.updated":
      return { text: `Changed the recurring entry “${s(d.name)}” (${s(d.schedule)})`, link: null };
    case "recurring.paused":
      return { text: `Paused “${s(d.name)}”`, link: null };
    case "recurring.resumed":
      return { text: `Resumed “${s(d.name)}”`, link: null };
    case "recurring.deleted":
      return { text: `Stopped the recurring entry “${s(d.name)}”`, link: null };
    case "tax_rate.created":
      return { text: `Added the tax rate ${s(d.name)}`, link: null };
    case "tax_rate.updated":
      return { text: `Changed the tax rate ${s(d.name)}`, link: null };
    case "tax_rate.archived":
      return { text: `Archived the tax rate ${s(d.name)}`, link: null };
    case "tax_rate.restored":
      return { text: `Brought back the tax rate ${s(d.name)}`, link: null };
    case "statement.imported":
      return { text: `Imported ${s(d.added)} statement line${d.added === 1 ? "" : "s"} into ${s(d.name) || "an account"}${Number(d.duplicates) > 0 ? ` (${s(d.duplicates)} already there)` : ""}`, link: typeof d.accountId === "string" ? `/books/bank/${d.accountId}` : null };
    case "statement.import_undone":
      return { text: `Took back a statement import${d.fileName ? ` (${s(d.fileName)})` : ""}`, link: typeof d.accountId === "string" ? `/books/bank/${d.accountId}` : null };
    case "reconciliation.started":
      return { text: `Started reconciling ${s(d.name) || "an account"} to ${s(d.statementDate)}`, link: typeof d.accountId === "string" ? `/books/bank/${d.accountId}` : null };
    case "reconciliation.finished":
      return { text: `Reconciled ${s(d.name) || "an account"} through ${s(d.statementDate)}`, link: null };
    case "reconciliation.undone":
      return { text: `Undid the reconciliation through ${s(d.statementDate)}${d.reason ? ` — “${s(d.reason)}”` : ""}`, link: typeof d.accountId === "string" ? `/books/bank/${d.accountId}` : null };
    case "connector.courierify_key_saved":
      return { text: "Saved the Courierify key", link: "/books/connectors/courier-payouts" };
    case "stock.costs_set_in_shopify":
      return { text: `Set the cost per item in Shopify for ${Number(d.items ?? 0)} item${Number(d.items) === 1 ? "" : "s"}`, link: null };
    case "batch.started":
      return { text: `Started production batch ${String(d.number ?? "")} — ${String(d.name ?? "")}`, link: null };
    case "bank_rule.added":
      return { text: `Added a bank rule for "${String(d.contains ?? "")}"`, link: "/books/bank/rules" };
    case "bank_rule.changed":
      return { text: `Changed the bank rule for "${String(d.contains ?? "")}"`, link: "/books/bank/rules" };
    case "settings.parcel_rules":
      return { text: `Parcels now count as stuck after ${Number(d.stuckAfterDays ?? 0)} days on the way, or ${Number(d.unshippedAfterDays ?? 0)} days unshipped`, link: null };
    default:
      return { text: e.action.replace(/[._]/g, " "), link: docLink };
  }
}

/** Who did it, from the stored actor (a staff member's id, or nothing for automatic work). */
export function actorLabel(actor: string | null, me: string | null): string {
  if (!actor) return "Automatic";
  if (me && actor === me) return "You";
  return `Staff member ···${actor.slice(-4)}`;
}
