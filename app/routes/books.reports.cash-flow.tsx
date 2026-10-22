import { Link } from "react-router";

import type { Route } from "./+types/books.reports.cash-flow";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { viewSection } from "~/lib/books-app/report-view";
import { formatDate, todayIn } from "~/lib/books/dates";
import { buildCashFlow } from "~/lib/books/report-data.server";
import { Notice } from "~/components/metrics/Metrics";
import { Card } from "~/components/books/BooksUi";
import { DownloadLink, LineRow, RangeForm, SectionRows } from "~/components/books/ReportUi";

export function meta() {
  return [{ title: "Cash flow · Books · Growzar" }];
}

/**
 * Cash flow (B6): why the money in your accounts went up or down in a period,
 * starting from profit, then what tied money up or freed it, then the owner's
 * money and loans. Ported from Financify's reports.cash-flow.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canExport } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const { range, cf } = await buildCashFlow(book, todayIn(book.settings.timeZone), url.searchParams);
  const sec = (s: Parameters<typeof viewSection>[0]) => viewSection(s, m, accountant, range.from, range.to);
  return {
    range,
    subtitle: `${formatDate(range.from)} – ${formatDate(range.to)}`,
    canExport,
    csv: `/books/export/cash-flow?${url.searchParams.toString()}`,
    opening: m(cf.opening),
    operating: sec(cf.operating),
    financing: sec(cf.financing),
    netChange: m(cf.netChange),
    closing: m(cf.closing),
    difference: cf.difference === 0n ? null : m(cf.difference),
  };
}

export default function CashFlow({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/books/reports" className="text-xs font-semibold text-accent-600">
            ← Reports
          </Link>
          <h2 className="font-display text-xl font-bold text-gray-900">Cash flow</h2>
          <p className="text-sm text-gray-600">{d.subtitle}</p>
        </div>
        {d.canExport ? <DownloadLink href={d.csv}>Download CSV</DownloadLink> : null}
      </div>
      <Card>
        <RangeForm range={d.range} />
      </Card>
      {d.difference ? <Notice tone="warn">This doesn't add up (off by {d.difference}). This should never happen; please tell us so we can check your books.</Notice> : null}
      <Card>
        <table className="w-full text-sm">
          <tbody>
            <LineRow label="Money at the start" value={d.opening} />
            <SectionRows s={d.operating} />
            <tr>
              <td colSpan={2} className="pt-1 text-xs text-gray-500">
                Profit, then money tied up or freed: more owed to you or more stock means less money in hand; owing suppliers more means more.
              </td>
            </tr>
            <SectionRows s={d.financing} empty="Nothing in this period" />
            <tr>
              <td colSpan={2} className="pt-1 text-xs text-gray-500">
                Money the owner put in or took out, loans, and opening balances you entered.
              </td>
            </tr>
            <LineRow label="Change in money" value={d.netChange} />
            <LineRow label="Money at the end" value={d.closing} big />
          </tbody>
        </table>
        <p className="text-xs text-gray-500">Money means your bank accounts, cash, mobile wallets and prepaid ad wallets. Credit cards count as something you owe.</p>
      </Card>
    </div>
  );
}
