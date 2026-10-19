import { z } from "zod";

import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { refusal } from "./common.server";

/**
 * Arithmetic on figures the tools already returned (agreed 2026-10-19,
 * option C): shares, differences, ratios, changes and sums. The model never
 * does arithmetic; it names cells ("table 1, row Lahore, column orders") and
 * this computes, so the result is a tool result like any other and passes
 * the number check. No literal number can be passed in.
 */

const ref = z
  .object({
    table: z.number().int().min(1).describe("The table number from an earlier tool result in this answer."),
    row: z.string().nullable().describe("The row's key or label (as the table shows it). Null for a table with one row."),
    column: z.string().describe("The column key, e.g. orders, profit, delivery_rate."),
  })
  .strict();

export const calculateSchema = z
  .object({
    op: z
      .enum(["sum", "difference", "ratio", "share", "percent_change"])
      .describe("sum: add 2–10 values. difference: first − second. ratio: first ÷ second. share: first as a percent of second. percent_change: from second to first, in percent."),
    values: z.array(ref).min(2).max(10).describe("The cells to use, in order."),
  })
  .strict();

type Args = z.infer<typeof calculateSchema>;
type Picked = { table: number; row: string; column: Column; value: number };

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function pick(ctx: AskContext, r: Args["values"][number]): Picked | string {
  const t: ToolResult | undefined = ctx.tables?.[r.table - 1];
  if (!t) return `There is no table ${r.table} in this answer.`;
  if (t.status !== "ok") return `Table ${r.table} has no figures (${t.status}).`;
  const column = t.columns.find((c) => c.key === r.column);
  if (!column) return `Table ${r.table} has no column ${r.column}.`;
  if (column.kind === "text" || column.kind === "date") return `Column ${r.column} of table ${r.table} is not a figure.`;
  const wanted = r.row?.trim().toLowerCase();
  const rows = wanted === undefined ? (t.rows.length === 1 ? t.rows : []) : t.rows.filter((x) => String(x.key ?? "").toLowerCase() === wanted || String(x.label ?? "").toLowerCase() === wanted);
  if (rows.length !== 1) return wanted === undefined ? `Table ${r.table} has several rows: name one.` : `Table ${r.table} has no single row "${r.row}".`;
  const v: Cell | undefined = rows[0]![r.column];
  if (typeof v !== "number") return `Table ${r.table}, ${r.row ?? "its row"}, ${r.column} has no value (not enough data).`;
  return { table: r.table, row: String(rows[0]!.label ?? rows[0]!.key ?? r.row ?? "total"), column, value: v };
}

export async function runCalculate(args: Args, ctx: AskContext): Promise<ToolResult> {
  const name = "calculate";
  const picked: Picked[] = [];
  for (const r of args.values) {
    const p = pick(ctx, r);
    if (typeof p === "string") return refusal(name, "invalid", p);
    picked.push(p);
  }
  if (args.op !== "sum" && picked.length !== 2) return refusal(name, "invalid", `${args.op} takes exactly two values.`);
  const [a, b] = picked as [Picked, Picked];
  const money = picked.some((p) => p.column.kind === "money" || p.column.money);
  const currencies = new Set(picked.filter((p) => p.column.kind === "money").map((p) => p.column.currency ?? "?"));
  if (currencies.size > 1) return refusal(name, "invalid", "Those figures are in different currencies, so they can't be combined (rule #4).");
  const kinds = new Set(picked.map((p) => p.column.kind));
  if ((args.op === "sum" || args.op === "difference") && kinds.size > 1) return refusal(name, "invalid", "Only like figures can be added or subtracted (counts with counts, money with money).");
  if (args.op === "sum" && kinds.has("percent")) return refusal(name, "invalid", "Rates can't be added up; ask for the rate over the combined orders instead.");

  let value: number | null;
  let column: Column;
  const currency = [...currencies][0];
  switch (args.op) {
    case "sum":
    case "difference": {
      const v = args.op === "sum" ? picked.reduce((s, p) => s + p.value, 0) : a.value - b.value;
      const kind = a.column.kind === "percent" ? "points" : a.column.kind;
      value = round(v, kind === "count" ? 0 : kind === "money" ? 2 : 1);
      column = { key: "value", label: args.op === "sum" ? "Sum" : a.column.kind === "percent" ? "Difference (points)" : "Difference", kind, ...(currency ? { currency } : {}), ...(money ? { money: true } : {}) };
      break;
    }
    case "ratio":
      value = b.value === 0 ? null : round(a.value / b.value, 2);
      column = { key: "value", label: "Ratio", kind: "number", ...(money ? { money: true } : {}) };
      break;
    case "share":
      value = b.value === 0 ? null : round((100 * a.value) / b.value, 1);
      column = { key: "value", label: "Share", kind: "percent", ...(money ? { money: true } : {}) };
      break;
    case "percent_change":
      value = b.value === 0 ? null : round((100 * (a.value - b.value)) / Math.abs(b.value), 1);
      column = { key: "value", label: "Change", kind: "percent", ...(money ? { money: true } : {}) };
      break;
  }
  const said = (p: Picked) => `table ${p.table}, ${p.row}, ${p.column.label.toLowerCase()} = ${p.value}`;
  return {
    tool: name,
    status: value === null ? "not_enough_data" : "ok",
    title: `${args.op.replace("_", " ")} of ${picked.length} figures`,
    columns: [{ key: "label", label: "Calculation", kind: "text" }, column],
    rows: [{ label: args.op.replace("_", " "), value }],
    meta: {
      stores: [],
      rules: ["Computed by Growzar from the cells named, not by the model."],
      gaps: [],
      notes: [...picked.map(said), ...(value === null ? ["The second figure is zero, so there is no ratio"] : [])],
    },
    link: null,
  };
}

export const calculate: AskTool<typeof calculateSchema> = {
  name: "calculate",
  description:
    "Arithmetic on figures earlier tool results in this answer returned: sum, difference, ratio, share (percent of) or percent change. Name each cell by table number, row and column; never compute in your head.",
  schema: calculateSchema,
  sections: () => ["home"],
  run: runCalculate,
};
