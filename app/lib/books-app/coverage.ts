/**
 * What will post to the books for each store, and from where (D-66, D-78):
 * each source is automatic (an app Growzar reads provides it), missing (the
 * app isn't connected: an install button, through the tracked route) or by
 * hand. Setup says this plainly before anything is posted.
 *
 * Automatic posting starts when the connectors run (B3); until then the
 * status says what will post, not what has.
 */
import type { SuiteApp } from "@prisma/client";

export type SourceKey = "sales" | "cost" | "courier_payouts" | "ad_spend" | "goods_received" | "bank";

export type SourceStatus =
  | { kind: "auto"; app: SuiteApp; note?: string }
  | { kind: "missing"; app: SuiteApp; byHand: string }
  | { kind: "update"; app: SuiteApp; byHand: string }
  | { kind: "by_hand"; byHand: string };

export type CoverageConnection = { app: SuiteApp; status: string; capabilities: string[] };

export const SOURCE_LABELS: Record<SourceKey, { label: string; what: string }> = {
  sales: { label: "Sales", what: "Each day's orders, discounts, shipping, tax, refunds and cancellations." },
  cost: { label: "Cost of goods", what: "What each sale cost you, taken off Stock." },
  courier_payouts: { label: "Courier payouts", what: "What couriers paid you, what they kept, and what they still owe." },
  ad_spend: { label: "Ad spend", what: "Daily spend per platform, with its fees." },
  goods_received: { label: "Goods received", what: "Deliveries from suppliers as bills, and what you owe each one." },
  bank: { label: "Bank statements", what: "Upload a statement and match each line with what's in your books." },
};

const connected = (cs: CoverageConnection[], app: SuiteApp) => cs.find((c) => c.app === app && c.status === "CONNECTED");

/** One store's sources, in the order setup shows them. */
export function storeCoverage(connections: CoverageConnection[]): Array<{ source: SourceKey; status: SourceStatus }> {
  const financify = connected(connections, "FINANCIFY");
  const courierify = connected(connections, "COURIERIFY");
  const inventorify = connected(connections, "INVENTORIFY");
  return [
    {
      source: "sales",
      // Sales post from Financify's orders only in version 1 (D-90).
      status: financify ? { kind: "auto", app: "FINANCIFY" } : { kind: "missing", app: "FINANCIFY", byHand: "Record each day's sales by hand." },
    },
    {
      source: "cost",
      // Financify's cost, else Inventorify's unit cost, else Books' own cost list (D-78).
      status: financify
        ? { kind: "auto", app: "FINANCIFY" }
        : inventorify
          ? { kind: "auto", app: "INVENTORIFY", note: "Inventorify's unit cost" }
          : { kind: "by_hand", byHand: "Keep a cost list in Books." },
    },
    {
      source: "courier_payouts",
      status: courierify ? { kind: "auto", app: "COURIERIFY" } : { kind: "missing", app: "COURIERIFY", byHand: "Record each payout by hand." },
    },
    {
      source: "ad_spend",
      status: financify ? { kind: "auto", app: "FINANCIFY" } : { kind: "missing", app: "FINANCIFY", byHand: "Record ad spend as expenses." },
    },
    {
      source: "goods_received",
      status: !inventorify
        ? { kind: "missing", app: "INVENTORIFY", byHand: "Record supplier bills by hand." }
        : inventorify.capabilities.includes("receipts:read") && inventorify.capabilities.includes("supplier-ledger:read")
          ? { kind: "auto", app: "INVENTORIFY" }
          : { kind: "update", app: "INVENTORIFY", byHand: "Record supplier bills by hand until it updates." },
    },
    { source: "bank", status: { kind: "by_hand", byHand: "Upload your statements; they're read in your browser and never kept." } },
  ];
}

/** Books' install button: the tracked route (G-GZR6-3), marked as coming from Books. */
export const installHref = (storeId: string, app: SuiteApp) => `/stores/${storeId}/apps/${app}/install?from=books`;
