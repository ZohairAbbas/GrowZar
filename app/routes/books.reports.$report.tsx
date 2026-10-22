import { Form, Link } from "react-router";

import type { Route } from "./+types/books.reports.$report";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { viewColumns, viewSection, type ViewColumnSection } from "~/lib/books-app/report-view";
import { bookStores } from "~/lib/books-app/reports.server";
import { COMPARE_OPTIONS, MAX_MONTH_COLUMNS, formatDate, todayIn } from "~/lib/books/dates";
import { fiscalYearStart } from "~/lib/books/posting";
import { buildReport } from "~/lib/books/report-data.server";
import { REPORT_TITLES, type ColumnSection } from "~/lib/books/reports";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Money, inputClass, quietButtonClass } from "~/components/books/BooksUi";
import { ColumnsTable, DownloadLink, LineRow, RangeForm, SectionRows } from "~/components/books/ReportUi";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.title ?? "Report"} · Books · Growzar` }];
}

/** With a "Change" column: the first column less the second. */
function withChange(s: ColumnSection, on: boolean): ColumnSection {
  if (!on) return s;
  const d = (xs: bigint[]) => [...xs, xs[0]! - xs[1]!];
  return { ...s, rows: s.rows.map((r) => ({ ...r, amounts: d(r.amounts) })), totals: d(s.totals) };
}

/**
 * The statements (B6): profit and loss for a period (accrual or cash basis,
 * month by month or against another period, one store or all), balance sheet
 * and trial balance on a date. Ported from Financify's reports.$report; each
 * account opens its lines in the general ledger for the same dates.
 */
export async function loader({ request, params, url }: Route.LoaderArgs) {
  const { viewer, book, canExport } = await requireBook(request, "view");
  const report = params.report;
  if (!REPORT_TITLES[report]) throw new Response("Not found", { status: 404 });
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const today = todayIn(book.settings.timeZone);
  const r = await buildReport(book, today, report, url.searchParams);
  const stores = report === "profit-and-loss" ? await bookStores(book) : [];
  // Lines open on the same dates the report covers.
  const from = r.range ? r.range.from : fiscalYearStart(r.asOf ?? today, book.fiscalYearStartMonth);
  const to = r.range ? r.range.to : r.asOf ?? today;
  const sec = (s: Parameters<typeof viewSection>[0]) => viewSection(s, m, accountant, from, to);
  const cols = (s: ColumnSection, change = false) => viewColumns(withChange(s, change), m, accountant, from, to);
  const change = (r.compare === "previous_period" || r.compare === "previous_year") && r.columns?.length === 2;
  const diff = (xs: bigint[], on: boolean) => (on ? [...xs, xs[0]! - xs[1]!] : xs).map(m);

  return {
    report,
    title: report === "profit-and-loss" && r.basis === "cash" ? "Profit and loss (cash basis)" : REPORT_TITLES[report]!,
    subtitle: r.range ? `${formatDate(r.range.from)} – ${formatDate(r.range.to)}` : `On ${formatDate(r.asOf)}`,
    range: r.range,
    asOf: r.asOf,
    basis: r.basis,
    compare: r.compare,
    store: r.store,
    stores,
    tag: r.tag,
    tags: r.tags,
    tooMany: r.tooMany,
    canExport,
    csv: `/books/export/${report}?${url.searchParams.toString()}`,
    pl: r.pl
      ? { sales: sec(r.pl.sales), costOfSales: sec(r.pl.costOfSales), grossProfit: m(r.pl.grossProfit), otherIncome: sec(r.pl.otherIncome), expenses: sec(r.pl.expenses), netProfit: m(r.pl.netProfit), loss: r.pl.netProfit < 0n }
      : null,
    cols:
      r.cols && r.columns
        ? {
            heads: [...r.columns.map((c) => c.label), ...(change ? ["Change"] : [])],
            sales: cols(r.cols.sales, change),
            costOfSales: cols(r.cols.costOfSales, change),
            grossProfit: diff(r.cols.grossProfit, change),
            otherIncome: cols(r.cols.otherIncome, change),
            expenses: cols(r.cols.expenses, change),
            netProfit: diff(r.cols.netProfit, change),
          }
        : null,
    bs:
      r.bs && !r.bsCols
        ? { assets: sec(r.bs.assets), liabilities: sec(r.bs.liabilities), equity: sec(r.bs.equity), net: m(r.bs.assets.total - r.bs.liabilities.total), difference: r.bs.difference === 0n ? null : m(r.bs.difference) }
        : null,
    bsCols:
      r.bsCols && r.bsDates
        ? { heads: [...r.bsDates.map((x) => formatDate(x)), "Change"], assets: cols(r.bsCols.assets, true), liabilities: cols(r.bsCols.liabilities, true), equity: cols(r.bsCols.equity, true), net: diff(r.bsCols.net, true) }
        : null,
    tb: r.tb
      ? {
          rows: r.tb.rows.map((x) => ({ accountId: x.accountId, code: x.code, name: x.name, debit: x.debit ? m(x.debit) : "", credit: x.credit ? m(x.credit) : "", href: `/books/reports/general-ledger?${new URLSearchParams({ account: x.accountId, range: "custom", from, to }).toString()}` })),
          totalDebit: m(r.tb.totalDebit),
          totalCredit: m(r.tb.totalCredit),
          off: r.tb.totalDebit !== r.tb.totalCredit,
        }
      : null,
  };
}

export default function Report({ loaderData: d }: Route.ComponentProps) {
  const pl = d.report === "profit-and-loss";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/books/reports" className="text-xs font-semibold text-accent-600">
            ← Reports
          </Link>
          <h2 className="font-display text-xl font-bold text-gray-900">{d.title}</h2>
          <p className="text-sm text-gray-600">{d.subtitle}</p>
        </div>
        <span className="flex flex-wrap gap-4">
          {pl && d.range ? (
            <Link to={`/books/reports/compare-finance?${new URLSearchParams({ range: "custom", from: d.range.from, to: d.range.to, ...(d.store ? { store: d.store } : {}) }).toString()}`} className="text-sm font-semibold text-accent-600">
              Compare with Finance
            </Link>
          ) : null}
          {d.canExport ? <DownloadLink href={d.csv}>Download CSV</DownloadLink> : null}
        </span>
      </div>

      <Card>
        {d.range ? (
          <RangeForm range={d.range}>
            {pl && d.stores.length > 1 ? (
              <select name="store" defaultValue={d.store} aria-label="Store" className={`${inputClass} w-44`}>
                <option value="">Every store</option>
                {d.stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
            {pl ? (
              <select name="basis" defaultValue={d.basis === "cash" ? "cash" : ""} aria-label="Basis" className={`${inputClass} w-56`}>
                <option value="">Accrual: when it happens</option>
                <option value="cash">Cash: when money moves</option>
              </select>
            ) : null}
            {pl ? (
              <select name="compare" defaultValue={d.compare} aria-label="Compare" className={`${inputClass} w-56`}>
                {COMPARE_OPTIONS.filter((o) => o.value !== "tags" || d.tags.length > 0).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : null}
            {pl && d.tags.length > 0 && d.compare !== "tags" ? (
              <select name="tag" defaultValue={d.tag} aria-label="Tag" className={`${inputClass} w-44`}>
                <option value="">All entries</option>
                {d.tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
                <option value="__none">No tag</option>
              </select>
            ) : null}
          </RangeForm>
        ) : (
          <Form method="get" className="flex flex-wrap items-end gap-2">
            <input type="date" name="date" defaultValue={d.asOf ?? ""} aria-label="On" className={`${inputClass} w-44`} />
            {d.report === "balance-sheet" ? (
              <select name="compare" defaultValue={d.compare} aria-label="Compare with" className={`${inputClass} w-56`}>
                <option value="">No comparison</option>
                <option value="previous_month">End of the month before</option>
                <option value="previous_year">Same day last year</option>
              </select>
            ) : null}
            <button type="submit" className={quietButtonClass}>
              Show
            </button>
          </Form>
        )}
        {d.basis === "cash" ? (
          <p className="text-sm text-gray-600">
            Cash basis counts a sale when the money reaches you (a courier or gateway payout, or a customer paying) and a cost when you pay it. Stock counts when you pay for it, not when it sells. Tax, loans and owner money stay out.
          </p>
        ) : null}
        {pl && d.store ? <p className="text-sm text-gray-600">One store's entries only. Entries not tied to a store (rent, salaries, a loan) show under every store together.</p> : null}
      </Card>

      {d.tooMany ? <Notice>Month by month shows up to {MAX_MONTH_COLUMNS} months. Choose a shorter period to see each month.</Notice> : null}

      {d.cols ? (
        <Card>
          <ColumnsTable
            heads={d.cols.heads}
            sections={[
              { s: d.cols.sales },
              { s: d.cols.costOfSales, after: { label: "Gross profit", values: d.cols.grossProfit } },
              { s: d.cols.otherIncome, hideEmpty: true },
              { s: d.cols.expenses, after: { label: "Profit", values: d.cols.netProfit, big: true } },
            ]}
          />
        </Card>
      ) : null}

      {d.pl ? (
        <Card>
          <table className="w-full text-sm">
            <tbody>
              <SectionRows s={d.pl.sales} empty="No sales in this period" />
              <SectionRows s={d.pl.costOfSales} empty="No cost of sales in this period" />
              <LineRow label="Gross profit" value={d.pl.grossProfit} />
              {d.pl.otherIncome.rows.length ? <SectionRows s={d.pl.otherIncome} /> : null}
              <SectionRows s={d.pl.expenses} empty="No running costs in this period" />
              <LineRow label={d.pl.loss ? "Loss" : "Profit"} value={d.pl.netProfit} big />
            </tbody>
          </table>
        </Card>
      ) : null}

      {d.bsCols ? (
        <Card>
          <ColumnsTable
            heads={d.bsCols.heads}
            sections={[
              { s: d.bsCols.assets as ViewColumnSection },
              { s: d.bsCols.liabilities as ViewColumnSection, after: { label: "What you have minus what you owe", values: d.bsCols.net } },
              { s: d.bsCols.equity as ViewColumnSection },
            ]}
          />
        </Card>
      ) : null}

      {d.bs ? (
        <>
          {d.bs.difference ? <Notice tone="warn">This balance sheet is off by {d.bs.difference}. This should never happen; please tell us so we can check your books.</Notice> : null}
          <Card>
            <table className="w-full text-sm">
              <tbody>
                <SectionRows s={d.bs.assets} empty="Nothing recorded yet" />
                <SectionRows s={d.bs.liabilities} empty="You don't owe anything" />
                <LineRow label="What you have minus what you owe" value={d.bs.net} big />
                <SectionRows s={d.bs.equity} empty="Nothing recorded yet" />
              </tbody>
            </table>
          </Card>
        </>
      ) : null}

      {d.tb ? (
        <>
          {d.tb.off ? <Notice tone="warn">Debits and credits don't match. This should never happen; please tell us so we can check your books.</Notice> : null}
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-2 text-left font-semibold">Code</th>
                    <th className="py-2 text-left font-semibold">Account</th>
                    <th className="py-2 text-right font-semibold">Debit</th>
                    <th className="py-2 text-right font-semibold">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {d.tb.rows.map((r) => (
                    <tr key={r.accountId} className="border-b border-gray-50">
                      <td className="py-1.5 text-gray-500">{r.code}</td>
                      <td className="py-1.5">
                        <Link to={r.href} className="text-gray-900 hover:text-accent-600">
                          {r.name}
                        </Link>
                      </td>
                      <td className="py-1.5 text-right">{r.debit ? <Money value={r.debit} /> : null}</td>
                      <td className="py-1.5 text-right">{r.credit ? <Money value={r.credit} /> : null}</td>
                    </tr>
                  ))}
                  <tr className="border-y-2 border-gray-700 font-semibold">
                    <td />
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right">
                      <Money value={d.tb.totalDebit} />
                    </td>
                    <td className="py-2 text-right">
                      <Money value={d.tb.totalCredit} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
