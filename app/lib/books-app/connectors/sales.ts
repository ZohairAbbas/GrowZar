/**
 * Sales into the books (B3), as pure rules: Growzar's data in the shapes
 * Financify's sales rules take (app/lib/books/connectors/shopify-sales.ts,
 * ported unchanged; porting guide §4.3–§4.6).
 *
 * - Orders: Financify's `/api/v1/orders` rows with the order facts added for
 *   Books (D-82): dated refunds with their lines and gateways, successful
 *   transactions, the gateway the unpaid rest is owed through, the
 *   cancellation, whether anything was ever shipped, and the test flag.
 * - Outcomes: Growzar's order grain (delivered or returned, and when), the
 *   same source as Finance, so Books' sales at delivery agree with it (D-69).
 * - "When paid": Courierify's per-parcel settlement date (D-83).
 * - Cost: Financify's cost at sale, else Inventorify's unit cost (D-78).
 */
import type { ManualEvidence, ShopOrder } from "../../books/connectors/shopify-sales";

type Money = { amount?: string | null; currency?: string | null } | null | undefined;

export interface FeedOrder {
  orderId: string;
  orderName?: string | null;
  createdAt: string;
  cancelledAt?: string | null;
  test?: boolean | null;
  currency?: { code?: string | null } | null;
  money?: { placed?: Money; discounts?: Money; shipping?: Money; tax?: Money } | null;
  payment?: { gateways?: string[] | null } | null;
  transactions?: Array<{ kind: string; gateway: string; amount: Money; processedAt?: string }> | null;
  unpaidGateway?: string | null;
  everShipped?: boolean | null;
  lineItems?: Array<{
    lineId?: string | null;
    variantId?: string | null;
    sku?: string | null;
    title?: string | null;
    variantTitle?: string | null;
    quantity?: number | null;
    unitPrice?: Money;
    totalDiscount?: Money;
    unitCost?: Money | string | number | null;
    isGiftCard?: boolean | null;
  }> | null;
  refunds?: Array<{
    createdAt: string;
    total?: Money;
    tax?: Money;
    gateways?: Array<{ gateway: string; amount: Money }> | null;
    lines?: Array<{ lineId?: string | null; quantity?: number | null; amount?: Money; restocked?: boolean | null; isGiftCard?: boolean | null }> | null;
  }> | null;
  orderFacts?: { available?: boolean | null } | null;
}

const amt = (m: Money): string => (m && m.amount != null && m.amount !== "" ? String(m.amount) : "0");

/** Exact decimal arithmetic on strings, at 6 places (finer than any currency). */
const SCALE = 1_000_000n;
function toMicro(s: string): bigint {
  const x = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!x) return 0n;
  const v = BigInt(x[2] || "0") * SCALE + BigInt((x[3] ?? "").slice(0, 6).padEnd(6, "0") || "0");
  return x[1] ? -v : v;
}
function fromMicro(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / SCALE}.${(a % SCALE).toString().padStart(6, "0")}`;
}

function unitCostOf(c: Money | string | number | null | undefined): string | null {
  if (c === null || c === undefined) return null;
  const v = typeof c === "object" ? c.amount : String(c);
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  // Zero and blanks mean "unknown" in Financify and Inventorify alike.
  return Number.isFinite(n) && n > 0 ? String(v) : null;
}

/** Has the feed read this order's facts yet (refunds, transactions, cancellation)? */
export const factsAvailable = (o: FeedOrder) => o.orderFacts?.available === true;

/**
 * A Financify order row → the sales rules' order. `costs` fills a line's cost
 * when Financify has none (Inventorify's unit cost by variant id, D-78).
 */
export function toShopOrder(o: FeedOrder, costs: Map<string, string> = new Map()): ShopOrder {
  const lines = (o.lineItems ?? []).map((l) => {
    const qty = Number(l.quantity ?? 0);
    const total = toMicro(amt(l.unitPrice)) * BigInt(qty) - toMicro(amt(l.totalDiscount));
    const own = unitCostOf(l.unitCost);
    return {
      quantity: qty,
      giftCard: !!l.isGiftCard,
      total: fromMicro(total),
      unitCost: own ?? (l.variantId ? costs.get(String(l.variantId)) ?? null : null),
      lineId: l.lineId ?? null,
      variantId: l.variantId ?? null,
      sku: l.sku ?? null,
      title: [l.title, l.variantTitle].filter(Boolean).join(" / ") || null,
    };
  });
  const costByLine = new Map(lines.filter((l) => l.lineId).map((l) => [String(l.lineId), l.unitCost]));
  const transactions = (o.transactions ?? []).map((t) => ({ kind: t.kind.toUpperCase(), status: "SUCCESS", gateway: t.gateway, amount: amt(t.amount) }));
  const received = transactions.filter((t) => t.kind === "SALE" || t.kind === "CAPTURE").reduce((s, t) => s + toMicro(t.amount), 0n);
  return {
    id: String(o.orderId),
    name: o.orderName ?? `#${o.orderId}`,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt ?? null,
    test: !!o.test,
    currency: o.currency?.code ?? "",
    gateways: o.payment?.gateways ?? [],
    unpaidGateway: o.unpaidGateway ?? null,
    total: amt(o.money?.placed),
    received: fromMicro(received),
    discounts: amt(o.money?.discounts),
    shipping: amt(o.money?.shipping),
    tax: amt(o.money?.tax),
    transactions,
    lines,
    shipped: o.everShipped === null || o.everShipped === undefined ? undefined : o.everShipped,
    refunds: (o.refunds ?? []).map((r) => ({
      createdAt: r.createdAt,
      total: amt(r.total),
      tax: amt(r.tax),
      transactions: (r.gateways ?? []).map((g) => ({ kind: "REFUND", status: "SUCCESS", gateway: g.gateway, amount: amt(g.amount) })),
      lines: (r.lines ?? []).map((l) => ({
        quantity: Number(l.quantity ?? 0),
        restock: !!l.restocked,
        giftCard: !!l.isGiftCard,
        total: amt(l.amount),
        unitCost: l.lineId ? costByLine.get(String(l.lineId)) ?? null : null,
        lineId: l.lineId ?? null,
      })),
    })),
  };
}

/** The order grain's outcome in the delivery words the sales rules read. */
export function statusFromOutcome(outcome: string | null | undefined): string {
  if (outcome === "returned") return "RETURNED";
  if (outcome === "delivered" || outcome === "partially_delivered") return "DELIVERED";
  return "";
}

/**
 * The day each order's sale counts under the store's basis (porting guide §4.3),
 * from what Growzar knows, the earliest evidence winning:
 * - delivery: the order grain says delivered, on its outcome day;
 * - dispatch: the order grain shows it moving, delivered or returned, or a
 *   parcel delivered or returned, on that day (Growzar has no loadsheets yet);
 * - money: Courierify settled the parcel, on the settlement day.
 */
export function releaseDays(
  basis: "delivery" | "dispatch" | "money",
  input: {
    grain: Array<{ orderId: string; outcome: string; day: string | null }>;
    parcels: Array<{ orderId: string; deliveredDay: string | null; returnedDay: string | null; settledDay: string | null }>;
  },
): Map<string, string> {
  const out = new Map<string, string>();
  const note = (id: string, d: string | null) => {
    if (!d) return;
    const was = out.get(id);
    if (!was || d < was) out.set(id, d);
  };
  if (basis === "money") {
    for (const p of input.parcels) note(p.orderId, p.settledDay);
    return out;
  }
  for (const g of input.grain) {
    if (basis === "delivery" && (g.outcome === "delivered" || g.outcome === "partially_delivered")) note(g.orderId, g.day);
    if (basis === "dispatch" && ["in_transit", "delivered", "partially_delivered", "returned"].includes(g.outcome)) note(g.orderId, g.day);
  }
  for (const p of input.parcels) {
    if (basis === "dispatch") {
      note(p.orderId, p.deliveredDay);
      note(p.orderId, p.returnedDay);
    }
    // A settlement that paid it means it was delivered by then.
    note(p.orderId, p.settledDay);
  }
  return out;
}

/** A manual-payment order: a courier parcel means cash on delivery; Growzar can't see own-rider deliveries. */
export function manualEvidence(hasParcel: boolean): ManualEvidence {
  return hasParcel ? "courier" : "none";
}
