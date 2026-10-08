/**
 * The 32 display rules of CONFLICTING-DATA-POINTS.md (decided 2026-09-21),
 * and where Growzar applies each one (G-GZR2-6).
 *
 * `rules.test.ts` holds one test per rule, named for it. A rule marked
 * `deferred` reads data Growzar does not sync yet; its test guards that no
 * feed or grain field for that data has appeared, so whoever adds one must
 * implement the rule and change its test rather than show a number from the
 * wrong source.
 */

export type DisplayRule =
  | { id: number; title: string; status: "implemented"; where: string }
  | { id: number; title: string; status: "deferred"; reason: string; meanwhile: string };

export const DISPLAY_RULES: readonly DisplayRule[] = [
  { id: 1, title: "Number of orders", status: "implemented", where: "order grain: one row per Shopify order id; parcels are never orders" },
  { id: 2, title: "Revenue / GMV", status: "implemented", where: "order grain placed / delivered / collected, never summed" },
  { id: 3, title: "Average order value", status: "implemented", where: "rollups.averageOrderValue" },
  { id: 4, title: "Currency", status: "implemented", where: "money.sumByCurrency; each order converted at its own day's Financify rate (fx-orders.convertOrder, fx_rates); a day with no rate stays in its currency, listed and labelled (2026-10-05 decision)" },
  { id: 5, title: "What counts as a day", status: "implemented", where: "order-grain.localDayOf in the store's timezone" },
  { id: 6, title: "Order ID (the join key)", status: "implemented", where: "entities.extractId; order grain keyed by orderId" },
  { id: 7, title: "Delivery status of an order", status: "implemented", where: "order grain outcome: Courierify when it has the parcel, else Financify" },
  { id: 8, title: "Delivery rate and return rate", status: "implemented", where: "rollups.DeliveryRate: by order, by order day, with still-open beside it" },
  { id: 9, title: "Delivery date and return date", status: "implemented", where: "events.currentStatusTiming: 'status as of' without a courier time" },
  { id: 10, title: "Returned", status: "implemented", where: "order grain: returned, cancelled and refunded apart" },
  { id: 11, title: "Cancelled", status: "implemented", where: "order grain orderCancelled vs shipmentCancelled" },
  { id: 12, title: "Delivery performance by courier and city", status: "implemented", where: "rollups byCourier / byCity with the #8 formula; Courierify's canonical city, else Financify's delivery city mapped to it by learned aliases (city-aliases.ts), else 'unmapped'" },
  { id: 13, title: "Courier cost per order", status: "implemented", where: "order grain courierFee from Financify's courier_costs metafield (2026-09-25 decision)" },
  { id: 14, title: "Product cost (COGS)", status: "implemented", where: "order grain cogs from Financify, order-time cost, completeness kept" },
  { id: 15, title: "Net profit", status: "implemented", where: "Financify's settings stored and compared; Growzar's own figure is 'profit after returns', never 'net profit'" },
  { id: 16, title: "ROAS", status: "implemented", where: "rollups.roas = delivered revenue ÷ ad spend (text inverted; confirmed 2026-09-30)" },
  { id: 17, title: "Cash collected / settlements", status: "implemented", where: "'paid by courier' from settled delivered parcels; 'received in bank' shown as not available" },
  { id: 18, title: "Suppliers and purchase orders", status: "deferred", reason: "synced from Inventorify, the owner (G-GZR5-1); shown once the Inventory section lands (G-GZR5-3)", meanwhile: "not shown" },
  { id: 19, title: "Number of customers / repeat rate", status: "implemented", where: "Growzar's customer record by normalised phone; screens count it, never an app's count" },
  { id: 20, title: "Customer lifetime value / order count", status: "implemented", where: "order grain grouped by customerId" },
  { id: 21, title: "Buyer risk", status: "deferred", reason: "Courierify's network band and Preventify's level are not in Growzar's feeds", meanwhile: "Orders says risk is not available" },
  { id: 22, title: "Consent / opted out", status: "deferred", reason: "Retainify and WhatKaBot consent reads are Phase 5", meanwhile: "Customers says consent is not available" },
  { id: 23, title: "Abandoned carts", status: "deferred", reason: "no checkout feed from any app yet", meanwhile: "not shown" },
  { id: 24, title: "Recovered carts / revenue", status: "deferred", reason: "needs recovery messages and carts; Phase 5", meanwhile: "not shown" },
  { id: 25, title: "COD order confirmation", status: "implemented", where: "order grain confirmation from Courierify OrderConfirmation (not OrderCase.stage)" },
  { id: 26, title: "Checkout conversion rate", status: "deferred", reason: "Preventify's read API is Phase 5", meanwhile: "not shown" },
  { id: 27, title: "Upsell performance", status: "deferred", reason: "Preventify's read API is Phase 5", meanwhile: "not shown" },
  { id: 28, title: "Units sold per product", status: "implemented", where: "rollups.productLines from Financify lines (Inventorify not yet read)" },
  { id: 29, title: "Return rate per product", status: "implemented", where: "rollups.productLines: order lines × outcome, by order" },
  { id: 30, title: "Product identity", status: "implemented", where: "Shopify variant id everywhere; SKU never a key" },
  { id: 31, title: "WhatsApp messages sent / cost", status: "deferred", reason: "no messaging feed from any app yet", meanwhile: "not shown" },
  { id: 32, title: "Campaigns", status: "deferred", reason: "Retainify and WhatKaBot campaign reads are Phase 5", meanwhile: "not shown (ad campaigns from Financify are ad spend, not messaging campaigns)" },
];
