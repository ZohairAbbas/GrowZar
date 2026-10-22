import type { ColumnSection, ReportSection } from "../books/reports";

/**
 * Reports as the screens show them (B6): amounts formatted on the server for
 * the viewer (owner: −1,000; accountant: (1,000)), each account row linking to
 * its lines in the general ledger for the same dates.
 */
export type ViewRow = { accountId: string; name: string; amount: string; depth: number; header: boolean; href: string | null };
export type ViewSection = { key: string; label: string; rows: ViewRow[]; total: string };
export type ViewColumnRow = Omit<ViewRow, "amount"> & { amounts: string[] };
export type ViewColumnSection = { key: string; label: string; rows: ViewColumnRow[]; totals: string[] };

type Fmt = (v: bigint) => string;

/** The general ledger for one account over the given dates. */
export function ledgerHref(accountId: string, from: string, to: string): string | null {
  // Cash basis adds rows for payments not tied to an account ("cash:…"): they open nothing.
  if (!accountId || accountId.startsWith("cash:")) return null;
  return `/books/reports/general-ledger?${new URLSearchParams({ account: accountId, range: "custom", from, to }).toString()}`;
}

const label = (r: { code: string; name: string; depth?: number }, accountant: boolean) => (accountant && r.code && !r.depth ? `${r.code} · ${r.name}` : r.name);

export function viewSection(s: ReportSection, m: Fmt, accountant: boolean, from: string, to: string): ViewSection {
  return {
    key: s.key,
    label: s.label,
    rows: s.rows.map((r) => ({ accountId: r.accountId, name: label(r, accountant), amount: m(r.amount), depth: r.depth ?? 0, header: !!r.header, href: r.header ? null : ledgerHref(r.accountId, from, to) })),
    total: m(s.total),
  };
}

export function viewColumns(s: ColumnSection, m: Fmt, accountant: boolean, from: string, to: string): ViewColumnSection {
  return {
    key: s.key,
    label: s.label,
    rows: s.rows.map((r) => ({ accountId: r.accountId, name: label(r, accountant), amounts: r.amounts.map(m), depth: r.depth ?? 0, header: !!r.header, href: r.header ? null : ledgerHref(r.accountId, from, to) })),
    totals: s.totals.map(m),
  };
}

/** The query string a report keeps when its form changes one thing. */
export function keep(params: URLSearchParams, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = params.get(n);
    if (v) out[n] = v;
  }
  return out;
}
