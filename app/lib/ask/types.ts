import type { z } from "zod";

import type { Section } from "../permissions";

/**
 * "Talk to your data" (Phase 10): the tool layer's shapes. Pure.
 *
 * A tool is the only way an answer reaches a number. It takes the viewer's
 * resolved scope from the server (`AskContext`), never from the model's
 * arguments, and returns rows the UI draws as they are: the model writes the
 * words around them and never computes, estimates or remembers a figure.
 */

export type AskStore = {
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
};

export type AskContext = {
  organizationId: string;
  userId: string;
  /** The organization's base currency, for multi-store money (rule #4). */
  baseCurrency: string;
  /** Every store the viewer may see, already narrowed by their scope (D-20). */
  stores: AskStore[];
  /** Whether the viewer's role grants `section:view`. */
  can: (section: Section) => boolean;
  now: Date;
  /** Per-request memo, so several tool calls in one answer load a store's orders once. */
  memo: Map<string, Promise<unknown>>;
};

/** A cell: a figure, a label, or nothing ("not enough data" says why in `meta`). */
export type Cell = string | number | null;

export type Column = {
  key: string;
  label: string;
  kind: "text" | "count" | "percent" | "points" | "money" | "number" | "days" | "date";
  /** Money columns: the currency every value in the column is in. */
  currency?: string;
  /** Derived from money though not money itself (margin, ROAS): hidden with it. */
  money?: boolean;
};

export type ToolStatus =
  /** Rows answer the question. */
  | "ok"
  /** The data exists but is too thin to say anything (rule: never a zero). */
  | "not_enough_data"
  /** Nothing in the period, or the app that sends it is not connected. */
  | "no_data"
  /** The viewer's role or store scope does not allow it. */
  | "forbidden"
  /** The arguments do not make a question the tool can answer. */
  | "invalid"
  /** Loading failed; nothing to say about the data. */
  | "error";

export type ToolResult = {
  tool: string;
  status: ToolStatus;
  /** One line naming what the rows are. */
  title: string;
  columns: Column[];
  rows: Array<Record<string, Cell>>;
  meta: {
    period?: { from: string; to: string; days: number };
    /** The period compared against, for comparisons. */
    against?: { from: string; to: string; days: number };
    stores: Array<{ id: string; name: string }>;
    currency?: string | null;
    /** The display rules applied, in words (CONFLICTING-DATA-POINTS). */
    rules: string[];
    /** What is missing behind the numbers, from the coverage panel and the figures' own gaps. */
    gaps: string[];
    /** Anything else the answer must repeat: why a value is empty, a folded row, a filter. */
    notes: string[];
    /** Rows cut to the cap. */
    truncated?: { shown: number; total: number };
  };
  /**
   * The Growzar screen with the same filters. `exact` is false when no screen
   * shows this view: the answer then says "Not on a screen yet".
   */
  link: { href: string; label: string; exact: boolean } | null;
};

export type AskTool<S extends z.ZodType = z.ZodType> = {
  name: string;
  /** For the model: what the tool answers, in one or two sentences. */
  description: string;
  /** Arguments, as the model sends them. Every field is required and nullable (strict schemas). */
  schema: S;
  /** The section the viewer must be able to view; may depend on the arguments (a money metric needs Finance). */
  sections: (args: z.infer<S>) => Section[];
  run: (args: z.infer<S>, ctx: AskContext) => Promise<ToolResult>;
};
