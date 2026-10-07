/**
 * Profit by product, city, courier and campaign (Phase 4c). Pure.
 *
 * Every tab adds up to the headline profit after returns, to the cent:
 *
 *  - an order's own money goes to its row exactly: delivered revenue and
 *    product cost (delivered orders), courier fee (shipped orders), and
 *    Financify's other costs (its shipping estimate only where Courierify
 *    recorded no fee) — the same predicates `bucketOf` and
 *    `profitAfterReturns` use;
 *  - an order with several products is split across them: revenue by line
 *    value, product cost by line cost, everything else by line value;
 *  - ad spend (with platform fees) is shared out per tab, and whatever a tab
 *    cannot place goes to its own row rather than vanishing:
 *      product  — Financify's per-product allocation, the rest to
 *                 "ad spend not tied to a product";
 *      campaign — each campaign's own spend, the rest to "ad spend not split
 *                 by campaign";
 *      city, courier — by share of delivered revenue, since ad platforms do
 *                 not report by either.
 *
 * Amounts are integers in millionths throughout, and allocations hand any
 * rounding remainder to the largest row, so nothing is lost.
 */
import { MIN_DECIDED_TO_RATE } from "./compare";
import { formatAmount, parseAmount, type Money } from "./money";
import { byCity, byCourier, type RollupOrder } from "./rollups";

export type ProfitDimension = "product" | "city" | "courier" | "campaign";

export type ProfitRow = {
  key: string;
  /** "row" for a real product/city/…; "ads" for spend no row could take; "rest" for folded small rows. */
  kind: "row" | "ads" | "rest";
  orders: number;
  delivered: number;
  decided: number;
  returned: number;
  revenue: Money;
  productCost: Money;
  courierFees: Money;
  otherCosts: Money;
  ads: Money;
  profit: Money;
  /** profit ÷ delivered revenue, percent; null on under MIN_DECIDED_TO_RATE decided orders. */
  margin: number | null;
  /** returned ÷ decided, percent; null on under MIN_DECIDED_TO_RATE decided orders. */
  returnRate: number | null;
  /** For the folded row: how many rows it holds. */
  folded?: number;
};

export type ProfitTable = {
  dimension: ProfitDimension;
  rows: ProfitRow[];
  total: Money;
  /** How ad spend was shared on this tab, for the footnote. */
  adBasis: "allocated" | "campaign" | "delivered_share" | "none";
};

const SHIPPED = ["delivered", "returned", "partially_delivered", "in_transit"];

type Acc = {
  orders: Set<string>;
  delivered: Set<string>;
  returned: Set<string>;
  revenue: bigint;
  cost: bigint;
  fees: bigint;
  other: bigint;
  ads: bigint;
};
const acc = (): Acc => ({ orders: new Set(), delivered: new Set(), returned: new Set(), revenue: 0n, cost: 0n, fees: 0n, other: 0n, ads: 0n });

/** Split `total` across weights, exactly: the remainder goes to the largest weight. */
export function shareOut(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (sum <= 0n || !weights.length) return weights.map((_, i) => (i === 0 ? total : 0n));
  const parts = weights.map((w) => (total * w) / sum);
  const rest = total - parts.reduce((a, p) => a + p, 0n);
  let big = 0;
  weights.forEach((w, i) => {
    if (w > weights[big]!) big = i;
  });
  parts[big] = parts[big]! + rest;
  return parts;
}

export type ProfitTableInput = {
  rows: readonly RollupOrder[];
  currency: string;
  /** Ad spend + platform fees for the period, when profit subtracts it; null otherwise. */
  ads: bigint | null;
  /** Financify's per-variant allocation of spend (product tab). */
  adByVariant?: ReadonlyMap<string, bigint>;
  /** Spend Financify could not tie to any product (product tab). */
  adUnattributed?: bigint;
  /** Spend + fees per campaign key in the period (campaign tab). */
  adByCampaign?: ReadonlyMap<string, bigint>;
  /** Order → campaign key (campaign tab). */
  campaignOf?: ReadonlyMap<string, string | null>;
  /** Rows kept before the rest are folded into one. */
  maxRows?: number;
};

const AD_ROW: Record<ProfitDimension, string> = {
  product: "Ad spend not tied to a product",
  campaign: "Ad spend not split by campaign",
  city: "Ad spend",
  courier: "Ad spend",
};

export function profitTable(dimension: ProfitDimension, input: ProfitTableInput): ProfitTable {
  const { currency } = input;
  const u = (m: Money | null | undefined) => (m && m.currency === currency ? parseAmount(m.amount)! : 0n);
  const by = new Map<string, Acc>();
  const at = (k: string) => {
    const a = by.get(k) ?? acc();
    by.set(k, a);
    return a;
  };

  for (const o of input.rows) {
    const delivered = o.outcome === "delivered";
    const revenue = delivered ? u(o.delivered) : 0n;
    const cost = delivered ? u(o.cogs) : 0n;
    const fee = SHIPPED.includes(o.outcome) ? u(o.courierFee) : 0n;
    const oc = o.otherCosts;
    const other = oc ? u(oc.payment) + u(oc.taxes) + u(oc.custom) + (o.courierFee ? 0n : u(oc.shipping)) : 0n;

    // Which rows the order belongs to, and its weights across them.
    let parts: Array<{ key: string; byValue: bigint; byCost: bigint }>;
    if (dimension === "product") {
      const lines = o.lines.length ? o.lines : [{ variantId: null, productId: null, value: null, cost: null, quantity: 0 }];
      parts = lines.map((l) => ({
        key: l.variantId ?? `product:${l.productId ?? "unknown"}`,
        byValue: u(l.value),
        byCost: u(l.cost),
      }));
    } else {
      const key =
        dimension === "city" ? byCity(o)[0]! : dimension === "courier" ? byCourier(o)[0]! : (input.campaignOf?.get(o.orderId) ?? "none");
      parts = [{ key, byValue: 1n, byCost: 1n }];
    }
    const valueW = parts.map((p) => p.byValue);
    const costW = parts.map((p) => (parts.some((x) => x.byCost > 0n) ? p.byCost : p.byValue));
    const revs = shareOut(revenue, valueW);
    const costs = shareOut(cost, costW);
    const feesOut = shareOut(fee, valueW);
    const others = shareOut(other, valueW);
    parts.forEach((p, i) => {
      const a = at(p.key);
      a.orders.add(o.orderId);
      if (delivered) a.delivered.add(o.orderId);
      if (o.outcome === "returned") a.returned.add(o.orderId);
      a.revenue += revs[i]!;
      a.cost += costs[i]!;
      a.fees += feesOut[i]!;
      a.other += others[i]!;
    });
  }

  // Ad spend, shared per tab; what no row takes gets its own row.
  let adBasis: ProfitTable["adBasis"] = "none";
  let unplaced = 0n;
  if (input.ads !== null && input.ads !== 0n) {
    const keys = [...by.keys()];
    if (dimension === "product" && input.adByVariant?.size) {
      adBasis = "allocated";
      // Financify's allocation is spend before fees, over all its product-level
      // spend; scale each variant's share to spend + fees. The unattributed
      // share is what lands on the "not tied to a product" row.
      const productLevel = [...input.adByVariant.values()].reduce((a, v) => a + v, 0n) + (input.adUnattributed ?? 0n);
      if (productLevel > 0n) {
        for (const [v, spend] of input.adByVariant) at(v).ads += (input.ads * spend) / productLevel;
      }
      unplaced = input.ads - [...by.values()].reduce((a, x) => a + x.ads, 0n);
    } else if (dimension === "campaign" && input.adByCampaign?.size) {
      adBasis = "campaign";
      const campaignTotal = [...input.adByCampaign.values()].reduce((a, v) => a + v, 0n);
      // Campaign rows are measured spend; scale down only if they exceed the total.
      const scale = campaignTotal > input.ads;
      for (const [k, spend] of input.adByCampaign) at(k).ads += scale ? (input.ads * spend) / campaignTotal : spend;
      unplaced = input.ads - [...by.values()].reduce((a, x) => a + x.ads, 0n);
    } else if (dimension === "city" || dimension === "courier") {
      adBasis = "delivered_share";
      const weights = keys.map((k) => by.get(k)!.revenue);
      const any = weights.some((w) => w > 0n);
      const out = shareOut(input.ads, any ? weights : keys.map((k) => BigInt(by.get(k)!.orders.size)));
      keys.forEach((k, i) => (by.get(k)!.ads += out[i]!));
    } else {
      unplaced = input.ads;
    }
  }

  const money = (v: bigint): Money => ({ amount: formatAmount(v), currency });
  const toRow = (key: string, a: Acc, kind: ProfitRow["kind"] = "row"): ProfitRow => {
    const profit = a.revenue - a.cost - a.fees - a.other - a.ads;
    const decided = a.delivered.size + a.returned.size;
    const rated = decided >= MIN_DECIDED_TO_RATE;
    return {
      key,
      kind,
      orders: a.orders.size,
      delivered: a.delivered.size,
      decided,
      returned: a.returned.size,
      revenue: money(a.revenue),
      productCost: money(a.cost),
      courierFees: money(a.fees),
      otherCosts: money(a.other),
      ads: money(a.ads),
      profit: money(profit),
      margin: rated && a.revenue > 0n ? Number((profit * 1000n) / a.revenue) / 10 : null,
      returnRate: rated ? Math.round((1000 * a.returned.size) / decided) / 10 : null,
    };
  };

  const ranked = [...by.entries()]
    .map(([k, a]) => toRow(k, a))
    .sort((x, y) => y.orders - x.orders || x.key.localeCompare(y.key));
  const keep = input.maxRows ?? 15;
  const rows = ranked.slice(0, keep);
  if (ranked.length > keep) {
    const rest = acc();
    for (const r of ranked.slice(keep)) {
      const a = by.get(r.key)!;
      a.orders.forEach((x) => rest.orders.add(x));
      a.delivered.forEach((x) => rest.delivered.add(x));
      a.returned.forEach((x) => rest.returned.add(x));
      rest.revenue += a.revenue;
      rest.cost += a.cost;
      rest.fees += a.fees;
      rest.other += a.other;
      rest.ads += a.ads;
    }
    rows.push({ ...toRow("other", rest, "rest"), folded: ranked.length - keep });
  }
  // Under one currency unit is integer-division rounding, not spend nobody
  // took: it joins the row with the most orders rather than making a row of
  // its own.
  if (unplaced !== 0n && (unplaced >= 1_000_000n || unplaced <= -1_000_000n)) {
    const a = acc();
    a.ads = unplaced;
    rows.push(toRow(AD_ROW[dimension], a, "ads"));
  } else if (unplaced !== 0n && rows.length) {
    const first = rows[0]!;
    rows[0] = {
      ...first,
      ads: money(parseAmount(first.ads.amount)! + unplaced),
      profit: money(parseAmount(first.profit.amount)! - unplaced),
    };
  }
  const total = rows.reduce((t, r) => t + parseAmount(r.profit.amount)!, 0n);
  return { dimension, rows, total: money(total), adBasis };
}
