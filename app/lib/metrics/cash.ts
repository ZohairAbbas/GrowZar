/**
 * Finance depth (Phase 4c, A1–A4). Pure, over grain rows and Courierify
 * settlements.
 *
 * Four answers Financify cannot give on its own, because each needs to know
 * what happened to the parcel:
 *  - where the period's money went, from gross order value down to profit,
 *    with courier fees as charged (A1);
 *  - what profit to expect once the parcels with couriers settle, using each
 *    city × courier route's own delivery rate (A2);
 *  - where the cash is: not dispatched, with the courier, delivered and
 *    awaiting payout, paid; and which parcels are stuck (A3);
 *  - what couriers deducted from the COD they collected (A4).
 */
import { byCity, byCourier, type Profit, type RollupOrder } from "./rollups";
import { formatAmount, parseAmount, type Money } from "./money";
import { MIN_DECIDED_TO_RATE } from "./compare";
import type { Statement } from "./settlements";

const CANCELLED = ["order_cancelled", "shipment_cancelled"];
const WITH_COURIER = ["in_transit", "booked"];

const units = (m: Money | null | undefined, currency: string) => (m && m.currency === currency ? parseAmount(m.amount)! : 0n);
const money = (u: bigint, currency: string): Money => ({ amount: formatAmount(u), currency });
const sum = (list: readonly RollupOrder[], pick: (o: RollupOrder) => Money | null | undefined, currency: string) =>
  list.reduce((a, o) => a + units(pick(o), currency), 0n);

// ── A1: where the money went ───────────────────────────────────────────────

export type BreakdownLine = {
  key: string;
  label: string;
  /** Signed: a deduction is negative. */
  amount: Money;
  /** Share of net order value, percent, one decimal; null without net value. */
  share: number | null;
  /** A subtotal the lines above add up to. */
  subtotal?: true;
  /** Orders behind the line, where it is a set of orders. */
  orders?: number;
};

/**
 * Gross order value down to profit after returns, in the store's currency.
 * Every subtotal is the sum of the lines above it, and the last line is the
 * same profit `profitAfterReturns` gives, so the breakdown cannot disagree
 * with the headline:
 *
 *   gross − discounts                                  = order value
 *   order value − cancelled                            = net order value
 *   net − not delivered yet − returned − partly − unknown − adjustments
 *                                                      = delivered sales
 *   delivered sales − product cost − courier fees − ads − ad fees
 *                                                      = profit after returns
 *
 * "Adjustments" is the gap between what delivered orders were placed at and
 * what they delivered for (refunds and edits). `ads` is null when profit
 * subtracts none (not every day fetched, or a courier or city is picked);
 * the profit line is then the same figure without ad lines above it.
 */
export function moneyBreakdown(
  rows: readonly RollupOrder[],
  currency: string,
  profit: Profit | null,
  ads: { spend: Money[]; fees: Money[] } | null,
): BreakdownLine[] {
  const inCur = rows.filter((o) => (o.placed?.currency ?? currency) === currency);
  const group = (outcomes: string[]) => inCur.filter((o) => outcomes.includes(o.outcome));
  const placed = (list: readonly RollupOrder[]) => sum(list, (o) => o.placed, currency);

  const orderValue = placed(inCur);
  const discounts = sum(inCur, (o) => o.discounts, currency);
  const cancelled = group(CANCELLED);
  const net = orderValue - placed(cancelled);
  const open = group(["in_transit", "booked", "not_shipped"]);
  const returned = group(["returned"]);
  const partly = group(["partially_delivered"]);
  const unknown = group(["unknown"]);
  const delivered = group(["delivered"]);
  const deliveredSales = sum(delivered, (o) => o.delivered, currency);
  const adjustments = placed(delivered) - deliveredSales;
  const cogs = sum(delivered, (o) => o.cogs, currency);
  const shipped = inCur.filter((o) => ["delivered", "returned", "partially_delivered", "in_transit"].includes(o.outcome));
  const fees = sum(shipped, (o) => o.courierFee, currency);
  const pickAds = (list: Money[]) => list.reduce((a, m) => a + units(m, currency), 0n);

  const share = (u: bigint) => (net > 0n ? Number((u * 1000n) / net) / 10 : null);
  const line = (key: string, label: string, u: bigint, extra: Partial<BreakdownLine> = {}): BreakdownLine => ({
    key,
    label,
    amount: money(u, currency),
    share: share(u),
    ...extra,
  });

  const lines: BreakdownLine[] = [
    line("gross", "Gross order value", orderValue + discounts),
    line("discounts", "Discounts", -discounts),
    ...(cancelled.length ? [line("cancelled", "Cancelled", -placed(cancelled), { orders: cancelled.length })] : []),
    line("net", "Net order value", net, { subtotal: true }),
    line("open", "Not delivered yet", -placed(open), { orders: open.length }),
    line("returned", "Returned", -placed(returned), { orders: returned.length }),
  ];
  if (partly.length) lines.push(line("partly", "Partly delivered (counted as nothing)", -placed(partly), { orders: partly.length }));
  if (unknown.length) lines.push(line("unknown", "Outcome not known", -placed(unknown), { orders: unknown.length }));
  if (adjustments !== 0n) lines.push(line("adjustments", "Refunds and edits on delivered orders", -adjustments));
  lines.push(
    line("delivered", "Delivered sales", deliveredSales, { subtotal: true, orders: delivered.length }),
    line("cogs", "Product cost", -cogs),
    line("fees", "Courier fees", -fees),
  );
  if (ads) {
    lines.push(line("ads", "Ad spend", -pickAds(ads.spend)), line("adFees", "Ad tax & platform fees", -pickAds(ads.fees)));
  }
  // The headline's own figure, so the two can never drift apart.
  if (profit && profit.currency === currency) {
    lines.push(line("profit", "Profit after returns", parseAmount(profit.amount)!, { subtotal: true }));
  }
  return lines;
}

// ── A2: expected profit ─────────────────────────────────────────────────────

/** A route's, courier's or store's delivery odds, and which level gave them. */
export type Odds = { rate: number; level: "route" | "courier" | "store"; decided: number };

/**
 * Delivery odds per route from settled history: city × courier where it has
 * MIN_DECIDED_TO_RATE decided orders, else the courier's, else the store's.
 * History is the caller's choice (the last 90 days, one-sided slices
 * withheld), never the period itself, whose recent orders are mostly open.
 */
export function deliveryOdds(history: readonly RollupOrder[]): (o: RollupOrder) => Odds | null {
  const tally = new Map<string, { delivered: number; decided: number }>();
  const add = (key: string, o: RollupOrder) => {
    const t = tally.get(key) ?? { delivered: 0, decided: 0 };
    t.decided += 1;
    if (o.outcome === "delivered") t.delivered += 1;
    tally.set(key, t);
  };
  for (const o of history) {
    if (o.outcome !== "delivered" && o.outcome !== "returned") continue;
    add(`route|${byCity(o)[0]}|${byCourier(o)[0]}`, o);
    add(`courier|${byCourier(o)[0]}`, o);
    add("store", o);
  }
  const at = (key: string, level: Odds["level"]): Odds | null => {
    const t = tally.get(key);
    return t && t.decided >= MIN_DECIDED_TO_RATE ? { rate: t.delivered / t.decided, level, decided: t.decided } : null;
  };
  return (o) => at(`route|${byCity(o)[0]}|${byCourier(o)[0]}`, "route") ?? at(`courier|${byCourier(o)[0]}`, "courier") ?? at("store", "store");
}

export type ExpectedProfit = {
  /** Realized profit plus what the parcels with couriers are expected to add. */
  amount: Money;
  /** Parcels with couriers counted, and their placed value. */
  withCourier: { orders: number; placed: Money };
  /** Expected delivered sales and product cost from them. */
  expectedSales: Money;
  expectedCost: Money;
  /** How many were priced at each level of odds. */
  levels: Record<Odds["level"], number>;
  /** Orders with couriers that had no odds at all (no settled history). */
  unpriced: number;
  /** Not dispatched yet: left out, since nothing says they will ship. */
  notDispatched: number;
};

/**
 * Realized profit + Σ over parcels with couriers of odds × (order value −
 * product cost). Courier fees on those parcels are already in the realized
 * figure; ads too. Orders not yet dispatched are left out and counted.
 */
export function expectedProfit(
  rows: readonly RollupOrder[],
  realized: Profit,
  odds: (o: RollupOrder) => Odds | null,
): ExpectedProfit {
  const cur = realized.currency;
  const out = rows.filter((o) => WITH_COURIER.includes(o.outcome) && (o.placed?.currency ?? cur) === cur);
  let sales = 0n;
  let cost = 0n;
  const levels = { route: 0, courier: 0, store: 0 };
  let unpriced = 0;
  for (const o of out) {
    const p = odds(o);
    if (!p) {
      unpriced += 1;
      continue;
    }
    levels[p.level] += 1;
    // Basis points, so the arithmetic stays in integers.
    const bp = BigInt(Math.round(p.rate * 10_000));
    sales += (units(o.placed, cur) * bp) / 10_000n;
    cost += (units(o.cogs, cur) * bp) / 10_000n;
  }
  return {
    amount: money(parseAmount(realized.amount)! + sales - cost, cur),
    withCourier: { orders: out.length, placed: money(sum(out, (o) => o.placed, cur), cur) },
    expectedSales: money(sales, cur),
    expectedCost: money(cost, cur),
    levels,
    unpriced,
    notDispatched: rows.filter((o) => o.outcome === "not_shipped").length,
  };
}

// ── A3: where the cash is ──────────────────────────────────────────────────

/** Days in the current status before a parcel counts as stuck. */
export const STUCK_DAYS = { booked: 3, in_transit: 7 } as const;

export const isStuck = (o: RollupOrder, asOf: Date) => {
  if (o.parcelCount === 0 || !o.outcomeTiming) return false;
  const limit = o.outcome === "booked" ? STUCK_DAYS.booked : o.outcome === "in_transit" ? STUCK_DAYS.in_transit : null;
  return limit !== null && (asOf.getTime() - o.outcomeTiming.at.getTime()) / 86_400_000 >= limit;
};

export type CashStage = { key: string; label: string; orders: number; amount: Money };

export type CashTimeline = {
  stages: CashStage[];
  /** Courierify parcels with no status change for STUCK_DAYS, by stage. */
  stuck: { booked: number; inTransit: number; amount: Money };
};

/**
 * The period's orders by where their money is, as of today. Each order is in
 * exactly one stage. "Awaiting payout" counts only payers whose payouts
 * Courierify records (`tracked`); a delivered order of another payer is
 * "payout not tracked", never owed.
 */
export function cashTimeline(
  rows: readonly RollupOrder[],
  currency: string,
  tracked: ReadonlySet<string>,
  asOf: Date,
): CashTimeline {
  const inCur = rows.filter((o) => (o.placed?.currency ?? currency) === currency);
  const payer = (o: RollupOrder) => (o.fulfilledVia ?? o.courier ?? "unknown").toLowerCase();
  const stageOf = (o: RollupOrder): string | null => {
    if (CANCELLED.includes(o.outcome)) return null;
    if (o.outcome === "not_shipped") return "not_dispatched";
    if (o.outcome === "booked") return "booked";
    if (o.outcome === "in_transit") return "with_courier";
    if (o.outcome === "returned") return "returned";
    if (o.outcome === "delivered" || o.outcome === "partially_delivered") {
      if (o.collected && parseAmount(o.collected.amount)! > 0n) return "paid";
      if (o.uncollected && parseAmount(o.uncollected.amount)! > 0n && tracked.has(payer(o))) return "awaiting";
      return "untracked";
    }
    return "unknown";
  };
  const STAGES: Array<{ key: string; label: string; amount: (o: RollupOrder) => Money | null | undefined }> = [
    { key: "not_dispatched", label: "Not dispatched", amount: (o) => o.placed },
    { key: "booked", label: "Booked, not picked up", amount: (o) => o.placed },
    { key: "with_courier", label: "With the courier", amount: (o) => o.placed },
    { key: "awaiting", label: "Delivered, awaiting payout", amount: (o) => o.uncollected },
    { key: "untracked", label: "Delivered, payout not tracked", amount: (o) => o.delivered ?? o.placed },
    { key: "paid", label: "Paid by courier", amount: (o) => o.collected },
    { key: "returned", label: "Returned", amount: (o) => o.placed },
    { key: "unknown", label: "Outcome not known", amount: (o) => o.placed },
  ];
  const by = new Map<string, RollupOrder[]>();
  for (const o of inCur) {
    const s = stageOf(o);
    if (s) by.set(s, [...(by.get(s) ?? []), o]);
  }
  const stuck = inCur.filter((o) => isStuck(o, asOf));
  return {
    stages: STAGES.filter((s) => by.has(s.key)).map((s) => ({
      key: s.key,
      label: s.label,
      orders: by.get(s.key)!.length,
      amount: money(sum(by.get(s.key)!, s.amount, currency), currency),
    })),
    stuck: {
      booked: stuck.filter((o) => o.outcome === "booked").length,
      inTransit: stuck.filter((o) => o.outcome === "in_transit").length,
      amount: money(sum(stuck, (o) => o.placed, currency), currency),
    },
  };
}

// ── A4: what couriers deducted ─────────────────────────────────────────────

export type DeductionRow = {
  payer: string;
  statements: number;
  /** Statements not yet received (pending, disputed). */
  open: number;
  shipments: number;
  cod: Money;
  codFees: Money;
  deliveryFees: Money;
  /** Null when every statement bills returns inside delivery fees (or does not say). */
  returnFees: Money | null;
  tax: Money;
  other: Money;
  carryForward: Money;
  netPaid: Money;
  /**
   * COD − every itemized deduction − carry-forward − net paid: what the
   * courier kept without saying why. Shown so the row adds up.
   */
  unitemized: Money;
  /** (cod − net paid) ÷ cod, percent: what the courier kept. */
  keptShare: number | null;
};

/**
 * Courier statements dated in the period, per payer, in the store's
 * currency: COD collected, what was deducted, and what was paid. Disputed
 * and pending statements are counted and summed but flagged, since their
 * money is not settled.
 */
export function courierDeductions(statements: readonly Statement[], from: string, to: string, currency: string): DeductionRow[] {
  const inPeriod = statements.filter((s) => s.day >= from && s.day <= to);
  const by = new Map<string, Statement[]>();
  for (const s of inPeriod) by.set(s.payer, [...(by.get(s.payer) ?? []), s]);
  const total = (list: Statement[], pick: (s: Statement) => Money | null) =>
    list.reduce((a, s) => a + units(pick(s), currency), 0n);
  return [...by.entries()]
    .map(([payer, list]) => {
      const cod = total(list, (s) => s.totalCod);
      const net = total(list, (s) => s.netPaid);
      const itemized = ["codFees", "deliveryFees", "reversalFees", "withholdingTax", "miscDeduction", "carryForward"] as const;
      const deducted = itemized.reduce((a, k) => a + total(list, (s) => s[k]), 0n);
      return {
        payer,
        statements: list.length,
        open: list.filter((s) => s.status !== "received" && s.status !== "reconciled").length,
        shipments: list.reduce((n, s) => n + s.shipments, 0),
        cod: money(cod, currency),
        codFees: money(total(list, (s) => s.codFees), currency),
        deliveryFees: money(total(list, (s) => s.deliveryFees), currency),
        returnFees: list.some((s) => s.reversalFees) ? money(total(list, (s) => s.reversalFees), currency) : null,
        tax: money(total(list, (s) => s.withholdingTax), currency),
        other: money(total(list, (s) => s.miscDeduction), currency),
        carryForward: money(total(list, (s) => s.carryForward), currency),
        netPaid: money(net, currency),
        unitemized: money(cod - deducted - net, currency),
        keptShare: cod > 0n ? Number(((cod - net) * 1000n) / cod) / 10 : null,
      };
    })
    .sort((a, b) => (parseAmount(b.cod.amount)! > parseAmount(a.cod.amount)! ? 1 : -1));
}
