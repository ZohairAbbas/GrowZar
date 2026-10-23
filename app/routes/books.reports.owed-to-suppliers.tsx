import { Link } from "react-router";

import type { Route } from "./+types/books.reports.owed-to-suppliers";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { formatDate, todayIn } from "~/lib/books/dates";
import { agedPayables } from "~/lib/books/ledger-views.server";
import { AGE_BUCKETS } from "~/lib/books/reports";
import { Card, Money } from "~/components/books/BooksUi";
import { DownloadLink } from "~/components/books/ReportUi";

export function meta() {
  return [{ title: "Owed to suppliers · Books · Growzar" }];
}

/**
 * What you owe suppliers today, by how late it is (Books v1.1 V2): open bills
 * by due date (or bill date with none), plus anything owed that isn't on a
 * bill, so the total matches the balance sheet. Ported from Financify's
 * reports.aged-payables.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book, canExport } = await requireBook(request, "view");
  const m = (v: bigint) => money(book, v, isAccountantRole(viewer.role));
  const today = todayIn(book.settings.timeZone);
  const a = await agedPayables(book, today);
  const cell = (v: bigint) => (v === 0n ? "" : m(v));
  return {
    today: formatDate(today),
    canExport,
    rows: a.rows.map((r) => ({ key: r.contactId ?? r.name, name: r.name, buckets: r.buckets.map(cell), total: m(r.total) })),
    totals: a.totals.map(cell),
    notFromBills: a.notFromBills === 0n ? null : m(a.notFromBills),
    payables: m(a.payables),
  };
}

export default function OwedToSuppliers({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/books/reports" className="text-xs font-semibold text-accent-600">
            ← Reports
          </Link>
          <h2 className="font-display text-xl font-bold text-gray-900">Owed to suppliers by age</h2>
          <p className="text-sm text-gray-600">On {d.today}</p>
        </div>
        {d.canExport ? <DownloadLink href="/books/export/aged-payables">Download CSV</DownloadLink> : null}
      </div>
      <Card>
        {d.rows.length === 0 && !d.notFromBills ? (
          <p className="text-sm text-gray-600">You don't owe any supplier. Bills you add, or that Inventorify brings in, show here until they're paid, grouped by how late they are.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 text-left font-semibold">Supplier</th>
                  {AGE_BUCKETS.map((b) => (
                    <th key={b} className="px-2 py-2 text-right font-semibold">
                      {b}
                    </th>
                  ))}
                  <th className="py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.key} className="border-b border-gray-50">
                    <td className="py-1.5 text-gray-900">{r.name}</td>
                    {r.buckets.map((b, i) => (
                      <td key={i} className="px-2 py-1.5 text-right">
                        {b ? <Money value={b} /> : null}
                      </td>
                    ))}
                    <td className="py-1.5 text-right font-semibold">
                      <Money value={r.total} />
                    </td>
                  </tr>
                ))}
                {d.notFromBills ? (
                  <tr className="border-b border-gray-50 text-gray-500">
                    <td className="py-1.5" colSpan={AGE_BUCKETS.length + 1}>
                      Owed but not on a bill (opening balances, entries made by hand)
                    </td>
                    <td className="py-1.5 text-right">
                      <Money value={d.notFromBills} />
                    </td>
                  </tr>
                ) : null}
                <tr className="border-y-2 border-gray-700 font-semibold">
                  <td className="py-2">Total you owe suppliers</td>
                  {d.totals.map((b, i) => (
                    <td key={i} className="px-2 py-2 text-right">
                      {b ? <Money value={b} /> : null}
                    </td>
                  ))}
                  <td className="py-2 text-right">
                    <Money value={d.payables} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-500">Lateness counts from each bill's due date, or its date when it has none.</p>
      </Card>
    </div>
  );
}
