import { prisma } from "../../db.server";
import { actionFor, actionHref, SUITE_APPS, type ScreenKey } from "../../apps/app-links";
import { loadAttribution, loadCampaignNames } from "../../metrics/campaigns.server";
import { inventorySection } from "../../metrics/inventory.server";
import { parseVariant } from "../../metrics/inventory";
import { localDayOf } from "../../metrics/order-grain";
import type { RollupOrder } from "../../metrics/rollups";
import { loadForecastBase, type ForecastBase } from "../base.server";
import { valueOf } from "../month-end";
import { DAY_MS, quantile } from "../stats";
import type { GateFacts, Link, Payer, SimData, SimOrder, SpendDay, StockItem } from "./types";

/**
 * Everything the budget simulator reads about a store, as at `asOf`
 * (G-GZR11-5). Stock is today's (Inventorify keeps no past), so a replay at a
 * past date leaves it out.
 */

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const DELIVERED = new Set(["delivered", "partially_delivered"]);
const TIMED = new Set(["happened_on", "reported_by_3pl"]);
const num = (m: { amount: string; currency: string } | null | undefined, currency: string) => (m && m.currency === currency ? Number(m.amount) : null);

/** Who pays an order's COD, as the cash forecast keys it; Financify-only orders carry their courier. */
const payerKey = (o: RollupOrder) => (o.fulfilledVia ?? o.courier ?? "unknown").toLowerCase();

export async function loadSimData(storeId: string, asOf: Date = new Date(), base?: ForecastBase): Promise<SimData> {
  const b = base ?? (await loadForecastBase(storeId, asOf));
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { shopDomain: true, currency: true, connections: { where: { status: "CONNECTED" }, select: { app: true } } } });
  const currency = store.currency ?? "";
  const today = localDayOf(asOf, b.timezone);
  const connected = new Set(store.connections.map((c) => c.app as string));

  const rows = b.rows.filter((o) => o.createdAt);
  const [attribution, names, payments, spendRows, dayRows] = await Promise.all([
    loadAttribution(storeId, rows.map((o) => o.orderId)),
    loadCampaignNames(storeId),
    prisma.$queryRaw<Array<{ orderId: string; method: string | null }>>`
      SELECT "externalId" AS "orderId", payload->'payment'->>'method' AS method FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'FINANCIFY' AND entity = 'ORDER' AND "deletedAt" IS NULL`,
    prisma.adSpend.findMany({ where: { storeId, level: { in: ["platform", "campaign"] }, day: { lt: today } }, select: { day: true, level: true, key: true, platform: true, spendAmount: true, currency: true } }),
    prisma.adSpend.findMany({ where: { storeId, level: "day", day: { gte: addDays(today, -90), lt: today } }, select: { day: true, spendAmount: true, currency: true } }),
  ]);
  const method = new Map(payments.map((p) => [p.orderId, p.method]));

  const orders: SimOrder[] = rows.map((o) => {
    const a = attribution.get(o.orderId);
    const m = method.get(o.orderId);
    const decided = DELIVERED.has(o.outcome) || o.outcome === "returned";
    return {
      orderId: o.orderId,
      createdAt: o.createdAt!,
      campaignKey: a?.campaignKey ?? null,
      platform: a?.platform?.toLowerCase() ?? null,
      delivered: decided ? DELIVERED.has(o.outcome) : null,
      contribution: decided ? valueOf(o, currency).profit : 0,
      lines: o.lines.filter((l) => l.variantId).map((l) => ({ variantId: l.variantId!, quantity: l.quantity })),
      city: o.city,
      courier: o.courier?.replace(/^financify:/, "") ?? null,
      payment: m === "cod" || m === "prepaid" ? m : "unknown",
    };
  });
  const spend: SpendDay[] = spendRows
    .filter((r) => r.currency === currency && r.platform)
    .map((r) => ({ day: r.day, level: r.level as "platform" | "campaign", key: r.key, platform: r.platform!.toLowerCase(), amount: Number(r.spendAmount) }));

  // Delivery time and who pays, from the last 180 days' courier-timed deliveries and 90 days' delivered COD.
  const since = (days: number) => asOf.getTime() - days * DAY_MS;
  const timed = rows
    .filter((o) => DELIVERED.has(o.outcome) && o.outcomeTiming && TIMED.has(o.outcomeTiming.basis) && o.createdAt!.getTime() >= since(180))
    .map((o) => (o.outcomeTiming!.at.getTime() - o.createdAt!.getTime()) / DAY_MS)
    .sort((x, y) => x - y);
  const deliveryDays = timed.length >= 30 ? { median: quantile(timed, 0.5)!, p90: quantile(timed, 0.9)! } : null;
  const delivered90 = rows.filter((o) => DELIVERED.has(o.outcome) && o.createdAt!.getTime() >= since(90));
  const cod = new Map<string, number>();
  for (const o of delivered90) cod.set(payerKey(o), (cod.get(payerKey(o)) ?? 0) + (num(o.placed, currency) ?? 0));
  const codTotal = [...cod.values()].reduce((x, y) => x + y, 0);
  const payers: Payer[] = [...cod.entries()]
    .map(([payer, amount]) => {
      const c = b.payoutCycles.get(payer);
      const label = payer === "unknown" ? "orders with no courier recorded" : payer.startsWith("financify:") ? `${payer.slice(10)} (orders with no Courierify parcel)` : payer;
      return c?.measured
        ? { payer: label, share: codTotal ? amount / codTotal : 0, lag: c.median, basis: "measured" as const, reason: null }
        : { payer: label, share: codTotal ? amount / codTotal : 0, lag: null, basis: "unknown" as const, reason: c?.reason ?? (payer.startsWith("financify:") ? "Courierify has no parcel for these orders" : "no settlement has been recorded") };
    })
    .sort((x, y) => y.share - x.share);

  const daySpend = dayRows.filter((r) => r.currency === currency);
  const last30 = daySpend.filter((r) => r.day >= addDays(today, -30));
  const recentDailySpend = last30.reduce((x, r) => x + Number(r.spendAmount), 0) / 30;

  const link = (screen: ScreenKey): Link | null => {
    const a = actionFor(screen, connected);
    const href = a ? actionHref(screen, connected, store.shopDomain) : null;
    return a && href ? { label: a.label, href } : null;
  };
  const placed90 = rows.filter((o) => o.createdAt!.getTime() >= since(90));
  const missing = new Set<string>();
  for (const o of delivered90) if (!o.cogsComplete) for (const l of o.lines) if (!l.cost) missing.add(l.title ?? l.variantId ?? "a product");
  const gate: GateFacts = {
    historyDays: rows.length ? Math.floor((asOf.getTime() - Math.min(...rows.map((o) => o.createdAt!.getTime()))) / DAY_MS) : 0,
    adDaysFetched: new Set(daySpend.map((r) => r.day)).size,
    adDaysWindow: 90,
    deliveredOrders: delivered90.length,
    deliveredWithCost: delivered90.filter((o) => o.cogsComplete).length,
    productsMissingCost: [...missing].sort(),
    orders: placed90.length,
    attributedOrders: placed90.filter((o) => attribution.get(o.orderId)?.campaignKey).length,
    links: {
      costs: link("financify_costs"),
      adAccounts: link("financify_integrations"),
      courierify: connected.has("COURIERIFY") || !SUITE_APPS.COURIERIFY.listing ? null : { label: `Install ${SUITE_APPS.COURIERIFY.name}`, href: SUITE_APPS.COURIERIFY.listing },
    },
  };

  const isToday = Math.abs(Date.now() - asOf.getTime()) < DAY_MS;
  const stock = isToday && connected.has("INVENTORIFY") ? await loadStock(storeId, today, currency, rows) : null;

  return { asOf, today, currency, orders, spend, campaignNames: new Map([...names].map(([k, v]) => [k, v.name])), stock, deliveryDays, payers, recentDailySpend, gate };
}

/** Today's stock per variant, with lead time, cost and the profit a unit brings after its returns. */
async function loadStock(storeId: string, today: string, currency: string, rows: readonly RollupOrder[]): Promise<StockItem[]> {
  const history = rows.filter((o) => o.createdAt && (DELIVERED.has(o.outcome) || o.outcome === "returned"));
  const view = await inventorySection(storeId, { from: addDays(today, -30), to: addDays(today, -1), today }, currency, 100_000, null, { history, profit: null });
  const variants = await prisma.$queryRaw<Array<{ payload: unknown }>>`
    SELECT payload FROM raw_records WHERE "storeId" = ${storeId} AND app = 'INVENTORIFY' AND entity = 'INVENTORY_VARIANT' AND "deletedAt" IS NULL`;
  const cost = new Map(variants.map((v) => parseVariant(v.payload)).filter((v) => v !== null).map((v) => [v!.variantId, num(v!.unitCost, currency)]));
  // Price a unit sells at, and a return's courier charge per unit, from decided orders.
  const price = new Map<string, { value: number; units: number }>();
  for (const o of history)
    for (const l of o.lines) {
      const v = num(l.value, currency);
      if (!l.variantId || v === null || !l.quantity) continue;
      const e = price.get(l.variantId) ?? { value: 0, units: 0 };
      price.set(l.variantId, { value: e.value + v, units: e.units + l.quantity });
    }
  const returned = history.filter((o) => o.outcome === "returned");
  const fees = returned.map((o) => num(o.courierFee, currency)).filter((x): x is number => x !== null).sort((x, y) => x - y);
  const units = returned.reduce((a, o) => a + o.lines.reduce((s, l) => s + l.quantity, 0), 0);
  const returnPerUnit = fees.length && units ? (quantile(fees, 0.5)! * returned.length) / units : 0;
  return view.rows.map((r) => {
    const unitCost = cost.get(r.variantId) ?? null;
    const p = price.get(r.variantId);
    // The inventory view gives the delivery rate in percent.
    const dr = r.deliveryRate === null ? null : r.deliveryRate / 100;
    return {
      variantId: r.variantId,
      title: r.variantTitle ? `${r.title} – ${r.variantTitle}` : r.title,
      stock: r.stock,
      onOrder: r.onOrder,
      netPerDay: r.netPerDay ?? r.perDay,
      leadTimeDays: r.leadTimeDays,
      leadSource: r.leadSource,
      unitCost,
      unitMargin: unitCost !== null && p?.units && dr !== null ? dr * (p.value / p.units - unitCost) - (1 - dr) * returnPerUnit : null,
    };
  });
}

