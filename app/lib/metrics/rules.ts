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
  { id: 18, title: "Suppliers and purchase orders", status: "implemented", where: "Inventory section: units on order per variant and open purchase orders, from Inventorify (the owner)" },
  { id: 19, title: "Number of customers / repeat rate", status: "implemented", where: "Growzar's customer record by normalised phone; screens count it, never an app's count" },
  { id: 20, title: "Customer lifetime value / order count", status: "implemented", where: "order grain grouped by customerId" },
  { id: 21, title: "Buyer risk", status: "deferred", reason: "Preventify's level is synced but is network risk, kept for labelling only; I5 scores buyers per store (D-51) until the buyer network (D-52)", meanwhile: "Orders says risk is not available" },
  { id: 22, title: "Consent / opted out", status: "implemented", where: "Customers: Retainify's consent per channel (subscribed and not suppressed) matched to buyers by phone, and its history of changes from 8 Oct 2026 (consent.ts); WhatKaBot not read yet" },
  { id: 23, title: "Abandoned carts", status: "implemented", where: "Marketing and I6: Retainify's Shopify checkouts with no order from the buyer within the hour (checkouts.ts); Preventify's form abandonments follow its feed" },
  { id: 24, title: "Recovered carts / revenue", status: "implemented", where: "checkouts.ts: a Retainify reminder, then an order within 7 days; an order with no reminder first came back on its own; Retainify's recoveredAt is read only as \"became an order\"" },
  { id: 25, title: "COD order confirmation", status: "implemented", where: "order grain confirmation from Courierify OrderConfirmation (not OrderCase.stage)" },
  { id: 26, title: "Checkout conversion rate", status: "deferred", reason: "Preventify's read API is Phase 5", meanwhile: "not shown" },
  { id: 27, title: "Upsell performance", status: "implemented", where: "Marketing: orders that took each Preventify offer (bundle, one-tick, upsell, downsell) against form orders with none, by Financify order value and the grain's outcomes (offers.ts); shown and clicked counts from 9 Oct 2026 are labelled indicative" },
  { id: 28, title: "Units sold per product", status: "implemented", where: "Inventory section: Inventorify's daily units sold; order-based product tables: rollups.productLines from Financify lines" },
  { id: 29, title: "Return rate per product", status: "implemented", where: "rollups.productLines: order lines × outcome, by order" },
  { id: 30, title: "Product identity", status: "implemented", where: "Shopify variant id everywhere; SKU never a key" },
  { id: 31, title: "WhatsApp messages sent / cost", status: "deferred", reason: "Retainify's messages are synced (G-GZR5-2), with no cost; WhatKaBot not read yet", meanwhile: "not shown" },
  { id: 32, title: "Campaigns", status: "implemented", where: "Marketing: Retainify's journeys and campaigns, labelled as Retainify's, with the orders that followed counted by Growzar; WhatKaBot not read yet; Financify's ad campaigns stay ad spend" },
];
