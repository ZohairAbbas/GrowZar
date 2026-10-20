/**
 * The budget simulator (G-GZR11-5, pack §5.2 and §10). Pure.
 *
 * "I have PKR 100,000 for the next 30 days: where should it go?"
 *
 * 1. The gate: a store that fails is refused with its fix list (P11-2).
 * 2. The cash buffer is filled first: the plan's own daily outlay for the
 *    days from order to cash (budget × delay / (horizon + delay), so the
 *    buffer and the outlay it covers add up to the budget), or the
 *    merchant's minimum if higher.
 * 3. Products the merchant keeps in stock are bought next.
 * 4. The rest goes in steps (P11-12: PKR 5,000, AED 250), each to the option
 *    with the highest delivered profit per rupee it costs: an ad line (a
 *    campaign, or a platform's other campaigns), or stock for a product that
 *    is selling and runs short. An ad step that sells more units than the
 *    shelf holds also buys the stock (if stock is in the plan and arrives in
 *    time); otherwise those sales are not counted. Nothing is spent once no
 *    step earns more than it costs: the rest is kept as cash.
 *
 * Ranges (low / likely / high) come from seeded bootstrap draws of each ad
 * line's orders (and of the curve's bend where it is not stable); the low end
 * is the headline. Returning cash is not spent again within the horizon (v1).
 */

import { DAY_MS, type Range } from "../stats";
import { gateFixes } from "./gate";
import { atSpend, buildNodes, K, MIN_LINE_DAYS, MIN_LINE_ORDERS, rangeFrom, rateDraws, SPEND_CAP, type AdNode } from "./nodes";
import type { Plan, PlanLine, SimData, SimRequest, StockItem } from "./types";

export const DRAWS = 500;
export const SEED = 11;
/** P11-12: the step an allocation moves in, by currency. */
export const STEPS: Record<string, number> = { PKR: 5000, AED: 250 };

export const stepFor = (currency: string, budget: number) => STEPS[currency] ?? Math.max(1, Math.round(budget / 20));

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + Math.round(n) * DAY_MS).toISOString().slice(0, 10);
const fixed = (n: number): Range => ({ low: n, likely: n, high: n });
const sum = (rs: Range[]): Range => rs.reduce((a, r) => ({ low: a.low + r.low, likely: a.likely + r.likely, high: a.high + r.high }), fixed(0));

/** Days from order to cash: delivery, then each payer's lag weighted by its share of COD. */
export function cashDelay(data: SimData, req: Pick<SimRequest, "payoutLags">): { median: number; p90: number; lag: number; estimated: string[] } {
  const known = data.payers.map((p) => ({ ...p, lag: p.basis === "measured" ? p.lag : (req.payoutLags[p.payer] ?? null) })).filter((p) => p.lag !== null);
  const share = known.reduce((a, p) => a + p.share, 0);
  const lag = share ? known.reduce((a, p) => a + p.share * p.lag!, 0) / share : 0;
  const d = data.deliveryDays ?? { median: 0, p90: 0 };
  return { median: d.median + lag, p90: d.p90 + lag, lag, estimated: known.filter((p) => p.basis !== "measured").map((p) => p.payer) };
}

type StockLedger = Map<string, { item: StockItem; free: number; lead: number | null }>;

function ledgerOf(data: SimData, req: SimRequest, unattributedShare: number): StockLedger {
  const out: StockLedger = new Map();
  for (const item of data.stock ?? []) {
    const lead = req.leadTimes[item.variantId] ?? item.leadTimeDays;
    // What the shelf has for the plan's ads: on hand and on order, less what sells without ads.
    out.set(item.variantId, { item, lead, free: item.stock + item.onOrder - item.netPerDay * unattributedShare * req.horizonDays });
  }
  return out;
}

export function simulate(data: SimData, req: SimRequest, { draws = DRAWS, seed = SEED } = {}): Plan {
  const fixes = gateFixes(data, req);
  if (fixes.length) return { status: "refused", asOf: data.asOf.toISOString(), fixes };

  const H = req.horizonDays;
  const step = stepFor(data.currency, req.budget);
  const delay = cashDelay(data, req);
  const cashBackBy = addDays(data.today, H + delay.p90);
  const assumptions: string[] = [];
  const leftOut: string[] = [];
  const lines: PlanLine[] = [];
  let left = req.budget;

  // 1. The buffer.
  const floor = req.include.buffer ? Math.max(req.minBuffer, (req.budget * delay.median) / (H + delay.median)) : req.minBuffer;
  if (floor > 0) {
    const amount = Math.min(left, Math.round(floor));
    left -= amount;
    lines.push({
      kind: "buffer", key: "buffer", label: "Cash buffer", platform: null, amount,
      buys: req.include.buffer
        ? `${Math.round(delay.median)} days of this plan's spending, until the first cash comes back`
        : "the minimum buffer you set",
      deliveredOrders: null, profit: fixed(0), cashBackBy: null, products: [], notes: amount < Math.round(floor) ? ["the budget does not cover the whole buffer"] : [],
    });
  }

  const { nodes, window, unattributedShare, thin } = req.include.ads
    ? buildNodes(data, req.excludePlatforms)
    : { nodes: [] as AdNode[], window: null, unattributedShare: 0, thin: [] };
  const ledger = ledgerOf(data, req, unattributedShare);
  const stockIn = req.include.stock && data.stock !== null;
  const buyable = (v: { item: StockItem; lead: number | null }) => stockIn && v.lead !== null && v.lead < H && v.item.unitCost !== null && v.item.unitCost > 0;
  // Units bought, by why: kept in stock, for an ad line's sales, or for sales without ads.
  const bought = new Map<string, { forced: number; forAds: number; organic: number }>();
  const buy = (variantId: string, why: "forced" | "forAds" | "organic", units: number) => {
    const b = bought.get(variantId) ?? { forced: 0, forAds: 0, organic: 0 };
    b[why] += units;
    bought.set(variantId, b);
  };

  // 2. Products the merchant keeps in stock.
  for (const variantId of req.keepInStock) {
    const v = ledger.get(variantId);
    if (!v) {
      leftOut.push(`keeping ${variantId} in stock: Inventorify does not track it`);
      continue;
    }
    const need = Math.max(0, v.item.netPerDay * H - v.item.stock - v.item.onOrder);
    if (!need) continue;
    if (!buyable(v)) {
      leftOut.push(`keeping ${v.item.title} in stock: ${v.lead === null ? "its lead time is not known" : v.lead >= H ? `its lead time (${v.lead} days) is past the ${H}-day plan` : "its unit cost is not known"}`);
      continue;
    }
    const units = Math.min(need, left / v.item.unitCost!);
    left -= units * v.item.unitCost!;
    v.free += units;
    buy(variantId, "forced", units);
  }

  // 3. Steps.
  const spent = new Map(nodes.map((n) => [n.key, 0]));
  const served = new Map(nodes.map((n) => [n.key, { contribution: 0, orders: 0 }]));
  const stockCandidates = [...ledger].filter(([, v]) => v.item.netPerDay > 0 && v.item.unitMargin !== null && v.item.unitMargin > 0).map(([id]) => id);

  type Option = { kind: "ad"; node: AdNode; gain: number; cost: number; stock: Map<string, number>; dc: number; dOrders: number } | { kind: "stock"; id: string; gain: number; cost: number; units: number };
  const adOption = (node: AdNode, amount: number): Option | null => {
    const x = spent.get(node.key)!;
    if ((x + amount) / H > SPEND_CAP * node.dailyMax) return null;
    const before = atSpend(node, node.curve.b, x / H, H);
    const after = atSpend(node, node.curve.b, (x + amount) / H, H);
    const dOrders = after.orders - before.orders;
    let dc = after.contribution - before.contribution;
    let cost = amount;
    const stock = new Map<string, number>();
    let unitsAll = 0;
    let unitsServed = 0;
    for (const p of node.products) {
      const units = dOrders * p.unitsPerOrder;
      unitsAll += units;
      const v = ledger.get(p.variantId);
      if (!v) {
        unitsServed += units;
        continue;
      }
      const short = Math.max(0, units - Math.max(0, v.free));
      if (short > 0 && buyable(v)) {
        stock.set(p.variantId, short);
        cost += short * v.item.unitCost!;
        unitsServed += units;
      } else unitsServed += units - short;
    }
    if (unitsAll > 0) dc *= unitsServed / unitsAll;
    return { kind: "ad", node, gain: dc - amount, cost, stock, dc, dOrders: unitsAll > 0 ? dOrders * (unitsServed / unitsAll) : dOrders };
  };
  const stockOption = (id: string, amount: number): Option | null => {
    const v = ledger.get(id)!;
    if (!buyable(v) || v.item.unitMargin === null) return null;
    // Units it can still sell within the plan once it arrives, beyond what the shelf already holds.
    const sellable = v.item.netPerDay * (H - v.lead!);
    const short = Math.max(0, -v.free);
    const room = Math.min(short, sellable) - (bought.get(id)?.organic ?? 0);
    if (room <= 0) return null;
    const units = Math.min(room, amount / v.item.unitCost!);
    return { kind: "stock", id, units, cost: units * v.item.unitCost!, gain: units * v.item.unitMargin };
  };

  while (left > 0) {
    const amount = Math.min(step, left);
    const options = [...nodes.map((n) => adOption(n, amount)), ...(stockIn ? stockCandidates.map((id) => stockOption(id, amount)) : [])].filter(
      (o): o is Option => !!o && o.gain > 0 && o.cost <= left + 1e-6,
    );
    if (!options.length) break;
    const best = options.reduce((a, o) => (o.gain / o.cost > a.gain / a.cost ? o : a));
    left -= best.cost;
    if (best.kind === "ad") {
      spent.set(best.node.key, spent.get(best.node.key)! + amount);
      const s = served.get(best.node.key)!;
      s.contribution += best.dc;
      s.orders += best.dOrders;
      for (const p of best.node.products) {
        const v = ledger.get(p.variantId);
        if (v) v.free -= best.dOrders * p.unitsPerOrder;
      }
      for (const [id, units] of best.stock) {
        ledger.get(id)!.free += units;
        buy(id, "forAds", units);
      }
    } else {
      buy(best.id, "organic", best.units);
      ledger.get(best.id)!.free += best.units;
    }
  }

  // Ad lines with their ranges.
  const lineDraws: number[][] = [];
  for (const node of nodes) {
    const x = spent.get(node.key)!;
    if (x <= 0) continue;
    const s = served.get(node.key)!;
    const likely = atSpend(node, node.curve.b, x / H, H);
    const servedShare = likely.contribution ? s.contribution / likely.contribution : 1;
    const ds = rateDraws(node, draws, seed + lines.length).map((d) => atSpend({ dailyAvg: node.dailyAvg, perRupee: d.perRupee, ordersPerRupee: d.ordersPerRupee }, d.b, x / H, H));
    const profitDraws = ds.map((d) => d.contribution * servedShare - x);
    lineDraws.push(profitDraws);
    const titles = new Map((data.stock ?? []).map((i) => [i.variantId, i.title]));
    const notes: string[] = [];
    if (!node.curve.stable) notes.push(`too few days to measure how sales bend with spend on ${node.platform}: the range allows for it`);
    if (servedShare < 0.999) notes.push(`${Math.round((1 - servedShare) * 100)}% of the sales it would make are not counted: the stock can't arrive in time`);
    const stockForLine = node.products.filter((p) => bought.has(p.variantId)).map((p) => titles.get(p.variantId) ?? p.variantId);
    if (stockForLine.length) notes.push(`needs stock of ${stockForLine.slice(0, 3).join(", ")} (in the stock lines)`);
    lines.push({
      kind: node.kind, key: node.key, label: node.kind === "campaign" ? `Campaign ${node.label}` : node.label, platform: node.platform, amount: x,
      buys: `${Math.round(x / H).toLocaleString("en-US")} a day of ${node.platform} ads for ${H} days (it has averaged ${Math.round(node.dailyAvg).toLocaleString("en-US")} a day)`,
      deliveredOrders: rangeFrom(ds.map((d) => d.orders * servedShare), s.orders),
      profit: rangeFrom(profitDraws, s.contribution - x),
      cashBackBy, products: node.products.slice(0, 5).map((p) => ({ variantId: p.variantId, title: titles.get(p.variantId) ?? p.variantId, share: p.share })), notes,
    });
  }

  // Stock lines.
  for (const [id, b] of bought) {
    const v = ledger.get(id)!;
    const units = b.forced + b.forAds + b.organic;
    const amount = units * v.item.unitCost!;
    lines.push({
      kind: "stock", key: `stock:${id}`, label: `Stock: ${v.item.title}`, platform: null, amount,
      buys: `${Math.ceil(units).toLocaleString("en-US")} units at ${Math.round(v.item.unitCost!).toLocaleString("en-US")}, arriving in ${v.lead} days (${v.item.leadSource === "merchant" ? "your lead time" : v.item.leadSource === "measured" ? "measured from your orders to this supplier" : "Inventorify's setting"})`,
      deliveredOrders: null,
      // Stock bought for an ad line earns through that line; only stock sold without ads earns here.
      profit: fixed(b.organic * (v.item.unitMargin ?? 0)),
      cashBackBy: addDays(data.today, H + delay.p90), products: [{ variantId: id, title: v.item.title, share: 1 }],
      notes: [
        ...(b.forced ? ["kept in stock as you asked"] : []),
        ...(b.forAds ? [`${Math.ceil(b.forAds).toLocaleString("en-US")} units for the sales the ad lines make (counted there)`] : []),
      ],
    });
  }

  const allocated = lines.reduce((a, l) => a + l.amount, 0);
  // Totals: ad lines' draws summed draw by draw (independent lines), the rest added as they are.
  const others = lines.filter((l) => l.kind === "buffer" || l.kind === "stock").reduce((a, l) => a + l.profit.likely, 0);
  const totalDraws = lineDraws.length ? lineDraws[0]!.map((_, i) => lineDraws.reduce((a, d) => a + d[i]!, 0) + others) : [others];
  const adLines = lines.filter((l) => l.kind === "campaign" || l.kind === "platform_group");

  assumptions.push(
    `Each ad line is judged on the delivered profit per rupee of the orders Financify credits to it, ${window ? `over ${window.from} to ${window.to}` : "over the last 90 days"} (orders placed 21+ days ago, so they are decided).`,
    `A campaign's figure leans on its platform's until it has many orders: weighted n / (n + ${K}), because the best campaigns tend to fade.`,
    `Sales bend with spend (orders ∝ spend^b, b between 0.5 and 1); a day's spend is never planned above 1.5× the highest the store has spent on that line.`,
    `Ranges allow for each line drifting from its past (measured ${nodes[0] ? `at ±${Math.round((Math.exp(nodes[0].drift) - 1) * 100)}%` : "from the store's lines"}).`,
    `${Math.round(unattributedShare * 100)}% of orders are not credited to any ad and are not counted as ad results.`,
    `Cash comes back about ${Math.round(delay.median)} days after an order (${data.deliveryDays ? `${Math.round(data.deliveryDays.median)} days to deliver` : "delivery time unknown"}, then ${Math.round(delay.lag)} days to be paid)${delay.estimated.length ? `; for ${delay.estimated.join(", ")} the payout lag is your estimate` : ""}.`,
    "Cash that comes back within the plan is not spent again in it.",
  );
  if (!req.include.ads) leftOut.push("ads: left out of this plan");
  for (const p of req.excludePlatforms) leftOut.push(`${p}: left out as you asked`);
  for (const t of thin) leftOut.push(`${t.label}: not enough data to plan (${t.n} decided orders and ${t.spendDays} days of spend; a line needs ${MIN_LINE_ORDERS} and ${MIN_LINE_DAYS})`);
  if (req.include.stock && data.stock === null) leftOut.push("stock: Inventorify is not connected, so stock is not planned");
  if (!req.include.stock) leftOut.push("stock: left out of this plan");
  if (left > 0.5) leftOut.push(`${Math.round(left).toLocaleString("en-US")} kept as cash: no further step earned more than it cost`);
  for (const n of nodes) if (!spent.get(n.key)) leftOut.push(`${n.kind === "campaign" ? `Campaign ${n.label}` : n.label}: no spend, it earned less than other lines`);

  return {
    status: "plan",
    asOf: data.asOf.toISOString(),
    currency: data.currency,
    request: req,
    lines,
    totals: {
      allocated,
      kept: Math.max(0, left),
      deliveredOrders: adLines.length ? sum(adLines.map((l) => l.deliveredOrders!)) : fixed(0),
      profit: rangeFrom(totalDraws, lines.reduce((a, l) => a + l.profit.likely, 0)),
      cashBackBy: adLines.length || bought.size ? cashBackBy : null,
    },
    assumptions,
    leftOut,
  };
}
