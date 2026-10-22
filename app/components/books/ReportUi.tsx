import type { ReactNode } from "react";
import { Form, Link } from "react-router";
import { Download } from "lucide-react";

import { cn } from "~/lib/utils";
import { RANGE_PRESETS } from "~/lib/books/dates";
import type { ViewColumnSection, ViewSection } from "~/lib/books-app/report-view";
import { Money, inputClass, quietButtonClass } from "./BooksUi";

/** The period picker every report shares: a GET form, so the URL is the report. */
export function RangeForm({ range, hidden = {}, children }: { range: { preset: string; from: string; to: string }; hidden?: Record<string, string>; children?: ReactNode }) {
  return (
    <Form method="get" className="flex flex-wrap items-end gap-2">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <select name="range" defaultValue={range.preset} aria-label="Period" className={`${inputClass} w-48`}>
        {RANGE_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <input type="date" name="from" defaultValue={range.from} aria-label="From" className={`${inputClass} w-40`} />
      <input type="date" name="to" defaultValue={range.to} aria-label="To" className={`${inputClass} w-40`} />
      {children}
      <button type="submit" className={quietButtonClass}>
        Show
      </button>
    </Form>
  );
}

/** A file download: a plain link, the session cookie authenticates it. */
export function DownloadLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} download className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent-600 hover:text-accent-700">
      <Download className="h-4 w-4" /> {children}
    </a>
  );
}

function Name({ r }: { r: { name: string; depth: number; header: boolean; href: string | null } }) {
  const cls = cn(r.depth ? "pl-6 text-gray-600" : "text-gray-900", r.header && "font-semibold");
  return r.href ? (
    <Link to={r.href} className={cn(cls, "hover:text-accent-600")}>
      {r.name}
    </Link>
  ) : (
    <span className={cls}>{r.name}</span>
  );
}

/** One section of a statement: heading, rows (sub-accounts indented), total. */
export function SectionRows({ s, empty }: { s: ViewSection; empty?: string }) {
  return (
    <>
      <tr>
        <td colSpan={2} className="pt-4 pb-1 font-display text-sm font-bold text-gray-900">
          {s.label}
        </td>
      </tr>
      {s.rows.length === 0 && empty ? (
        <tr>
          <td colSpan={2} className="py-1 text-gray-500">
            {empty}
          </td>
        </tr>
      ) : null}
      {s.rows.map((r) => (
        <tr key={`${r.accountId}-${r.name}`} className="border-b border-gray-50">
          <td className="py-1.5">
            <Name r={r} />
          </td>
          <td className={cn("py-1.5 text-right", r.header && "font-semibold")}>
            <Money value={r.amount} />
          </td>
        </tr>
      ))}
      <tr className="border-t border-gray-200 font-semibold">
        <td className="py-1.5">Total {s.label.toLowerCase()}</td>
        <td className="py-1.5 text-right">
          <Money value={s.total} />
        </td>
      </tr>
    </>
  );
}

export function LineRow({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <tr className={cn("font-semibold", big ? "border-y-2 border-gray-700 text-base" : "border-t border-gray-300")}>
      <td className="py-2">{label}</td>
      <td className="py-2 text-right">
        <Money value={value} />
      </td>
    </tr>
  );
}

/** A statement with several columns (months, two periods, tags, two dates). */
export function ColumnsTable({ heads, sections }: { heads: string[]; sections: Array<{ s: ViewColumnSection; hideEmpty?: boolean; after?: { label: string; values: string[]; big?: boolean } }> }) {
  const n = heads.length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
            <th className="sticky left-0 bg-white py-2 pr-4 text-left font-semibold" />
            {heads.map((h) => (
              <th key={h} className="px-3 py-2 text-right font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map(({ s, hideEmpty, after }) =>
            hideEmpty && s.rows.length === 0 && !after ? null : (
              <ColumnSectionRows key={s.key} s={s} n={n} hideEmpty={hideEmpty} after={after} />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function ColumnSectionRows({ s, n, hideEmpty, after }: { s: ViewColumnSection; n: number; hideEmpty?: boolean; after?: { label: string; values: string[]; big?: boolean } }) {
  const show = !(hideEmpty && s.rows.length === 0);
  return (
    <>
      {show ? (
        <>
          <tr>
            <td colSpan={n + 1} className="sticky left-0 bg-white pt-4 pb-1 font-display text-sm font-bold text-gray-900">
              {s.label}
            </td>
          </tr>
          {s.rows.map((r) => (
            <tr key={`${r.accountId}-${r.name}`} className="border-b border-gray-50">
              <td className="sticky left-0 bg-white py-1.5 pr-4">
                <Name r={r} />
              </td>
              {r.amounts.map((a, i) => (
                <td key={i} className={cn("px-3 py-1.5 text-right", r.header && "font-semibold")}>
                  <Money value={a} />
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-gray-200 font-semibold">
            <td className="sticky left-0 bg-white py-1.5 pr-4">Total {s.label.toLowerCase()}</td>
            {s.totals.map((a, i) => (
              <td key={i} className="px-3 py-1.5 text-right">
                <Money value={a} />
              </td>
            ))}
          </tr>
        </>
      ) : null}
      {after ? (
        <tr className={cn("font-semibold", after.big ? "border-y-2 border-gray-700" : "border-t border-gray-300")}>
          <td className="sticky left-0 bg-white py-2 pr-4">{after.label}</td>
          {after.values.map((a, i) => (
            <td key={i} className="px-3 py-2 text-right">
              <Money value={a} />
            </td>
          ))}
        </tr>
      ) : null}
    </>
  );
}
