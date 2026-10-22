/**
 * What leaves the browser when a statement is imported (B5, D-72). The file
 * is read in the browser (statement-file.ts, statement-csv.ts); only the
 * columns the mapping uses are sent (date, description, amounts, balance),
 * with every description cell already masked (account, IBAN and card numbers
 * to their last four digits). Any column the mapping doesn't use (a branch
 * code, a cheque number, a running reference) never leaves the browser. The
 * server reads what it receives with the same code and masks again as a
 * backstop.
 */
import { maskSensitive, type StatementMapping } from "../books/statement-csv";

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The mapped columns only, descriptions masked, as CSV text with its mapping renumbered. */
export function minimiseStatement(rows: string[][], m: StatementMapping): { text: string; mapping: StatementMapping } {
  const cols = [m.dateCol, ...m.descCols, m.amountCol, m.outCol, m.inCol, m.balanceCol].filter((c): c is number => c !== null && c !== undefined);
  const keep = [...new Set(cols)];
  const at = (c: number | null) => (c === null ? null : keep.indexOf(c));
  const desc = new Set(m.descCols);
  const out = rows.map((r, i) => keep.map((c) => {
    const v = r[c] ?? "";
    // The header row names columns; every other row's description is masked.
    return desc.has(c) && i !== m.headerRow ? maskSensitive(v) : v;
  }));
  return {
    text: out.map((r) => r.map(csvCell).join(",")).join("\n"),
    mapping: { ...m, dateCol: at(m.dateCol)!, descCols: m.descCols.map((c) => at(c)!), amountCol: at(m.amountCol), outCol: at(m.outCol), inCol: at(m.inCol), balanceCol: at(m.balanceCol) },
  };
}
