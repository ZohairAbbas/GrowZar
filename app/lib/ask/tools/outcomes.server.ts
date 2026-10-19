import { z } from "zod";

import { DETECTORS, detectorLabel, type DetectorId } from "../../insights/detectors";
import { resultCounts } from "../../outcomes/line";
import { outcomeLinesOf } from "../../outcomes/results.server";
import type { AskContext, AskTool, Cell, ToolResult } from "../types";
import { FORBIDDEN_STORE, pickStores, refusal, screenLink, storeArg } from "./common.server";

/**
 * What happened after findings were acted on (G-GZR10-7): "did switching
 * courier work?". The Results page's own lines (G-GZR9-5), with its
 * exclusions: placebo watches never, internal ones only to an internal
 * viewer, and none counted that the merchant marked "this wasn't us" or
 * closed. Money only for a viewer who may see Finance, and only the
 * approved, measured amounts the page shows.
 */

export const outcomesSchema = z
  .object({
    store: storeArg,
    detector: z
      .enum(DETECTORS.map((d) => d.id) as [string, ...string[]])
      .nullable()
      .describe("Only findings of this kind (e.g. courier_for_city, cash_held). Null for all."),
    status: z.enum(["watching", "measured"]).nullable().describe("watching: still being measured; measured: final numbers in. Null for both."),
  })
  .strict();

export async function runOutcomes(args: z.infer<typeof outcomesSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "outcomes";
  const stores = pickStores(ctx, args.store);
  if (!stores) return refusal(name, "forbidden", FORBIDDEN_STORE);
  if (!stores.length) return refusal(name, "no_data", "No stores are connected to this organization yet.");
  const lines = await outcomeLinesOf(
    stores.map((s) => s.id),
    { userId: ctx.userId, canSeeMoney: ctx.can("finance") },
  );
  const shown = lines.filter((l) => l.status !== "hidden" && l.status !== "closed" && (!args.detector || l.detector === args.detector) && (!args.status || l.status === args.status));
  const counts = resultCounts(lines);
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const rows: Array<Record<string, Cell>> = shown.map((l) => ({
    key: l.insightId,
    label: detectorLabel(l.detector as DetectorId),
    store: storeName.get(l.storeId) ?? null,
    since: l.since,
    status: l.status === "measured" ? "measured" : "still measuring",
    outcome: l.text,
    signal: l.signal,
  }));
  return {
    tool: name,
    status: shown.length ? "ok" : "no_data",
    title: "What happened after findings were acted on",
    columns: [
      { key: "key", label: "Insight id", kind: "text" },
      { key: "label", label: "Finding", kind: "text" },
      { key: "store", label: "Store", kind: "text" },
      { key: "since", label: "Acted on", kind: "text" },
      { key: "status", label: "Status", kind: "text" },
      { key: "outcome", label: "What happened", kind: "text" },
      { key: "signal", label: "Change seen", kind: "text" },
    ],
    rows,
    meta: {
      stores: stores.map(({ id, name: n }) => ({ id, name: n })),
      rules: [
        "Each line is the Results page's own: the figure before acting, what it is now, and the comparison the measurement uses. A change after acting is not proof the action caused it.",
        "Findings are watched from the day someone opened or acted on them; final numbers come in after the measurement window.",
      ],
      gaps: [],
      notes: [
        `${counts.watched} acted-on finding(s) watched: ${counts.measured} measured, ${counts.watching} still measuring, ${counts.changed} with a change seen`,
        ...(counts.hidden ? [`${counts.hidden} marked "this wasn't us" and left out`] : []),
        ...(shown.length ? [] : ["Nothing acted on has been measured yet for these stores"]),
      ],
    },
    link: { href: screenLink("results", stores.length === 1 ? stores[0]! : null, ""), label: "Open Results", exact: true },
  };
}

export const outcomes: AskTool<typeof outcomesSchema> = {
  name: "outcomes",
  description: "What happened after the merchant acted on Growzar's findings (e.g. 'did switching courier in Lahore work?'), as the Results page measures it: before, now, and whether a change was seen. Never a claim of cause.",
  schema: outcomesSchema,
  sections: () => ["home"],
  run: runOutcomes,
};
