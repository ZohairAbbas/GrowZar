import { z } from "zod";

import { MAX_OPEN_SHARE_TO_COMPARE, previousPeriod } from "../../metrics/compare";
import { DIMENSIONS, DIMENSION_LABELS, labelOf, METRICS, METRIC_DEFS, valueOf, type Metric, type Raw } from "../engine";
import { periodArg, periodOf, resolvePeriod } from "../period.server";
import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { breakdown, isRefusal, loadGroups } from "./breakdown.server";
import { filtersArg, limitArg, refusal, screenLink, storeArg } from "./common.server";

/**
 * This period against another, any metric, optionally by a dimension ("which
 * city's delivery rate fell most"). The comparison rules are the screens'
 * (compare.ts): rates in points and only when both periods decided enough
 * orders; counts and money as a relative change; a figure that grows after
 * the period ends is not compared while either period is still settling;
 * nothing is compared against days before the store's history starts.
 */

export const compareSchema = z
  .object({
    store: storeArg,
    metrics: z.array(z.enum(METRICS)).min(1).max(4).describe("1–4 metrics; rows rank by the first metric's change."),
    by: z.enum(DIMENSIONS).describe('Group by this, or "none" for totals.'),
    period: periodArg.nullable(),
    against: periodArg.nullable().describe("The period to compare with. Null for the equal-length period just before."),
    filters: filtersArg,
    order: z.enum(["top", "bottom"]).nullable().describe("top: biggest rise first (default); bottom: biggest fall first."),
    limit: limitArg,
  })
  .strict();

type Args = z.infer<typeof compareSchema>;

/** Change of one metric between two groups; null when the rules say no comparison. */
export function changeOf(metric: Metric, now: Raw | undefined, before: Raw | undefined): { value: number | null; withheld: string | null } {
  const c = now ? valueOf(metric, now) : null;
  const p = before ? valueOf(metric, before) : null;
  if (c === null || p === null) return { value: null, withheld: null };
  if (METRIC_DEFS[metric].outcomeDependent) {
    const open = (r: Raw | undefined) => (r && r.orders ? r.stillOpen / r.orders : 0);
    const worst = Math.max(open(now), open(before));
    if (worst > MAX_OPEN_SHARE_TO_COMPARE) {
      return { value: null, withheld: `${Math.round(100 * open(now))}% of this period's orders and ${Math.round(100 * open(before))}% of the earlier period's are still open` };
    }
  }
  if (METRIC_DEFS[metric].kind === "percent") return { value: Math.round((c - p) * 10) / 10, withheld: null };
  if (p === 0) return { value: null, withheld: null };
  return { value: Math.round((1000 * (c - p)) / Math.abs(p)) / 10, withheld: null };
}

export async function runCompare(args: Args, ctx: AskContext): Promise<ToolResult> {
  const name = "compare_periods";
  const now = await loadGroups(name, { ...args, variant: null }, ctx, (s) => resolvePeriod(args.period, s.timezone, ctx.now));
  if (isRefusal(now)) return now;
  const before = await loadGroups(name, { ...args, variant: null }, ctx, (s) => {
    if (args.against) return resolvePeriod(args.against, s.timezone, ctx.now);
    const p = now.periods[now.stores.indexOf(s)]!;
    return resolvePeriod({ days: null, ...previousPeriod(p.from, p.to) }, s.timezone, ctx.now);
  });
  if (isRefusal(before)) return before;

  // No comparison against days the store's history does not reach (as Home withdraws it).
  const short = now.stores.filter((s, i) => {
    const first = now.historyFrom[i];
    return first === null || first === undefined || first > before.periods[i]!.from;
  });
  if (short.length) {
    return refusal(
      name,
      "not_enough_data",
      `Growzar's history for ${short.map((s) => s.name).join(", ")} starts after ${before.periods[0]!.from}, so the earlier period would be only partly covered. Pick a later comparison period.`,
    );
  }

  const metrics = now.metrics;
  const keys = [...new Set([...now.merged.keys(), ...before.merged.keys()])].filter((k) => !k.startsWith("ads:"));
  const withheld = new Set<string>();
  const rows = keys.map((key) => {
    const row: Record<string, Cell> = args.by === "none" ? {} : { key, label: labelOf(args.by, key, { ...before.labels, ...now.labels }) };
    for (const m of metrics) {
      const a = now.merged.get(key);
      const b = before.merged.get(key);
      row[m] = a ? valueOf(m, a) : null;
      row[`${m}_before`] = b ? valueOf(m, b) : null;
      const ch = changeOf(m, a, b);
      row[`${m}_change`] = ch.value;
      if (ch.withheld) withheld.add(`${METRIC_DEFS[m].label}: not compared, ${ch.withheld}`);
    }
    return row;
  });
  const first = `${metrics[0]}_change`;
  const sign = (args.order ?? "top") === "top" ? -1 : 1;
  rows.sort((x, y) => {
    const a = x[first] as number | null;
    const b = y[first] as number | null;
    return a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : sign * (a - b);
  });
  const limit = Math.min(args.limit ?? 10, 50);

  const columns: Column[] = [
    ...(args.by === "none" ? [] : [{ key: "key", label: "Key", kind: "text" as const }, { key: "label", label: DIMENSION_LABELS[args.by], kind: "text" as const }]),
    ...metrics.flatMap((m): Column[] => {
      const d = METRIC_DEFS[m];
      const money = d.money ? { money: true } : {};
      const cur = d.kind === "money" && now.currency ? { currency: now.currency } : {};
      return [
        { key: m, label: `${d.label}, this period`, kind: d.kind, ...cur, ...money },
        { key: `${m}_before`, label: `${d.label}, earlier period`, kind: d.kind, ...cur, ...money },
        { key: `${m}_change`, label: d.kind === "percent" ? `${d.label} change (points)` : `${d.label} change (%)`, kind: d.kind === "percent" ? "points" : "percent", ...money },
      ];
    }),
  ];
  const single = now.stores.length === 1 ? now.stores[0]! : null;
  const p = now.periods[0]!;
  return {
    tool: name,
    status: now.orders || before.orders ? "ok" : "no_data",
    title: `${metrics.map((m) => METRIC_DEFS[m].label).join(", ")}: this period against the earlier one${args.by === "none" ? "" : ` by ${DIMENSION_LABELS[args.by].toLowerCase()}`}`,
    columns,
    rows: rows.slice(0, limit),
    meta: {
      period: periodOf(p),
      against: periodOf(before.periods[0]!),
      stores: now.stores.map(({ id, name }) => ({ id, name })),
      currency: now.anyMoney ? now.currency : undefined,
      rules: [
        ...metrics.map((m) => METRIC_DEFS[m].rule),
        "Rates change in percentage points, only when both periods have enough decided orders; counts and money change in percent.",
        `Figures that grow after a period ends (deliveries, returns, revenue, profit) are not compared while over ${Math.round(100 * MAX_OPEN_SHARE_TO_COMPARE)}% of either period's orders are still open.`,
      ],
      gaps: [...new Set([...now.gaps, ...before.gaps])],
      notes: [...new Set([...now.notes, ...before.notes]), ...withheld, `${now.orders} orders this period, ${before.orders} in the earlier one`],
      ...(rows.length > limit ? { truncated: { shown: limit, total: rows.length } } : {}),
    },
    // Every screen compares with the previous period itself.
    link: single
      ? { href: screenLink(args.by === "none" ? "home" : "shipping", single, p.query, { city: args.filters?.city ?? null, courier: args.filters?.courier ?? null }), label: "Open the screen", exact: args.by === "none" && !args.against }
      : { href: screenLink("compare", null, p.query), label: "Compare stores", exact: false },
  };
}

export const comparePeriods: AskTool<typeof compareSchema> = {
  name: "compare_periods",
  description:
    "Compare a period with an earlier one (default: the equal-length period just before) for any metric, in total or by a dimension, e.g. 'delivery rate this month vs last month' or 'which city's returns rose most'. Returns this period, the earlier period and the change.",
  schema: compareSchema,
  sections: (args) => breakdown.sections({ ...args, variant: null, only: null }),
  run: runCompare,
};
