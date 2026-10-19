import { z } from "zod";

import { coverageLine } from "../../metrics/coverage";
import type { StoreSummary } from "../../metrics/summaries.server";
import { NO_SCOPE, type Scope } from "../../metrics/scope";
import type { Section } from "../../permissions";
import { coverageFor } from "../load.server";
import type { AskContext, AskStore, ToolResult } from "../types";

/** Shared arguments and result pieces for the tools. */

export const storeArg = z
  .string()
  .nullable()
  .describe("A store id from list_stores. Null for every store the user can see.");

export const oneStoreArg = z.string().nullable().describe("A store id from list_stores. Null for the user's first store when they have one store; required with several.");

export const filtersArg = z
  .object({
    city: z.string().nullable().describe("Only orders to this city, as Growzar names it (e.g. Lahore)."),
    courier: z.string().nullable().describe("Only orders carried by this courier key (e.g. leopards, tcs)."),
  })
  .strict()
  .nullable()
  .describe("Narrow the orders. Null for all orders.");

export type FiltersArg = z.infer<typeof filtersArg>;

export const limitArg = z.number().int().min(1).max(50).nullable().describe("Rows to return, 1–50. Null for 10.");

/** The rule every multi-store figure follows (rule #4). */
export const CURRENCY_RULE = "Money is never added across currencies; multi-store totals are in the organization's base currency at each order day's rate, with the rate shown (rule #4).";

export const FORBIDDEN_STORE = "That store is not available to you.";

/**
 * The stores a question is about, inside the viewer's scope. A store the
 * viewer cannot see and one that does not exist answer the same, as
 * `requireStore` does.
 */
export function pickStores(ctx: AskContext, store: string | null): AskStore[] | null {
  if (store === null) return ctx.stores;
  const s = ctx.stores.find((x) => x.id === store) ?? ctx.stores.find((x) => x.name.toLowerCase() === store.trim().toLowerCase());
  return s ? [s] : null;
}

export function pickOneStore(ctx: AskContext, store: string | null): AskStore | "ambiguous" | null {
  if (store === null) return ctx.stores.length === 1 ? ctx.stores[0]! : ctx.stores.length ? "ambiguous" : null;
  return pickStores(ctx, store)?.[0] ?? null;
}

/**
 * The filter bar's courier and city as the summary takes them. Values are
 * matched to the keys the period actually has, ignoring case, so "lahore"
 * selects "Lahore"; an unknown value stays as given and selects nothing.
 */
export function scopeOf(filters: FiltersArg, options?: StoreSummary["scopeOptions"]): Scope {
  if (!filters) return NO_SCOPE;
  const match = (v: string | null, list: Array<{ key: string }> | undefined) => {
    if (!v) return null;
    const t = v.trim();
    return list?.find((x) => x.key.toLowerCase() === t.toLowerCase())?.key ?? t;
  };
  return { city: match(filters.city, options?.cities), courier: match(filters.courier, options?.couriers) };
}

/** A Growzar screen for one store, with the period and filters it was asked with. */
export function screenLink(section: Section | "compare" | "insights" | "settings/coverage", store: AskStore | null, query: string, extra: Record<string, string | null> = {}) {
  const q = new URLSearchParams(query);
  if (store) q.set("store", store.id);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return `/${section}?${q}`;
}

/** The coverage gaps that touch a section, as the section's own line says them (D1). */
export async function gapsFor(ctx: AskContext, s: StoreSummary, section: Section): Promise<string[]> {
  return coverageLine(await coverageFor(ctx, s), section).gaps.map((g) => g.text);
}

/** A result that answers nothing, with the reason as a note. */
export function refusal(tool: string, status: Exclude<ToolResult["status"], "ok">, reason: string): ToolResult {
  return {
    tool,
    status,
    title: reason,
    columns: [],
    rows: [],
    meta: { stores: [], rules: [], gaps: [], notes: [reason] },
    link: null,
  };
}
