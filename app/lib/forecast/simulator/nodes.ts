/**
 * The ad hierarchy the simulator allocates over (G-GZR11-5, P11-3). Pure.
 *
 *   platform (measured spend)
 *     └── campaign (measured spend + orders Financify credits to it)
 *           └── products it sold (order lines)
 *
 * Each node is judged on delivered profit per rupee of spend: the
 * contribution of the orders credited to it (delivered revenue − product
 * cost − courier fees − other costs, Finance's rules) over its spend. Read
 * over the 90 days ending MATURE_DAYS ago, so those orders are decided.
 *
 * A campaign's figure is pooled with its platform's, by weight n / (n + K)
 * for its n decided orders: a thin campaign reads close to its platform. A
 * campaign gets its own plan line with MIN_LINE_ORDERS decided orders and
 * MIN_LINE_DAYS days of spend; the rest are grouped per platform. Campaign
 * lines are off for now (CAMPAIGN_LINES): one line per platform. A platform
 * line needs the same data as a campaign line, or it is left out as too thin
 * to plan (2026-10-20, Zohair: in the replay, a platform with PKR 8,422 of
 * spend was the line furthest out).
 */

import { DAY_MS, quantile, rng, type Range } from "../stats";
import type { SimData, SimOrder } from "./types";

export const WINDOW_DAYS = 90;
export const MATURE_DAYS = 21;
/**
 * Pooling constant: orders a campaign needs to weigh as much as its platform.
 * Set by the replay (2026-10-20, 0dscam-qn): 30 put 78% of lines inside
 * low–high, 100 put 89%; best campaigns fade, so they lean on their platform.
 */
export const K = 100;
/**
 * Campaigns as their own plan lines. Off (2026-10-20, Zohair, option (a)): in
 * the replay, campaign lines read 28% high and platform groups 20% low; the
 * pack keeps a level that fails grouped at its parent. Turn on once a
 * campaign-level replay has its bias under 15%.
 */
export const CAMPAIGN_LINES = false;
export const MIN_LINE_ORDERS = 30;
export const MIN_LINE_DAYS = 14;
/** Never plan a day's spend above this multiple of the highest the store has spent on the line. */
export const SPEND_CAP = 1.5;
export const B_BOUNDS = [0.5, 1] as const;
export const B_DEFAULT = 0.7;
const MIN_FIT_DAYS = 20;
const MAX_B_SE = 0.25;

export type Curve = { b: number; stable: boolean; days: number };

export type AdNode = {
  key: string;
  kind: "campaign" | "platform_group";
  platform: string;
  label: string;
  spend: number;
  spendDays: number;
  /** Average spend a day on the days it ran, and the highest. */
  dailyAvg: number;
  dailyMax: number;
  orders: SimOrder[];
  /** Decided orders credited to it. */
  n: number;
  /** Pooled contribution and delivered orders per rupee of spend. */
  perRupee: number;
  ordersPerRupee: number;
  weight: number;
  /** Units sold by variant, as shares of the node's units. */
  products: Array<{ variantId: string; share: number; unitsPerOrder: number }>;
  curve: Curve;
  /** The platform's own figures, which the node is pooled toward. */
  platformRate: { perRupee: number; ordersPerRupee: number };
  /** How far a line's profit per rupee moves from one stretch of weeks to the next (log scale, store-wide). */
  drift: number;
};

/**
 * Drift: a line's profit per rupee does not hold still (winning campaigns
 * fade; the replay showed 2.0 becoming 0.9–1.4). Measured at the date from
 * the window's own two halves: the spread of log(second half ÷ first half)
 * across lines with MIN_DRIFT_ORDERS decided orders in each half.
 * DRIFT_DEFAULT when fewer than MIN_DRIFT_LINES lines can be measured.
 */
export const MIN_DRIFT_ORDERS = 10;
export const MIN_DRIFT_LINES = 3;
export const DRIFT_DEFAULT = 0.5;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const normal = (next: () => number) => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

export function windowOf(data: Pick<SimData, "asOf" | "spend">): { from: string; to: string; days: number } {
  const to = new Date(data.asOf.getTime() - MATURE_DAYS * DAY_MS);
  const firstSpend = data.spend.map((s) => s.day).sort()[0] ?? dayOf(to);
  const from = [dayOf(new Date(to.getTime() - WINDOW_DAYS * DAY_MS)), firstSpend].sort().at(-1)!;
  const days = Math.max(0, Math.round((Date.parse(`${dayOf(to)}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS));
  return { from, to: dayOf(to), days };
}

/** orders ∝ spend^b on a platform's days, b bounded; B_DEFAULT when the fit is thin or loose. */
export function fitCurve(days: ReadonlyArray<{ spend: number; orders: number }>): Curve {
  const pts = days.filter((d) => d.spend > 0 && d.orders > 0).map((d) => ({ x: Math.log(d.spend), y: Math.log(d.orders) }));
  if (pts.length < MIN_FIT_DAYS) return { b: B_DEFAULT, stable: false, days: pts.length };
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (sxx === 0) return { b: B_DEFAULT, stable: false, days: pts.length };
  const b = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx;
  const resid = pts.reduce((a, p) => a + (p.y - my - b * (p.x - mx)) ** 2, 0) / Math.max(1, pts.length - 2);
  const se = Math.sqrt(resid / sxx);
  if (se > MAX_B_SE) return { b: B_DEFAULT, stable: false, days: pts.length };
  return { b: Math.min(B_BOUNDS[1], Math.max(B_BOUNDS[0], b)), stable: true, days: pts.length };
}

function productsOf(orders: readonly SimOrder[]) {
  const units = new Map<string, number>();
  for (const o of orders) for (const l of o.lines) units.set(l.variantId, (units.get(l.variantId) ?? 0) + l.quantity);
  const total = [...units.values()].reduce((a, x) => a + x, 0);
  return [...units.entries()]
    .map(([variantId, u]) => ({ variantId, share: total ? u / total : 0, unitsPerOrder: orders.length ? u / orders.length : 0 }))
    .sort((a, b) => b.share - a.share);
}

/** The plan's ad lines: campaigns with enough data on their own, the rest grouped per platform. */
export function buildNodes(
  data: SimData,
  excludePlatforms: readonly string[] = [],
  { k = K, campaignLines = CAMPAIGN_LINES }: { k?: number; campaignLines?: boolean } = {},
): {
  nodes: AdNode[];
  window: ReturnType<typeof windowOf>;
  unattributedShare: number;
  drift: { value: number; lines: number };
  /** Platform lines left out as too thin to plan. */
  thin: Array<{ label: string; n: number; spendDays: number }>;
} {
  const win = windowOf(data);
  const inWindow = (d: string) => d >= win.from && d < win.to;
  const spend = data.spend.filter((s) => inWindow(s.day));
  const placed = data.orders.filter((o) => {
    const d = dayOf(o.createdAt);
    return d >= win.from && d < win.to;
  });
  const decided = placed.filter((o) => o.delivered !== null);
  const unattributedShare = placed.length ? placed.filter((o) => !o.campaignKey && !o.platform).length / placed.length : 0;
  const excluded = new Set(excludePlatforms.map((p) => p.toLowerCase()));
  const platforms = [...new Set(spend.map((s) => s.platform.toLowerCase()))].filter((p) => !excluded.has(p)).sort();

  const nodes: AdNode[] = [];
  const rest: AdNode[] = [];
  for (const platform of platforms) {
    // A platform's own daily rows; where Financify sent none (yx4fu1-ax's Snapchat), its campaigns' sum.
    const own = spend.filter((s) => s.level === "platform" && s.platform.toLowerCase() === platform);
    const pSpendDays = own.length
      ? own
      : [...spend.filter((s) => s.level === "campaign" && s.platform.toLowerCase() === platform).reduce((m, s) => m.set(s.day, (m.get(s.day) ?? 0) + s.amount), new Map<string, number>())].map(
          ([day, amount]) => ({ day, level: "platform" as const, key: platform, platform, amount }),
        );
    const pSpend = pSpendDays.reduce((a, s) => a + s.amount, 0);
    if (pSpend <= 0) continue;
    const pOrders = decided.filter((o) => o.platform?.toLowerCase() === platform);
    const pRate = { perRupee: pOrders.reduce((a, o) => a + o.contribution, 0) / pSpend, ordersPerRupee: pOrders.filter((o) => o.delivered).length / pSpend };
    // Daily spend against orders placed that day, for the curve.
    const byDay = new Map<string, { spend: number; orders: number }>();
    for (const s of pSpendDays) byDay.set(s.day, { spend: (byDay.get(s.day)?.spend ?? 0) + s.amount, orders: 0 });
    for (const o of pOrders) {
      const e = byDay.get(dayOf(o.createdAt));
      if (e && o.delivered) e.orders += 1;
    }
    const curve = fitCurve([...byDay.values()]);

    const campaigns = new Map<string, { spend: number; days: Map<string, number> }>();
    for (const s of spend.filter((x) => x.level === "campaign" && x.platform.toLowerCase() === platform)) {
      const c = campaigns.get(s.key) ?? { spend: 0, days: new Map() };
      c.spend += s.amount;
      c.days.set(s.day, (c.days.get(s.day) ?? 0) + s.amount);
      campaigns.set(s.key, c);
    }
    const node = (key: string, kind: AdNode["kind"], label: string, s: number, days: number[], orders: SimOrder[]): AdNode => {
      const n = orders.length;
      const w = n / (n + k);
      const own = { perRupee: orders.reduce((a, o) => a + o.contribution, 0) / s, ordersPerRupee: orders.filter((o) => o.delivered).length / s };
      return {
        key, kind, platform, label, spend: s, spendDays: days.length,
        dailyAvg: days.length ? s / days.length : 0, dailyMax: days.length ? Math.max(...days) : 0,
        orders, n, weight: w,
        perRupee: w * own.perRupee + (1 - w) * pRate.perRupee,
        ordersPerRupee: w * own.ordersPerRupee + (1 - w) * pRate.ordersPerRupee,
        products: productsOf(orders), curve, platformRate: pRate, drift: DRIFT_DEFAULT,
      };
    };
    const lines: AdNode[] = [];
    for (const [key, c] of campaigns) {
      const orders = pOrders.filter((o) => o.campaignKey === key);
      if (campaignLines && orders.length >= MIN_LINE_ORDERS && c.days.size >= MIN_LINE_DAYS && c.spend > 0)
        lines.push(node(key, "campaign", data.campaignNames.get(key) ?? key, c.spend, [...c.days.values()], orders));
    }
    nodes.push(...lines);
    const ownKeys = new Set(lines.map((n) => n.key));
    const restSpend = pSpend - lines.reduce((a, n) => a + n.spend, 0);
    const restDays = pSpendDays.map((d) => d.amount - lines.reduce((a, n) => a + (campaigns.get(n.key)?.days.get(d.day) ?? 0), 0)).filter((x) => x > 0);
    if (restSpend > 0) rest.push(node(`${platform}:other`, "platform_group", lines.length ? `Other campaigns on ${platform}` : `${platform[0]!.toUpperCase()}${platform.slice(1)} ads`, restSpend, restDays, pOrders.filter((o) => !o.campaignKey || !ownKeys.has(o.campaignKey))));
  }
  // A platform line needs what a campaign line needs; thinner ones are left out.
  const thin: Array<{ label: string; n: number; spendDays: number }> = [];
  for (const g of rest) {
    if (g.n >= MIN_LINE_ORDERS && g.spendDays >= MIN_LINE_DAYS) nodes.push(g);
    else thin.push({ label: g.label, n: g.n, spendDays: g.spendDays });
  }

  // Drift, from the window's halves, for every line with enough orders in each.
  const mid = new Date((Date.parse(`${win.from}T00:00:00Z`) + Date.parse(`${win.to}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
  const logs: number[] = [];
  for (const n of nodes) {
    const half = (lo: string, hi: string) => {
      const o = n.orders.filter((x) => dayOf(x.createdAt) >= lo && dayOf(x.createdAt) < hi);
      const sp = spend
        .filter((x) => x.day >= lo && x.day < hi && x.platform.toLowerCase() === n.platform && (n.kind === "campaign" ? x.level === "campaign" && x.key === n.key : x.level === "platform"))
        .reduce((a, x) => a + x.amount, 0);
      return { n: o.length, rate: sp > 0 ? o.reduce((a, x) => a + x.contribution, 0) / sp : null };
    };
    const a = half(win.from, mid);
    const b = half(mid, win.to);
    if (a.n >= MIN_DRIFT_ORDERS && b.n >= MIN_DRIFT_ORDERS && a.rate && b.rate && a.rate > 0 && b.rate > 0) logs.push(Math.log(b.rate / a.rate));
  }
  const drift = logs.length >= MIN_DRIFT_LINES ? Math.sqrt(logs.reduce((x, l) => x + l * l, 0) / logs.length) : DRIFT_DEFAULT;
  for (const n of nodes) n.drift = drift;
  return { nodes, window: win, unattributedShare, drift: { value: drift, lines: logs.length }, thin };
}

/**
 * Contribution and delivered orders over `horizon` days at `daily` spend a
 * day: the node's rate at its own average spend, bent by orders ∝ spend^b.
 */
export function atSpend(node: Pick<AdNode, "dailyAvg" | "perRupee" | "ordersPerRupee">, b: number, daily: number, horizon: number) {
  if (daily <= 0 || node.dailyAvg <= 0) return { contribution: 0, orders: 0 };
  const scale = (daily / node.dailyAvg) ** b;
  return { contribution: node.perRupee * node.dailyAvg * scale * horizon, orders: node.ordersPerRupee * node.dailyAvg * scale * horizon };
}

/**
 * The node's rate as bootstrap draws: its orders resampled (seeded), pooled
 * with its platform as the point figure is, moved by one draw of the drift;
 * and b drawn across its bounds when the curve is not stable (the range
 * widens instead of trusting 0.7).
 */
export function rateDraws(node: AdNode, draws: number, seed: number): Array<{ perRupee: number; ordersPerRupee: number; b: number }> {
  const next = rng(seed);
  const out = [];
  for (let k = 0; k < draws; k++) {
    let c = 0;
    let d = 0;
    for (let i = 0; i < node.n; i++) {
      const o = node.orders[Math.floor(next() * node.n)]!;
      c += o.contribution;
      if (o.delivered) d += 1;
    }
    const w = node.weight;
    // And how far the line may drift by the time the plan runs.
    const move = Math.exp(normal(next) * node.drift);
    out.push({
      perRupee: (w * (c / node.spend) + (1 - w) * node.platformRate.perRupee) * move,
      ordersPerRupee: (w * (d / node.spend) + (1 - w) * node.platformRate.ordersPerRupee) * move,
      b: node.curve.stable ? node.curve.b : B_BOUNDS[0] + next() * (B_BOUNDS[1] - B_BOUNDS[0]),
    });
  }
  return out;
}

export const rangeFrom = (xs: number[], likely: number): Range => {
  const s = [...xs].sort((a, b) => a - b);
  return { low: Math.min(quantile(s, 0.1) ?? likely, likely), likely, high: Math.max(quantile(s, 0.9) ?? likely, likely) };
};
