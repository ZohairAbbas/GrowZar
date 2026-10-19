import { z } from "zod";

import { APP_LABELS } from "../../sections";
import { NO_SCOPE } from "../../metrics/scope";
import { coverageFor, summaryFor } from "../load.server";
import { periodArg, periodOf, resolvePeriod } from "../period.server";
import type { AskContext, AskTool, Cell, ToolResult } from "../types";
import { FORBIDDEN_STORE, oneStoreArg, pickOneStore, refusal, screenLink } from "./common.server";

/**
 * Settings → Data coverage as rows (D1): what data is missing for a store,
 * how much of it, why, and what that does to the numbers.
 */

export const coverageSchema = z
  .object({
    store: oneStoreArg,
    period: periodArg.nullable(),
    gaps_only: z.boolean().nullable().describe("True (default) for only what is missing; false for everything, complete or not."),
  })
  .strict();

const STATE: Record<string, string> = { connected: "connected", connected_not_read: "connected, not read yet", not_connected: "not connected" };

export async function runCoverage(args: z.infer<typeof coverageSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "coverage";
  const store = pickOneStore(ctx, args.store);
  if (store === "ambiguous") return refusal(name, "invalid", "Which store? Coverage is per store; call list_stores for the ids.");
  if (!store) return refusal(name, "forbidden", FORBIDDEN_STORE);
  const period = resolvePeriod(args.period, store.timezone, ctx.now);
  if ("error" in period) return refusal(name, "invalid", period.error);
  const s = await summaryFor(ctx, store.id, period, NO_SCOPE);
  const report = await coverageFor(ctx, s);
  const items = args.gaps_only === false ? report.items : report.items.filter((i) => i.status !== "complete");
  const rows: Array<Record<string, Cell>> = items.map((i) => ({
    label: i.label,
    app: APP_LABELS[i.app],
    status: i.status,
    have: i.have,
    of: i.of,
    unit: i.unit,
    gap: i.lineText ?? i.gap,
    effect: i.effect,
    sections: i.sections.join(", "),
  }));
  return {
    tool: name,
    status: "ok",
    title: items.length ? "What data is missing, and what it changes" : "Nothing is missing",
    columns: [
      { key: "label", label: "Data", kind: "text" },
      { key: "app", label: "From", kind: "text" },
      { key: "status", label: "Status", kind: "text" },
      { key: "have", label: "Have", kind: "count" },
      { key: "of", label: "Of", kind: "count" },
      { key: "unit", label: "Unit", kind: "text" },
      { key: "gap", label: "What is missing", kind: "text" },
      { key: "effect", label: "What it does to the numbers", kind: "text" },
      { key: "sections", label: "Sections affected", kind: "text" },
    ],
    rows,
    meta: {
      period: periodOf(period),
      stores: [{ id: store.id, name: store.name }],
      rules: ["Counted over the same orders the screens show for the period."],
      gaps: [],
      notes: [`${report.orders} orders in the period`, ...report.apps.map((a) => `${APP_LABELS[a.app]}: ${STATE[a.state] ?? a.state} — ${a.gives}`)],
    },
    link: { href: screenLink("settings/coverage", store, period.query), label: "Open Data coverage", exact: true },
  };
}

export const coverage: AskTool<typeof coverageSchema> = {
  name: "coverage",
  description: "What data is missing for one store and why (for example product costs on some orders, courier fees, an app not connected or a feed not syncing), and what each gap does to the numbers. Use when a figure looks incomplete.",
  schema: coverageSchema,
  sections: () => ["home"],
  run: runCoverage,
};
