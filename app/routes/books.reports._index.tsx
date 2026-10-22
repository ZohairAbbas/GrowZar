import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/books.reports._index";
import { requireBook } from "~/lib/books-app/access.server";
import { RANGE_PRESETS } from "~/lib/books/dates";
import { isIsoDate } from "~/lib/books/posting";
import { Card, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Reports · Books · Growzar" }];
}

/** Reports home (B6): the statements, the accountant's views, and exporting everything for a period. */
export async function loader({ request }: Route.LoaderArgs) {
  const { canExport } = await requireBook(request, "view");
  return { canExport };
}

const GROUPS = [
  {
    title: "Statements",
    reports: [
      { path: "profit-and-loss", title: "Profit and loss", owner: "Did you make money? Sales, costs and profit, month by month, against another period, or one store at a time." },
      { path: "balance-sheet", title: "Balance sheet", owner: "What you have, what you owe, and what's left for you, on any date." },
      { path: "cash-flow", title: "Cash flow", owner: "Why the money in your accounts went up or down, starting from profit." },
      { path: "compare-finance", title: "Books and Finance", owner: "Finance's profit next to Books', line by line, and why the two differ." },
    ],
  },
  {
    title: "For your accountant",
    reports: [
      { path: "trial-balance", title: "Trial balance", owner: "Every account's balance in debits and credits." },
      { path: "general-ledger", title: "General ledger", owner: "Every line in every account, with running balances." },
      { path: "journal", title: "Journal", owner: "Every entry with its debits and credits, in date order." },
    ],
  },
];

export default function Reports({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      {d.canExport ? <ExportEverything /> : null}
      {GROUPS.map((g) => (
        <div key={g.title} className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-500">{g.title}</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {g.reports.map((r) => (
              <Link key={r.path} to={`/books/reports/${r.path}`} className="block rounded-2xl bg-white p-5 transition hover:ring-2 hover:ring-accent-500/30">
                <h3 className="font-display text-base font-bold text-gray-900">{r.title}</h3>
                <p className="mt-1 text-sm text-gray-600">{r.owner}</p>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Export everything for a period (D-91): an Excel workbook (a sheet per
 * report), the statements to print or save as PDF, or every report as CSV
 * files in a ZIP.
 */
function ExportEverything() {
  const [range, setRange] = useState("this_fy");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const custom = range === "custom";
  const ready = !custom || (isIsoDate(from) && isIsoDate(to) && from <= to);
  const q = new URLSearchParams(custom ? { range, from, to } : { range }).toString();
  const link = (href: string, label: string, primary = false, download = true) =>
    ready ? (
      <a href={href} download={download || undefined} className={primary ? "inline-flex h-10 items-center rounded-full bg-navy px-5 text-sm font-semibold text-white hover:bg-navy-surface" : quietButtonClass}>
        {label}
      </a>
    ) : (
      <span className={`${quietButtonClass} opacity-50`}>{label}</span>
    );
  return (
    <Card title="Export everything">
      <p className="text-sm text-gray-600">
        Profit and loss (also month by month and on cash basis), balance sheet, cash flow, trial balance, chart of accounts, general ledger and journal, for your accountant, the bank or your files.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Period" className={`${inputClass} w-52`}>
          {RANGE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {custom ? (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className={`${inputClass} w-40`} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className={`${inputClass} w-40`} />
          </>
        ) : null}
      </div>
      {custom && from && to && from > to ? <p className="text-xs font-medium text-coral-700">The period ends before it starts.</p> : null}
      <div className="flex flex-wrap gap-2">
        {link(`/books/export/workbook?${q}`, "Excel workbook", true)}
        {link(`/books/statements?${q}`, "PDF statements", false, false)}
        {link(`/books/export/pack?${q}`, "CSV files (ZIP)")}
      </div>
      <p className="text-xs text-gray-500">
        The workbook's ledger and journal sheets hold up to 30,000 lines each; the CSV files have every line. PDF statements open ready to print or save as PDF.
      </p>
    </Card>
  );
}
