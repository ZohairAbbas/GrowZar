import { z } from "zod";

import { detectorLabel } from "../../insights/detectors";
import { visibleInsights } from "../../insights/inbox.server";
import { summaryOf } from "../../insights/summary";
import { NO_SCOPE } from "../../metrics/scope";
import { memo, summaryFor } from "../load.server";
import { periodArg, periodOf, resolvePeriod } from "../period.server";
import type { AskContext, AskTool, Cell, ToolResult } from "../types";
import { FORBIDDEN_STORE, oneStoreArg, pickOneStore, refusal, screenLink } from "./common.server";

/**
 * What Growzar recommends now: Home's insights, worded exactly as Home and
 * the weekly digest word them (`summaryOf`), money already stripped for a
 * viewer without Finance (`withoutMoney`). The only advice an answer may
 * give is what these say.
 */

export const insightsSchema = z
  .object({
    store: oneStoreArg,
    insight: z.string().nullable().describe("An insight id from a previous result, to explain that one. Null to list what Growzar recommends now."),
    period: periodArg.nullable(),
  })
  .strict();

export async function runInsights(args: z.infer<typeof insightsSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "insights";
  const store = pickOneStore(ctx, args.store);
  if (store === "ambiguous") return refusal(name, "invalid", "Which store? Insights are per store; call list_stores for the ids.");
  if (!store) return refusal(name, "forbidden", FORBIDDEN_STORE);
  const period = resolvePeriod(args.period, store.timezone, ctx.now);
  if ("error" in period) return refusal(name, "invalid", period.error);
  const s = await summaryFor(ctx, store.id, period, NO_SCOPE);
  const money = ctx.can("finance");
  const found = await memo(ctx, `insights:${store.id}:${period.from}:${period.to}`, () => visibleInsights(s, money, ctx.now));

  const items = args.insight ? found.visible.map((i) => ({ id: found.row.get(i.fingerprint)!.id, insight: i })).filter((x) => x.id === args.insight) : found.items;
  if (args.insight && !items.length) {
    return refusal(name, "no_data", "That insight is not showing for this store and period: it may be resolved, dismissed or snoozed, or belong to another store.");
  }
  const rows: Array<Record<string, Cell>> = items.map(({ id, insight }) => {
    const sm = summaryOf(insight.finding, period.query);
    return {
      key: id,
      label: detectorLabel(insight.detector),
      headline: sm.headline,
      figure: sm.figure,
      note: sm.note,
      next_step: sm.next ?? null,
      why: sm.why ?? null,
      affects: sm.affects,
      orders_affected: insight.rank.ordersAffected,
    };
  });
  const notChecked = found.outcomes.filter((o) => o.status !== "found").map((o) => `${detectorLabel(o.detector)}: ${o.status === "locked" ? "needs another app connected" : o.reason}`);
  const one = args.insight ? items[0] : null;
  return {
    tool: name,
    status: rows.length ? "ok" : "no_data",
    title: one ? "This insight, as Home shows it" : "What Growzar recommends now",
    columns: [
      { key: "key", label: "Insight id", kind: "text" },
      { key: "label", label: "Kind", kind: "text" },
      { key: "headline", label: "Finding", kind: "text" },
      { key: "figure", label: "Figure", kind: "text" },
      { key: "note", label: "Note", kind: "text" },
      { key: "next_step", label: "Next step", kind: "text" },
      { key: "why", label: "Why it matters", kind: "text" },
      { key: "affects", label: "Affects", kind: "text" },
      { key: "orders_affected", label: "Orders affected", kind: "count" },
    ],
    rows,
    meta: {
      period: periodOf(period),
      stores: [{ id: store.id, name: store.name }],
      rules: ["Insights are Growzar's detectors over the period; specific findings first, by how many orders they concern. Their wording is Home's."],
      gaps: [],
      notes: [
        ...(rows.length ? [] : ["Nothing needs attention in this period"]),
        ...(!one && found.visible.length > found.items.length ? [`${found.visible.length - found.items.length} more on the Insights page`] : []),
        ...(one ? [] : notChecked),
      ],
    },
    link: one
      ? { href: `/insights/${one.id}`, label: "Open this insight", exact: true }
      : { href: screenLink("insights", store, period.query), label: "Open Insights", exact: true },
  };
}

export const insights: AskTool<typeof insightsSchema> = {
  name: "insights",
  description: "What Growzar recommends now for one store (its insights, worded as on Home), or one insight explained by id. Use for 'what should I do' questions: these are the only recommendations an answer may give.",
  schema: insightsSchema,
  sections: () => ["home"],
  run: runInsights,
};
