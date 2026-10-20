import { z } from "zod";

import { SECTION_LABELS, type Section } from "../permissions";
import { guard } from "./guard";
import { refusal } from "./tools/common.server";
import { breakdown } from "./tools/breakdown.server";
import { calculate } from "./tools/calculate.server";
import { cash } from "./tools/cash.server";
import { cityCourier } from "./tools/city-courier.server";
import { comparePeriods } from "./tools/compare.server";
import { coverage } from "./tools/coverage.server";
import { customers } from "./tools/customers.server";
import { insights } from "./tools/insights.server";
import { listStores } from "./tools/list-stores.server";
import { marketing } from "./tools/marketing.server";
import { outcomes } from "./tools/outcomes.server";
import { cashForecastTool, monthEndTool, orderRiskSummary, planBudget } from "./tools/plan.server";
import { stock } from "./tools/stock.server";
import { summary } from "./tools/summary.server";
import type { AskContext, AskTool, ToolResult } from "./types";

/**
 * Every tool, and the one door to them (Phase 10, G-GZR10-1).
 *
 * `runTool` is the only caller of a tool's `run`. In order: the arguments are
 * validated again on our side (the provider's strict schema is not trusted
 * alone), the viewer must be able to ask at all (`home:view`) and to view
 * every section the arguments touch, and the result passes `guard` (money
 * stripped for a viewer without Finance, buyer identity never, rows capped)
 * before anything leaves for the model.
 */

export const TOOLS: AskTool[] = [
  listStores, summary, breakdown, comparePeriods, cityCourier, cash, stock, customers, marketing, insights, outcomes, coverage, calculate,
  // Phase 11, offered only where their gate lets the viewer see them; after the rest, so other viewers' prompts keep their bytes.
  cashForecastTool, monthEndTool, orderRiskSummary, planBudget,
] as AskTool[];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** What a refusal for a section says; Finance is the money case. */
function notAllowed(section: Section): string {
  return section === "finance"
    ? "Money figures need access to Finance, which your role does not have. Counts and rates are available."
    : `Your role does not include ${SECTION_LABELS[section]}, so this can't be answered for you.`;
}

export async function runTool(name: string, args: unknown, ctx: AskContext): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) return refusal(name, "invalid", `There is no tool called ${name}.`);
  if (!ctx.can("home")) return refusal(name, "forbidden", notAllowed("home"));

  if (tool.gate && !tool.gate(ctx)) return refusal(name, "forbidden", "This isn't available to you yet.");

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`);
    return refusal(name, "invalid", `The arguments were not valid (${issues.join("; ")}).`);
  }
  for (const section of tool.sections(parsed.data)) {
    if (!ctx.can(section)) return refusal(name, "forbidden", notAllowed(section));
  }
  try {
    return guard(await tool.run(parsed.data, ctx), ctx.can("finance"));
  } catch (e) {
    console.error(`[ask] ${name} failed`, e);
    return refusal(name, "error", "Growzar couldn't load this just now. Try again in a moment.");
  }
}

// ── Schemas for the provider ───────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

/**
 * A tool's arguments as the strict JSON schema function calling takes: every
 * object closed (`additionalProperties: false`) with every property required,
 * optional values written as nullable. Throws on a schema that breaks this,
 * so a tool cannot ship with one (the registry test builds them all).
 */
export function strictSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
  delete json.$schema;
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const n = node as JsonSchema;
    if (n.type === "object") {
      const props = Object.keys((n.properties as JsonSchema | undefined) ?? {});
      const required = (n.required as string[] | undefined) ?? [];
      if (n.additionalProperties !== false) throw new Error(`${path}: object is not closed`);
      const missing = props.filter((p) => !required.includes(p));
      if (missing.length) throw new Error(`${path}: ${missing.join(", ")} not required (make them nullable)`);
    }
    for (const [k, v] of Object.entries(n)) {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${k}[${i}]`));
      else if (v && typeof v === "object") walk(v, `${path}.${k}`);
    }
  };
  walk(json, "$");
  return json;
}

export type ToolSpec = { name: string; description: string; parameters: JsonSchema };

/**
 * The tool list sent with every request, in a fixed order so the prompt prefix
 * stays byte-stable (caching); gated tools only for a viewer their gate lets in.
 */
export function toolSpecs(ctx?: AskContext): ToolSpec[] {
  return TOOLS.filter((t) => !t.gate || (ctx && t.gate(ctx))).map((t) => ({ name: t.name, description: t.description, parameters: strictSchema(t.schema) }));
}
