/**
 * The budget simulator's inputs and outputs (G-GZR11-5, pack §5.2 and §10).
 * Pure types.
 */

import type { Range } from "../stats";

export type SimRequest = {
  /** In the store's currency. */
  budget: number;
  /** Days the plan covers (P11-12: 30). */
  horizonDays: number;
  include: { ads: boolean; stock: boolean; buffer: boolean };
  /** Variant ids the plan must keep in stock. */
  keepInStock: string[];
  /** A cash buffer the plan never goes under. */
  minBuffer: number;
  /** Platforms the plan leaves out ("facebook", "tiktok", …). */
  excludePlatforms: string[];
  /** Lead times the merchant gives, by variant id: they win over Inventorify's. */
  leadTimes: Record<string, number>;
  /** Days from delivered to paid for payers without a measured cycle (P11-5). */
  payoutLags: Record<string, number>;
};

/** One decided or open order, as the simulator reads it. */
export type SimOrder = {
  orderId: string;
  createdAt: Date;
  /** Financify's attribution; null when the order is not credited to an ad. */
  campaignKey: string | null;
  platform: string | null;
  /** True delivered, false returned, null still open or never shipped. */
  delivered: boolean | null;
  /** Delivered revenue − product cost − courier fees − other costs, by Finance's rules (before ad spend); for decided orders. */
  contribution: number;
  lines: Array<{ variantId: string; quantity: number }>;
  /** For the what-ifs: where it went, with whom, and how it was paid. */
  city: string | null;
  courier: string | null;
  payment: "cod" | "prepaid" | "unknown";
};

export type SpendDay = { day: string; level: "platform" | "campaign"; key: string; platform: string; amount: number };

export type StockItem = {
  variantId: string;
  title: string;
  stock: number;
  onOrder: number;
  /** Units a day the shelf loses once returns are back on it. */
  netPerDay: number;
  /** Lead time in days, and where it came from; null when unknown. */
  leadTimeDays: number | null;
  leadSource: "merchant" | "measured" | "setting" | null;
  unitCost: number | null;
  /** Profit a unit sold brings, after its returns (from this store's orders); null without history. */
  unitMargin: number | null;
};

export type Payer = { payer: string; share: number; lag: number | null; basis: "measured" | "merchant" | "unknown"; reason: string | null };

/** Everything the simulator reads about the store, as at `asOf`. */
export type SimData = {
  asOf: Date;
  today: string;
  currency: string;
  orders: SimOrder[];
  spend: SpendDay[];
  campaignNames: Map<string, string | null>;
  /** Null when the store has no Inventorify (P11-15: stock is left out). */
  stock: StockItem[] | null;
  /** Median and 90th percentile days from order to delivered, store-wide; null without courier-timed deliveries. */
  deliveryDays: { median: number; p90: number } | null;
  payers: Payer[];
  /** Average daily ad spend over the last 30 days. */
  recentDailySpend: number;
  gate: GateFacts;
};

export type GateFacts = {
  historyDays: number;
  adDaysFetched: number;
  adDaysWindow: number;
  deliveredOrders: number;
  deliveredWithCost: number;
  /** Products on delivered orders with no cost, by title. */
  productsMissingCost: string[];
  orders: number;
  attributedOrders: number;
  links: { costs: Link | null; adAccounts: Link | null; courierify: Link | null };
};

export type Link = { label: string; href: string };

export type Fix = {
  check: "history" | "ad_spend" | "product_cost" | "attribution" | "delivery_times" | "payout_lag";
  /** What is wrong and what to do, in a sentence. */
  detail: string;
  action: Link | null;
  /** For a payout lag the merchant types into the form. */
  payer?: string;
};

export type LineKind = "buffer" | "campaign" | "platform_group" | "stock";

export type PlanLine = {
  kind: LineKind;
  key: string;
  label: string;
  platform: string | null;
  amount: number;
  /** What the money buys, in words. */
  buys: string;
  deliveredOrders: Range | null;
  /** Delivered profit after this line's spend (low is the headline). */
  profit: Range;
  /** When the money is back as COD, at the latest likely date. */
  cashBackBy: string | null;
  /** The products this line sells, with their share of its units. */
  products: Array<{ variantId: string; title: string; share: number }>;
  notes: string[];
};

export type Plan =
  | {
      status: "plan";
      asOf: string;
      currency: string;
      request: SimRequest;
      lines: PlanLine[];
      totals: { allocated: number; kept: number; deliveredOrders: Range; profit: Range; cashBackBy: string | null };
      assumptions: string[];
      leftOut: string[];
    }
  | { status: "refused"; asOf: string; fixes: Fix[] };
