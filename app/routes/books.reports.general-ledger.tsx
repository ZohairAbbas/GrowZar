import { Link } from "react-router";

import type { Route } from "./+types/books.reports.general-ledger";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { reportAccounts } from "~/lib/books/books.server";
import { formatDate, todayIn } from "~/lib/books/dates";
import { generalLedger } from "~/lib/books/ledger-views.server";
import { rangeFrom } from "~/lib/books/report-data.server";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Money, inputClass } from "~/components/books/BooksUi";
import { DownloadLink, RangeForm } from "~/components/books/ReportUi";

export function meta() {
  return [{ title: "General ledger · Books · Growzar" }];
}

/**
 * General ledger (B6): every account's lines in a period, with the balance
 * carried in, a running balance and the balance at the end. One account, or
 * all. Ported from Financify's reports.general-ledger; every report's
 * account rows open here.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canExport } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const range = rangeFrom(book, todayIn(book.settings.timeZone), url.searchParams);
  const all = await reportAccounts(book);
  const want = url.searchParams.get("account");
  const accountId = all.some((a) => a.id === want) ? want : null;
  const gl = await generalLedger(book, { from: range.from, to: range.to, accountId });
  // Ledger sign: + is a debit balance, − a credit balance.
  const bal = (v: bigint) => (v === 0n ? m(0n) : `${m(v < 0n ? -v : v)} ${v > 0n ? "Dr" : "Cr"}`);
  return {
    range,
    accountId: accountId ?? "",
    subtitle: `${formatDate(range.from)} – ${formatDate(range.to)}`,
    fromLabel: formatDate(range.from),
    canExport,
    csv: `/books/export/general-ledger?${url.searchParams.toString()}`,
    truncated: gl.truncated ? gl.limit.toLocaleString() : null,
    choices: all
      .filter((a) => !a.archived || a.id === accountId)
      .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))
      .map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` })),
    accounts: gl.accounts.map((a) => ({
      id: a.account.id,
      title: `${a.account.code} · ${a.account.name}`,
      opening: bal(a.opening),
      closing: bal(a.closing),
      lines: a.lines.map((l) => ({
        id: l.id,
        date: formatDate(l.date),
        documentId: l.documentId,
        number: l.number ?? "Draft",
        what: [l.kind, l.contactName].filter(Boolean).join(" · ") + (l.cancel ? " (cancelled)" : ""),
        note: l.note ?? "",
        debit: l.amount > 0n ? m(l.amount) : "",
        credit: l.amount < 0n ? m(-l.amount) : "",
        running: bal(l.running),
      })),
    })),
  };
}

export default function GeneralLedger({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/books/reports" className="text-xs font-semibold text-accent-600">
            ← Reports
          </Link>
          <h2 className="font-display text-xl font-bold text-gray-900">General ledger</h2>
          <p className="text-sm text-gray-600">{d.subtitle}</p>
        </div>
        {d.canExport ? <DownloadLink href={d.csv}>Download CSV</DownloadLink> : null}
      </div>
      <Card>
        <RangeForm range={d.range}>
          <select name="account" defaultValue={d.accountId} aria-label="Account" className={`${inputClass} w-64`}>
            <option value="">Every account</option>
            {d.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </RangeForm>
      </Card>
      {d.truncated ? <Notice>This shows the first {d.truncated} lines. Choose one account or a shorter period to see the rest; the download has everything. Each account's end balance is always complete.</Notice> : null}
      {d.accounts.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-600">No account has a balance or any movement between these dates.</p>
        </Card>
      ) : (
        d.accounts.map((a) => (
          <Card key={a.id} title={a.title} aside={<span className="text-xs text-gray-500">{a.lines.length} line{a.lines.length === 1 ? "" : "s"}</span>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-2 text-left font-semibold">Date</th>
                    <th className="py-2 text-left font-semibold">Number</th>
                    <th className="py-2 text-left font-semibold">What</th>
                    <th className="py-2 text-left font-semibold">Note</th>
                    <th className="py-2 text-right font-semibold">Debit</th>
                    <th className="py-2 text-right font-semibold">Credit</th>
                    <th className="py-2 text-right font-semibold">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-50 text-gray-500">
                    <td className="py-1.5">{d.fromLabel}</td>
                    <td />
                    <td className="py-1.5" colSpan={4}>
                      Balance carried in
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{a.opening}</td>
                  </tr>
                  {a.lines.map((l) => (
                    <tr key={l.id} className="border-b border-gray-50">
                      <td className="py-1.5 whitespace-nowrap">{l.date}</td>
                      <td className="py-1.5">
                        <Link to={`/books/entries/${l.documentId}`} className="text-accent-600 hover:text-accent-700">
                          {l.number}
                        </Link>
                      </td>
                      <td className="py-1.5">{l.what}</td>
                      <td className="py-1.5 text-gray-600">{l.note}</td>
                      <td className="py-1.5 text-right">{l.debit ? <Money value={l.debit} /> : null}</td>
                      <td className="py-1.5 text-right">{l.credit ? <Money value={l.credit} /> : null}</td>
                      <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{l.running}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-gray-300 font-semibold">
                    <td colSpan={6} className="py-2">
                      Balance at the end
                    </td>
                    <td className="py-2 text-right tabular-nums whitespace-nowrap">{a.closing}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
