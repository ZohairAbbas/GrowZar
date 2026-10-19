import { formatAmount } from "../metrics/format";
import type { Cell, Column, ToolResult } from "./types";

/**
 * How a tool result is drawn on the Ask screen (G-GZR10-3). Pure, shared by
 * the page and its tests. The table and chart are drawn from the tool result
 * itself, never from the model's text.
 */

/** A cell as the screens print it. */
export function cellText(c: Column, v: Cell | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  switch (c.kind) {
    case "money":
      return `${c.currency ? `${c.currency} ` : ""}${formatAmount(v.toFixed(2))}`;
    case "percent":
      return `${v.toFixed(1)}%`;
    case "points":
      return `${v > 0 ? "+" : ""}${v.toFixed(1)} pts`;
    case "days":
      return `${v.toLocaleString("en-US")} days`;
    case "count":
      return v.toLocaleString("en-US");
    default:
      return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}

const isId = (c: Column) => c.key === "key" || c.key.endsWith("_key");

/** Columns worth showing: an id column ("key", "courier_key") stays out of sight when another text column names the row. */
export function shownColumns(r: ToolResult): Column[] {
  const named = r.columns.some((c) => c.kind === "text" && !isId(c));
  return r.columns.filter((c) => !(named && isId(c)));
}

export type ChartSpec = { label: Column; value: Column; points: Array<{ label: string; value: number | null }>; time: boolean };

const TIME = /by (day|week|month)$/i;

/**
 * A bar chart for a ranking or a series: a label column, the first figure
 * column, and 2–31 rows. One figure only (no second axis, ever); a row with
 * no value is a gap, never a zero.
 */
export function chartOf(r: ToolResult): ChartSpec | null {
  if (r.status !== "ok" || r.rows.length < 2 || r.rows.length > 31) return null;
  // The text column that tells the rows apart (couriers in one city, not the city repeated).
  const label = r.columns.find((c) => c.kind === "text" && !isId(c) && new Set(r.rows.map((x) => x[c.key])).size > 1);
  const figures = r.columns.filter((c) => c !== label && ["count", "money", "percent", "number", "points"].includes(c.kind) && r.rows.some((x) => typeof x[c.key] === "number"));
  // A city–courier table is about the rate; anything else charts its first figure.
  const value = (r.tool === "city_courier" ? figures.find((c) => c.key === "delivery_rate") : undefined) ?? figures[0];
  if (!label || !value) return null;
  const points = r.rows.map((x) => ({ label: String(x[label.key] ?? ""), value: typeof x[value.key] === "number" ? (x[value.key] as number) : null }));
  if (points.filter((p) => p.value !== null).length < 2) return null;
  return { label, value, points, time: TIME.test(r.title) };
}

/** A tool result worth drawing under the answer: it has figures and is not just the store list. */
export const drawn = (r: ToolResult) => r.status === "ok" && r.rows.length > 0 && r.tool !== "list_stores";

/** Inline marks in the model's text: **bold**, and "(table N)" citations. Nothing else is interpreted. */
export type Span = { text: string; bold?: boolean; table?: number };
export function spansOf(line: string): Span[] {
  const out: Span[] = [];
  const re = /\*\*([^*]+)\*\*|\(tables? ([\d, and]+)\)/g;
  let at = 0;
  for (const m of line.matchAll(re)) {
    if (m.index! > at) out.push({ text: line.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else out.push({ text: m[0], table: Number(m[2]!.match(/\d+/)![0]) });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}
