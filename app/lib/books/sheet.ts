/**
 * Reading a spreadsheet someone exported from somewhere else: find the header
 * row and which column is which, by the names people actually use. Shared by
 * every import that isn't a bank statement (opening balances, loadsheets,
 * courier payment reports). Pure and browser-safe.
 */

export interface ColumnSpec {
  key: string;
  /** Header names, lower-case, words separated by single spaces. Earlier names win. */
  names: string[];
  required?: boolean;
}

export interface FoundColumns {
  /** Index of the header row; data starts on the next row. */
  headerRow: number;
  cols: Record<string, number>;
}

/** "Bill No." → "bill no", "COD_Amount" → "cod amount". */
export function normHeader(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The header row (within the first rows) that names the most columns, with
 * every required one. An exact name beats a header that only contains it, so
 * "Amount" doesn't take "COD amount" when both exist.
 */
export function findColumns(rows: string[][], specs: ColumnSpec[], scan = 20): FoundColumns | null {
  let best: (FoundColumns & { score: number }) | null = null;
  for (let r = 0; r < Math.min(rows.length, scan); r++) {
    const headers = rows[r]!.map(normHeader);
    const taken = new Set<number>();
    const cols: Record<string, number> = {};
    let score = 0;
    // Exact matches first, for every column, then "contains" matches.
    for (const pass of ["exact", "contains"] as const) {
      for (const spec of specs) {
        if (cols[spec.key] !== undefined) continue;
        for (const name of spec.names) {
          const i = headers.findIndex((h, j) => !taken.has(j) && h !== "" && (pass === "exact" ? h === name : ` ${h} `.includes(` ${name} `)));
          if (i >= 0) {
            cols[spec.key] = i;
            taken.add(i);
            score += pass === "exact" ? 2 : 1;
            break;
          }
        }
      }
    }
    if (specs.some((s) => s.required && cols[s.key] === undefined)) continue;
    if (!best || score > best.score) best = { headerRow: r, cols, score };
  }
  return best ? { headerRow: best.headerRow, cols: best.cols } : null;
}

/** The cell for a column in a row ("" when the column wasn't found). */
export function cell(row: string[], cols: Record<string, number>, key: string): string {
  const i = cols[key];
  return i === undefined ? "" : (row[i] ?? "").trim();
}

/** A data row with nothing in it, or a totals row ("Total", "Grand total"). */
export function isBlankOrTotal(row: string[]): boolean {
  const filled = row.map((c) => c.trim()).filter(Boolean);
  return filled.length === 0 || /^(grand\s+)?(sub\s*)?totals?:?$/i.test(filled[0]!);
}
