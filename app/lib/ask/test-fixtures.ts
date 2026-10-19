/**
 * Made-up orders and summaries for the ask tests. Nothing here comes from a
 * real store; names, phones and emails are invented to prove they never
 * reach a tool result.
 */
import { bucketOf, profitAfterReturns, type RollupOrder } from "../metrics/rollups";
import type { StoreSummary } from "../metrics/summaries.server";
import { NO_SCOPE } from "../metrics/scope";

export const FAKE_BUYER = { name: "Ayesha Testbuyer", phone: "03001234567", email: "ayesha.testbuyer@example.com" };

let seq = 0;
const money = (amount: string, currency = "PKR") => ({ amount, currency });

export function order(o: Partial<RollupOrder> = {}, currency = "PKR"): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`,
    localDay: "2026-10-10",
    createdAt: new Date("2026-10-10T08:00:00Z"),
    currency,
    placed: money("1000.00", currency),
    delivered: money("1000.00", currency),
    refunded: null,
    collected: null,
    uncollected: null,
    cogs: money("400.00", currency),
    cogsComplete: true,
    courierFee: money("150.00", currency),
    outcome: "delivered",
    outcomeTiming: null,
    financifyOutcome: null,
    parcelCount: 1,
    courier: "leopards",
    fulfilledVia: null,
    city: "Lahore",
    cityRaw: "Lahore",
    lines: [{ variantId: "11", productId: "1", title: "Lawn Suit", variantTitle: "Red", quantity: 1, value: money("1000.00", currency), cost: money("400.00", currency) }],
    confirmation: "confirmed",
    customerId: `c${seq % 7}`,
    otherCosts: null,
    ...o,
  };
}

export const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);

/** A summary as `storeSummary` would return it for these rows, with no ad spend. */
export function fakeSummary(store: { id: string; currency: string | null; timezone?: string | null }, rows: RollupOrder[], period = { from: "2026-09-20", to: "2026-10-19" }): StoreSummary {
  const orders = bucketOf(store.id, rows);
  const options = (key: (o: RollupOrder) => string) => {
    const m = new Map<string, number>();
    for (const o of rows) m.set(key(o), (m.get(key(o)) ?? 0) + 1);
    return [...m].map(([k, n]) => ({ key: k, orders: n }));
  };
  return {
    store: { id: store.id, shopDomain: `${store.id}.myshopify.com`, currency: store.currency, timezone: store.timezone ?? "Asia/Karachi" },
    period,
    orders,
    adSpend: null,
    profit: store.currency ? profitAfterReturns(orders, store.currency, null) : null,
    roas: null,
    settings: { storeId: store.id, shopDomain: `${store.id}.myshopify.com`, settingsHash: null, settings: null, isDefault: null, fetchedAt: null },
    courierifyCoverage: { shippedOrders: rows.length, withParcel: rows.length },
    withheld: { orders: 0, returned: 0, inTransit: 0, couriers: [] },
    fx: null,
    scope: NO_SCOPE,
    scopeOptions: { couriers: options((o) => o.courier ?? "unknown"), cities: options((o) => o.city ?? "unmapped") },
    rows,
  };
}

/** A store's usual month: 30 delivered and 10 returned in Lahore by Leopards, 25 delivered in Karachi by TCS, 3 open. */
export function month(currency = "PKR"): RollupOrder[] {
  return [
    ...times(30, () => order({}, currency)),
    ...times(10, () => order({ outcome: "returned", delivered: null }, currency)),
    ...times(25, () => order({ city: "Karachi", cityRaw: "Karachi", courier: "tcs", localDay: "2026-10-12", createdAt: new Date("2026-10-12T08:00:00Z") }, currency)),
    ...times(3, () => order({ outcome: "in_transit", delivered: null }, currency)),
  ];
}
