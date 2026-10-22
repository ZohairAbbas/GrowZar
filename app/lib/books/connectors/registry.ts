/** The connectors Books offers, for screens (browser-safe). */

export type ConnectorKey = "shopify_sales" | "courierify_payouts" | "ad_spend" | "bank_statements" | "stock_check" | "inventorify";

/** `path`: connectors you use on their own screen rather than switch on (statement uploads). */
export const CONNECTORS: Array<{ key: ConnectorKey; name: string; description: string; available: boolean; path?: string }> = [
  {
    key: "shopify_sales",
    name: "Shopify sales",
    description: "Each day's orders, discounts, shipping, tax, refunds and cancellations, split by how customers paid.",
    available: true,
  },
  {
    key: "courierify_payouts",
    name: "Courierify payouts",
    description: "Courier payouts with what each courier kept, matched to what they owe you.",
    available: true,
  },
  {
    key: "ad_spend",
    name: "Ad spend",
    description: "Daily Meta, TikTok, Google and Snapchat spend with its taxes and card charges, from a card, a bank account or an ad wallet.",
    available: true,
  },
  {
    key: "inventorify",
    name: "Inventorify",
    description: "Goods received become supplier bills (damaged units held for the claim), and supplier credits and adjustments follow — from your Inventorify purchase orders.",
    available: true,
  },
  {
    key: "bank_statements",
    name: "Bank statements",
    description: "Upload a statement and match each line with what's in your books, then reconcile.",
    available: true,
    path: "/books/bank",
  },
];

export const CONNECTOR_MODES = [
  { value: "draft", label: "Drafts to approve", help: "Each day arrives as a draft. You check it and save it to the books." },
  { value: "auto", label: "Save automatically", help: "Each day goes straight into the books, and drafts already waiting are saved too. You can still cancel any day." },
] as const;
