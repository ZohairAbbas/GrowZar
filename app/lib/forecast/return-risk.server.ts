import { prisma } from "../db.server";
import { actionFor, actionHref } from "../apps/app-links";
import { parseFormOrder } from "../metrics/offers";
import { viewerIsInternal } from "../outcomes/results.server";
import { KNOWN_AFTER_DAYS } from "../outcomes/as-of.server";
import { bandOf, fitCuts, reasonsOf, RISK_OPEN_DAYS, RISK_OUTCOMES, RISK_SCREENS, riskPass, scoreOf, type Band, type Cuts, type RiskOrder } from "./return-risk";

/**
 * Return risk for a store's open orders (G-GZR11-4), and the loader its
 * backtest shares.
 *
 * Shown only while the switch is on (`RETURN_RISK_ENABLED`), to internal
 * accounts and to the organizations in `RETURN_RISK_ORGS` (the pilot,
 * approved 2026-10-20; pack §10, P11-14), on stores with Courierify (P11-8:
 * zainvault has no courier data), on orders not yet with the courier: not
 * shipped, or booked and not picked up (P11-9).
 */

const DAY_MS = 86_400_000;
const DELIVERED = new Set(["delivered", "partially_delivered"]);
const TIMED = new Set(["happened_on", "reported_by_3pl"]);

export async function loadRiskOrders(storeId: string, now: Date = new Date()): Promise<RiskOrder[]> {
  const [grain, payments, network, formOrders, preventify] = await Promise.all([
    prisma.orderGrain.findMany({
      where: { storeId, createdAt: { not: null } },
      select: { orderId: true, createdAt: true, outcome: true, outcomeBasis: true, outcomeAt: true, customerId: true, courier: true, city: true, lines: true, confirmation: true, parcelCount: true },
    }),
    prisma.$queryRaw<Array<{ orderId: string; method: string | null }>>`
      SELECT "externalId" AS "orderId", payload->'payment'->>'method' AS method FROM raw_records
      WHERE "storeId" = ${storeId} AND app = 'FINANCIFY' AND entity = 'ORDER' AND "deletedAt" IS NULL`,
    prisma.orderNetwork.findMany({ where: { storeId, status: "ok" }, select: { orderId: true, riskLevel: true, otherStores: true, networkOrders: true, networkReturned: true, fetchedAt: true } }),
    prisma.$queryRaw<Array<{ payload: unknown }>>`
      SELECT payload FROM raw_records WHERE "storeId" = ${storeId} AND app = 'PREVENTIFY' AND entity = 'FORM_ORDER' AND "deletedAt" IS NULL`,
    prisma.appConnection.findFirst({ where: { storeId, app: "PREVENTIFY", status: "CONNECTED" }, select: { app: true } }),
  ]);
  const method = new Map(payments.map((p) => [p.orderId, p.method]));
  const offers = new Map<string, boolean>();
  for (const r of formOrders) {
    const f = parseFormOrder(r.payload);
    if (f) offers.set(f.orderId, f.offers.length > 0);
  }
  const created = new Map(grain.map((g) => [g.orderId, g.createdAt!]));
  const answers = new Map(
    network
      // Asked within a day of the order: a later answer knows returns that came after it.
      .filter((n) => n.riskLevel && created.has(n.orderId) && n.fetchedAt.getTime() - created.get(n.orderId)!.getTime() <= DAY_MS)
      .map((n) => [n.orderId, { level: n.riskLevel!, otherStores: n.otherStores, orders: n.networkOrders, returned: n.networkReturned }]),
  );
  // History starts with the store's courier data: before Courierify, Financify
  // marked every yx4fu1-ax order returned (300 of 300), which would teach the
  // score nothing true.
  const start = grain.filter((g) => g.parcelCount > 0).reduce<Date | null>((a, g) => (!a || g.createdAt! < a ? g.createdAt! : a), null);
  return grain.filter((g) => start && g.createdAt! >= start).map((g) => {
    const decided = DELIVERED.has(g.outcome) || g.outcome === "returned";
    // When the outcome became known, as the as-of rebuild reads it (G-GZR9-1).
    const known = g.outcomeBasis && TIMED.has(g.outcomeBasis) && g.outcomeAt ? g.outcomeAt : new Date(g.createdAt!.getTime() + KNOWN_AFTER_DAYS * DAY_MS);
    const lines = (Array.isArray(g.lines) ? g.lines : []) as Array<{ productId?: string | null; variantId?: string | null; title?: string | null }>;
    const products = [...new Map(lines.filter((l) => l.productId ?? l.variantId).map((l) => [String(l.productId ?? l.variantId), l.title ?? null])).entries()].map(([id, title]) => ({ id, title }));
    const m = method.get(g.orderId);
    return {
      orderId: g.orderId,
      createdAt: g.createdAt!,
      knownAt: decided ? new Date(Math.min(known.getTime(), now.getTime())) : null,
      returned: decided ? g.outcome === "returned" : null,
      customerId: g.customerId,
      courier: g.courier?.replace(/^financify:/, "") ?? null,
      city: g.city,
      products,
      confirmation: g.confirmation,
      payment: m === "cod" || m === "prepaid" ? m : "unknown",
      offerTaken: preventify ? (offers.get(g.orderId) ?? false) : null,
      network: answers.get(g.orderId) ?? null,
    } satisfies RiskOrder;
  });
}

export type OrderRisk = { band: Band; reasons: string[] };
export type StoreRisk = { cuts: Cuts; orders: Map<string, OrderRisk> };

/** The cut-offs from the last 90 days' decided orders, scored as placed; today's open orders scored on all history. */
export function riskOfOpenOrders(orders: readonly RiskOrder[], open: ReadonlySet<string>, now: Date): StoreRisk {
  const pass = riskPass(orders, now);
  const since = now.getTime() - 90 * DAY_MS;
  const cuts = fitCuts(
    orders
      .filter((o) => o.createdAt.getTime() >= since && o.returned !== null)
      .flatMap((o) => {
        const s = pass.atPlacement.get(o.orderId);
        return s ? [{ score: s.score, returned: o.returned! }] : [];
      }),
  );
  const out = new Map<string, OrderRisk>();
  for (const o of orders) {
    if (!open.has(o.orderId)) continue;
    const s = scoreOf(pass.categories.get(o.orderId) ?? [], pass.state);
    if (!s) continue;
    const band = bandOf(s.score, cuts);
    out.set(o.orderId, { band, reasons: reasonsOf(s, band, o.network) });
  }
  return { cuts, orders: out };
}

const cache = new Map<string, { at: number; value: StoreRisk }>();
const CACHE_MS = 5 * 60_000;

/** The kill switch, read like Ask's (ASK_ENABLED). */
export const returnRiskEnabled = () => ["on", "true", "1"].includes((process.env.RETURN_RISK_ENABLED ?? "").trim().toLowerCase());

/**
 * Organizations whose members see return risk, comma-separated ids in
 * RETURN_RISK_ORGS: the pilot's switch until a per-organization setting
 * replaces it at the wider rollout.
 */
export const riskOrgs = (): ReadonlySet<string> =>
  new Set(
    (process.env.RETURN_RISK_ORGS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Whether this viewer sees return risk on this store. */
export async function riskVisible(storeId: string, userId: string): Promise<boolean> {
  if (!returnRiskEnabled()) return false;
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { organizationId: true, connections: { where: { app: "COURIERIFY", status: "CONNECTED" }, select: { app: true } } },
  });
  if (!store?.connections.length) return false;
  return riskOrgs().has(store.organizationId) || (await viewerIsInternal(userId));
}

/** Today's open orders' risk, cached for five minutes per store. */
export async function storeRisk(storeId: string): Promise<StoreRisk> {
  const hit = cache.get(storeId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const now = new Date();
  const open = await prisma.orderGrain.findMany({
    where: { storeId, outcome: { in: [...RISK_OUTCOMES] }, createdAt: { gte: new Date(now.getTime() - RISK_OPEN_DAYS * DAY_MS) } },
    select: { orderId: true },
  });
  const value = riskOfOpenOrders(await loadRiskOrders(storeId, now), new Set(open.map((o) => o.orderId)), now);
  cache.set(storeId, { at: Date.now(), value });
  return value;
}

/** The buttons beside high-risk orders: the confirmation screens of the apps the store has (as I8's card). */
export async function riskActions(storeId: string, shopDomain: string): Promise<Array<{ label: string; href: string }>> {
  const connected = new Set((await prisma.appConnection.findMany({ where: { storeId, status: "CONNECTED" }, select: { app: true } })).map((c) => c.app as string));
  return RISK_SCREENS.flatMap((screen) => {
    const a = actionFor(screen, connected);
    const href = a && !a.install ? actionHref(screen, connected, shopDomain) : null;
    return a && href ? [{ label: a.label, href }] : [];
  });
}
