import { Link } from "react-router";

import type { Route } from "./+types/books.reports.spending-by-supplier";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { formatDate, todayIn } from "~/lib/books/dates";
import { spendingBySupplier } from "~/lib/books/ledger-views.server";
import { rangeFrom } from "~/lib/books/report-data.server";
import { Card, Money } from "~/components/books/BooksUi";
import { DownloadLink, RangeForm } from "~/components/books/ReportUi";

export function meta() {
  return [{ title: "Spending by supplier · Books · Growzar" }];
}

/**
 * Spending by supplier (Books v1.1 V2): costs and stock bought from each
 * contact in a period, couriers, gateways and ad platforms included, biggest
 * first. Ported from Financify's reports.spending-by-supplier.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canExport } = await requireBook(request, "view");
  const m = (v: bigint) => money(book, v, isAccountantRole(viewer.role));
  const range = rangeFrom(book, todayIn(book.settings.timeZone), url.searchParams);
  const s = await spendingBySupplier(book, range);
  return {
    range,
    subtitle: `${formatDate(range.from)} – ${formatDate(range.to)}`,
    canExport,
    csv: `/books/export/spending-by-supplier?${url.searchParams.toString()}`,
    rows: s.rows.map((r) => ({
      key: r.contactId ?? r.name,
      name: r.name,
      known: !!r.contactId,
      mostly: r.accounts.slice(0, 3).map((a) => a.name).join(", ") + (r.accounts.length > 3 ? ` and ${r.accounts.length - 3} more` : ""),
      total: m(r.total),
    })),
    total: m(s.total),
  };
}

export default function SpendingBySupplier({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/books/reports" className="text-xs font-semibold text-accent-600">
            ← Reports
          </Link>
          <h2 className="font-display text-xl font-bold text-gray-900">Spending by supplier</h2>
          <p className="text-sm text-gray-600">{d.subtitle}</p>
        </div>
        {d.canExport ? <DownloadLink href={d.csv}>Download CSV</DownloadLink> : null}
      </div>
      <Card>
        <RangeForm range={d.range} />
      </Card>
      <Card>
        {d.rows.length === 0 ? (
          <p className="text-sm text-gray-600">No spending in this period. Expenses, bills and stock bought show here by who you paid.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 text-left font-semibold">Supplier</th>
                  <th className="py-2 text-left font-semibold">Mostly for</th>
                  <th className="py-2 text-right font-semibold">Spent</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.key} className="border-b border-gray-50">
                    <td className={`py-1.5 ${r.known ? "text-gray-900" : "text-gray-500"}`}>{r.name}</td>
                    <td className="py-1.5 text-gray-600">{r.mostly}</td>
                    <td className="py-1.5 text-right">
                      <Money value={r.total} />
                    </td>
                  </tr>
                ))}
                <tr className="border-y-2 border-gray-700 font-semibold">
                  <td className="py-2" colSpan={2}>
                    Total
                  </td>
                  <td className="py-2 text-right">
                    <Money value={d.total} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-500">Includes stock you bought. The cost of what you sold isn't counted again here, nor stock counts or opening balances. Cancelled entries cancel out.</p>
      </Card>
    </div>
  );
}
