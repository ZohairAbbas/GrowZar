import type { Cell, ToolResult } from "./types";

/**
 * The last check on a tool result before it leaves Growzar for the model
 * provider (B3: aggregates only). Pure.
 *
 * Each tool already builds its result without buyer identity and without
 * money for a viewer who may not see Finance; this repeats both rules on the
 * finished result, so a tool that gets one wrong still cannot leak:
 *
 *  - a column that is money, or derived from it, is dropped without Finance;
 *  - a column named like a buyer's identity is dropped, always;
 *  - an email address or a phone number in any text is masked;
 *  - rows are capped at MAX_ROWS, and the cut is stated.
 */

export const MAX_ROWS = 50;

/** Column keys or labels that would carry who a buyer is. */
export const IDENTITY = /phone|mobile|whatsapp|e-?mail|address|street|postcode|postal|cnic|buyer[ _-]?name|customer[ _-]?(name|id)|first[ _-]?name|last[ _-]?name|full[ _-]?name|customerid/i;

/** An email address, or a phone number (Pakistani mobile, or any + international number). */
export const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const PHONE = /(?:\+\d[\d\s-]{8,14}\d|\b(?:0092|92|0)?3\d{2}[\s-]?\d{7}\b)/g;

export function mask(text: string): string {
  return text.replace(EMAIL, "[email removed]").replace(PHONE, "[phone removed]");
}

const maskCell = (c: Cell): Cell => (typeof c === "string" ? mask(c) : c);

export function guard(result: ToolResult, canSeeMoney: boolean): ToolResult {
  const dropped = new Set(
    result.columns
      .filter((c) => IDENTITY.test(c.key) || IDENTITY.test(c.label) || (!canSeeMoney && (c.kind === "money" || c.money)))
      .map((c) => c.key),
  );
  const columns = result.columns.filter((c) => !dropped.has(c.key));
  const all = result.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !dropped.has(k) && !IDENTITY.test(k)).map(([k, v]) => [k, maskCell(v)])));
  const rows = all.slice(0, MAX_ROWS);
  const cut = all.length > rows.length ? { shown: rows.length, total: result.meta.truncated?.total ?? all.length } : result.meta.truncated;
  const texts = (list: string[]) => list.map(mask);
  return {
    ...result,
    title: mask(result.title),
    columns,
    rows,
    meta: {
      ...result.meta,
      ...(canSeeMoney ? {} : { currency: undefined }),
      rules: texts(result.meta.rules),
      gaps: texts(result.meta.gaps),
      notes: texts(result.meta.notes),
      stores: result.meta.stores.map((s) => ({ id: s.id, name: mask(s.name) })),
      ...(cut ? { truncated: cut } : {}),
    },
  };
}
