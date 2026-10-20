/**
 * The simulator's replay (G-GZR11-5, pack §5.2). Pure.
 *
 * As of a past date, with the budget the store actually spent: for each ad
 * line that then ran, the predicted delivered profit per rupee at the spend
 * it actually had, against what its credited orders over the next `days`
 * days actually made (read today, so they are decided). Pass bar: actual
 * inside low–high on 80% of lines, and bias under 15% on the totals; a level
 * that fails stays grouped at its parent.
 */

import { compare, score, type BacktestReport } from "../backtest";
import { atSpend, buildNodes, rangeFrom, rateDraws } from "./nodes";
import type { SimData } from "./types";

export const REPLAY_DAYS = 30;
export const MAX_BIAS = 0.15;

export type ReplayLine = { key: string; label: string; kind: "campaign" | "platform_group"; spend: number; predicted: { low: number; likely: number; high: number }; actual: number; openShare: number };

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** `then`: the store as at the replay date; `now`: today's data, for what happened after it. */
export function replayAt(then: SimData, now: SimData, { days = REPLAY_DAYS, draws = 500, seed = 11, k }: { days?: number; draws?: number; seed?: number; k?: number } = {}): ReplayLine[] {
  const { nodes } = buildNodes(then, [], k === undefined ? {} : { k });
  const from = then.today;
  const to = addDays(from, days);
  const out: ReplayLine[] = [];
  const ownKeys = new Map<string, Set<string>>();
  for (const n of nodes) if (n.kind === "campaign") ownKeys.set(n.platform, (ownKeys.get(n.platform) ?? new Set()).add(n.key));
  for (const node of nodes) {
    const inLine = (key: string | null, platform: string | null) =>
      platform === node.platform && (node.kind === "campaign" ? key === node.key : !key || !ownKeys.get(node.platform)?.has(key));
    const after = (d: string) => d >= from && d < to;
    // Spend it actually had: the campaign's own rows, or the platform's less its own-line campaigns.
    const spend =
      node.kind === "campaign"
        ? now.spend.filter((s) => s.level === "campaign" && s.key === node.key && after(s.day)).reduce((a, s) => a + s.amount, 0)
        : Math.max(
            0,
            now.spend.filter((s) => s.level === "platform" && s.platform === node.platform && after(s.day)).reduce((a, s) => a + s.amount, 0) -
              now.spend.filter((s) => s.level === "campaign" && s.platform === node.platform && ownKeys.get(node.platform)?.has(s.key) && after(s.day)).reduce((a, s) => a + s.amount, 0),
          );
    if (spend <= 0) continue;
    const orders = now.orders.filter((o) => after(dayOf(o.createdAt)) && inLine(o.campaignKey, o.platform));
    const decided = orders.filter((o) => o.delivered !== null);
    // Orders still open (largely 0dscam-qn's Orio gap) are taken to end like the decided ones.
    const actual = decided.length ? (decided.reduce((a, o) => a + o.contribution, 0) * (orders.length / decided.length)) / spend : 0;
    const daily = spend / days;
    const likely = atSpend(node, node.curve.b, daily, days).contribution / spend;
    const ds = rateDraws(node, draws, seed).map((d) => atSpend({ dailyAvg: node.dailyAvg, perRupee: d.perRupee, ordersPerRupee: d.ordersPerRupee }, d.b, daily, days).contribution / spend);
    out.push({ key: node.key, label: node.label, kind: node.kind, spend, predicted: rangeFrom(ds, likely), actual, openShare: orders.length ? 1 - decided.length / orders.length : 0 });
  }
  return out;
}

/** Score replay lines: coverage of profit per rupee, and bias of total contribution. */
export function scoreReplay(lines: readonly ReplayLine[]): BacktestReport {
  const rows = lines.flatMap((l, i) => compare(String(i), [{ key: l.key, range: l.predicted }], new Map([[l.key, l.actual]])));
  const coverage = score(rows);
  const predicted = lines.reduce((a, l) => a + l.predicted.likely * l.spend, 0);
  const actual = lines.reduce((a, l) => a + l.actual * l.spend, 0);
  const bias = actual !== 0 ? (predicted - actual) / Math.abs(actual) : null;
  return { ...coverage, bias, maxBias: MAX_BIAS, passes: coverage.coverage !== null && coverage.coverage >= coverage.bar && bias !== null && Math.abs(bias) <= MAX_BIAS };
}
