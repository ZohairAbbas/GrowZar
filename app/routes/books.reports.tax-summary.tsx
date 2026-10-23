import { Link } from "react-router";

import type { Route } from "./+types/books.reports.tax-summary";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { ledgerHref } from "~/lib/books-app/report-view";
import { formatDate, todayIn } from "~/lib/books/dates";
import { rangeFrom } from "~/lib/books/report-data.server";
import { TAX_KIND_LABELS, formatRate } from "~/lib/books/tax";
import { taxSummary } from "~/lib/books/taxes.server";
import { Card, Money } from "~/components/books/BooksUi";
import { DownloadLink, RangeForm } from "~/components/books/ReportUi";

export function meta() {
  return [{ title: "Tax summary · Books · Growzar" }];
}

/**
 * Tax summary (Books v1.1 V2): what each tax account did in a period
 * (charged, claimed, withheld, paid), what's owed or claimable at the end,
 * and the taxable amounts per rate behind entries made with a rate. Ported
 * from Financify's reports.tax-summary.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canExport, canManage } = await requireBook(request, "view");
  const m = (v: bigint) => money(book, v, isAccountantRole(viewer.role));
  const range = rangeFrom(book, todayIn(book.settings.timeZone), url.searchParams);
  const t = await taxSummary(book, range.from, range.to);
  return {
    range,
    from: formatDate(range.from),
    to: formatDate(range.to),
    canExport,
    canManage,
    csv: `/books/export/tax-summary?${url.searchParams.toString()}`,
    owed: m(t.owed),
    claimable: m(t.claimable),
    net: m(t.net >= 0n ? t.net : -t.net),
    toPay: t.net >= 0n,
    accounts: t.accounts.map((a) => ({
      id: a.accountId,
      name: a.name,
      side: a.side === "owed" ? "Tax you owe" : "Tax you can claim",
      href: ledgerHref(a.accountId, range.from, range.to),
      start: m(a.start),
      movements: a.movements.map((x) => ({ label: x.label, amount: m(x.amount) })),
      end: m(a.end),
    })),
    rates: t.rates.map((r) => ({ name: `${r.name}${r.rateBp != null ? ` (${formatRate(r.rateBp)})` : ""}`, kind: TAX_KIND_LABELS[r.kind].label, base: m(r.base), tax: m(r.tax) })),
  };
}

export default function TaxSummary({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/books/reports" className="text-xs font-semibold text-accent-600">
            ← Reports
          </Link>
          <h2 className="font-display text-xl font-bold text-gray-900">Tax summary</h2>
          <p className="text-sm text-gray-600">
            {d.from} – {d.to}
          </p>
        </div>
        <span className="flex flex-wrap gap-4 text-sm font-semibold">
          {d.canManage ? (
            <Link to="/books/new/tax_payment" className="text-accent-600">
              Record tax paid
            </Link>
          ) : null}
          <Link to="/books/taxes" className="text-accent-600">
            Tax rates
          </Link>
          {d.canExport ? <DownloadLink href={d.csv}>Download CSV</DownloadLink> : null}
        </span>
      </div>
      <Card>
        <RangeForm range={d.range} />
      </Card>
      {d.accounts.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-600">No tax in this period. Tax from sales, ad spend and entries made with a tax rate shows up here.</p>
        </Card>
      ) : (
        <>
          <Card>
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="py-1.5">Tax you owe at {d.to}</td>
                  <td className="py-1.5 text-right">
                    <Money value={d.owed} />
                  </td>
                </tr>
                <tr>
                  <td className="py-1.5">Tax you can claim back</td>
                  <td className="py-1.5 text-right">
                    <Money value={d.claimable} />
                  </td>
                </tr>
                <tr className="border-y-2 border-gray-700 font-semibold">
                  <td className="py-2">{d.toPay ? "To pay, after what you can claim" : "To get back"}</td>
                  <td className="py-2 text-right">
                    <Money value={d.net} />
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-gray-500">Owed and claimable are the balances at the end of the period, including anything from earlier periods not yet paid or claimed.</p>
          </Card>
          {d.accounts.map((a) => (
            <Card key={a.id} title={a.href ? <Link to={a.href} className="hover:text-accent-600">{a.name}</Link> : a.name} aside={<span className="text-xs text-gray-500">{a.side}</span>}>
              <table className="w-full text-sm">
                <tbody>
                  <tr className="text-gray-500">
                    <td className="py-1.5">At {d.from}</td>
                    <td className="py-1.5 text-right">
                      <Money value={a.start} />
                    </td>
                  </tr>
                  {a.movements.map((x) => (
                    <tr key={x.label} className="border-b border-gray-50">
                      <td className="py-1.5">{x.label}</td>
                      <td className="py-1.5 text-right">
                        <Money value={x.amount} />
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-gray-300 font-semibold">
                    <td className="py-2">At {d.to}</td>
                    <td className="py-2 text-right">
                      <Money value={a.end} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </Card>
          ))}
          {d.rates.length ? (
            <Card title="By rate">
              <p className="text-xs text-gray-500">Entries saved with a tax rate in this period (cancelled ones left out). Sales and ad spend tax isn't split by rate.</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-2 text-left font-semibold">Rate</th>
                    <th className="py-2 text-left font-semibold">Kind</th>
                    <th className="py-2 text-right font-semibold">Taxable amount</th>
                    <th className="py-2 text-right font-semibold">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rates.map((r) => (
                    <tr key={`${r.name}-${r.kind}`} className="border-b border-gray-50">
                      <td className="py-1.5">{r.name}</td>
                      <td className="py-1.5 text-gray-600">{r.kind}</td>
                      <td className="py-1.5 text-right">
                        <Money value={r.base} />
                      </td>
                      <td className="py-1.5 text-right">
                        <Money value={r.tax} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
