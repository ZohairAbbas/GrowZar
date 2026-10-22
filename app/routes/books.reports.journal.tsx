import { Link } from "react-router";

import type { Route } from "./+types/books.reports.journal";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { reportAccounts } from "~/lib/books/books.server";
import { formatDate, todayIn } from "~/lib/books/dates";
import { journal } from "~/lib/books/ledger-views.server";
import { rangeFrom } from "~/lib/books/report-data.server";
import { Card, Money } from "~/components/books/BooksUi";
import { DownloadLink, RangeForm } from "~/components/books/ReportUi";

export function meta() {
  return [{ title: "Journal · Books · Growzar" }];
}

/**
 * Journal (B6): every entry in a period, oldest first, with its debits and
 * credits. Cancellations show as their own (mirror) entries. Ported from
 * Financify's reports.journal.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canExport } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const range = rangeFrom(book, todayIn(book.settings.timeZone), url.searchParams);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const [j, accounts] = await Promise.all([journal(book, { from: range.from, to: range.to, page, pageSize: 50 }), reportAccounts(book)]);
  const acc = new Map(accounts.map((a) => [a.id, `${a.code} · ${a.name}`]));
  const qs = (p: number) => {
    const next = new URLSearchParams(url.searchParams);
    next.set("page", String(p));
    return `?${next.toString()}`;
  };
  return {
    range,
    subtitle: `${formatDate(range.from)} – ${formatDate(range.to)}`,
    canExport,
    csv: `/books/export/journal?${url.searchParams.toString()}`,
    count: j.count,
    shown: j.count ? `Entries ${(j.page - 1) * j.pageSize + 1}–${Math.min(j.page * j.pageSize, j.count)} of ${j.count}` : "",
    prev: j.page > 1 ? qs(j.page - 1) : null,
    next: j.page * j.pageSize < j.count ? qs(j.page + 1) : null,
    entries: j.entries.map((e) => ({
      id: e.id,
      date: formatDate(e.date),
      documentId: e.documentId,
      number: e.number ?? "Entry",
      what: [e.cancel ? `${e.kind} (cancelled)` : e.kind, e.contactName].filter(Boolean).join(" · "),
      lines: e.lines.map((l) => ({
        id: l.id,
        account: acc.get(l.accountId) ?? "Unknown account",
        description: l.description ?? "",
        credit: l.amount < 0n,
        debitAmount: l.amount > 0n ? m(l.amount) : "",
        creditAmount: l.amount < 0n ? m(-l.amount) : "",
      })),
    })),
  };
}

export default function Journal({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/books/reports" className="text-xs font-semibold text-accent-600">
            ← Reports
          </Link>
          <h2 className="font-display text-xl font-bold text-gray-900">Journal</h2>
          <p className="text-sm text-gray-600">{d.subtitle}</p>
        </div>
        {d.canExport ? <DownloadLink href={d.csv}>Download CSV</DownloadLink> : null}
      </div>
      <Card>
        <RangeForm range={d.range} />
      </Card>
      <Card>
        {d.entries.length === 0 ? (
          <p className="text-sm text-gray-600">No entries in this period. Saved entries and cancellations dated in it show here.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-2 text-left font-semibold">Date</th>
                    <th className="py-2 text-left font-semibold">Entry</th>
                    <th className="py-2 text-left font-semibold">Account</th>
                    <th className="py-2 text-right font-semibold">Debit</th>
                    <th className="py-2 text-right font-semibold">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {d.entries.map((e) =>
                    e.lines.map((l, i) => (
                      <tr key={l.id} className={i === e.lines.length - 1 ? "border-b border-gray-200" : undefined}>
                        <td className="py-1.5 align-top whitespace-nowrap">{i === 0 ? e.date : null}</td>
                        <td className="py-1.5 align-top">
                          {i === 0 ? (
                            <>
                              <Link to={`/books/entries/${e.documentId}`} className="text-accent-600 hover:text-accent-700">
                                {e.number}
                              </Link>
                              <span className="block text-xs text-gray-500">{e.what}</span>
                            </>
                          ) : null}
                        </td>
                        {/* Credits are indented, as on paper. */}
                        <td className={`py-1.5 ${l.credit ? "pl-6" : ""}`}>
                          {l.account}
                          {l.description ? <span className="text-xs text-gray-500"> — {l.description}</span> : null}
                        </td>
                        <td className="py-1.5 text-right">{l.debitAmount ? <Money value={l.debitAmount} /> : null}</td>
                        <td className="py-1.5 text-right">{l.creditAmount ? <Money value={l.creditAmount} /> : null}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-sm">
              {d.prev ? <Link to={d.prev} className="font-semibold text-accent-600">← Earlier</Link> : <span />}
              <span className="text-gray-500">{d.shown}</span>
              {d.next ? <Link to={d.next} className="font-semibold text-accent-600">Later →</Link> : <span />}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
