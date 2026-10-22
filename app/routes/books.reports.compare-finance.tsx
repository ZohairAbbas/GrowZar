import { Link } from "react-router";

import type { Route } from "./+types/books.reports.compare-finance";
import { requireBook } from "~/lib/books-app/access.server";
import { compareWithFinance } from "~/lib/books-app/compare-finance.server";
import { sameish } from "~/lib/books-app/compare-finance";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { bookStores } from "~/lib/books-app/reports.server";
import { CONNECTORS } from "~/lib/books/connectors/registry";
import { formatDate, todayIn } from "~/lib/books/dates";
import { rangeFrom } from "~/lib/books/report-data.server";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Money, inputClass } from "~/components/books/BooksUi";
import { RangeForm } from "~/components/books/ReportUi";

export function meta() {
  return [{ title: "Books and Finance · Books · Growzar" }];
}

/**
 * Books next to Finance (B6, D-69): the two profits for one store, line by
 * line, with the difference and why the two count differently. Ported from
 * Financify's compare-dashboard.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const range = rangeFrom(book, todayIn(book.settings.timeZone), url.searchParams);
  const stores = await bookStores(book);
  const want = url.searchParams.get("store");
  const store = stores.find((s) => s.id === want) ?? stores[0] ?? null;
  if (!store) return { range, stores, store: null, result: null };
  const c = await compareWithFinance(book, store.id, range);
  return {
    range,
    stores,
    store,
    result: {
      subtitle: `${store.name} · ${formatDate(range.from)} – ${formatDate(range.to)}`,
      drafts: c.drafts,
      problems: c.problems,
      financeMissing: c.financeMissing,
      coverage: c.coverage
        .filter((x) => !x.enabled || (x.startDate && x.startDate > range.from) || !x.syncedThrough || x.syncedThrough < range.to)
        .map((x) => {
          const name = CONNECTORS.find((k) => k.key === x.key)?.name ?? x.key;
          if (!x.enabled) return `${name} isn't switched on in Books, so Books has none of it for these days.`;
          if (x.startDate && x.startDate > range.from) return `${name} starts on ${formatDate(x.startDate)} in Books; days before that aren't in Books from it.`;
          return `${name} has brought things in up to ${x.syncedThrough ? formatDate(x.syncedThrough) : "no day yet"}.`;
        }),
      booksNet: m(c.booksNet),
      financeNet: c.financeNet === null ? null : m(c.financeNet),
      netSame: c.financeNet !== null && sameish(c.booksNet, c.financeNet, book.decimals),
      rows: c.rows?.map((r) => ({ key: r.key, label: r.label, why: r.why, finance: m(r.finance), books: m(r.books), difference: m(r.difference), same: sameish(r.books, r.finance, book.decimals) })) ?? null,
    },
  };
}

export default function CompareFinance({ loaderData: d }: Route.ComponentProps) {
  const r = d.result;
  return (
    <div className="space-y-5">
      <div>
        <Link to="/books/reports" className="text-xs font-semibold text-accent-600">
          ← Reports
        </Link>
        <h2 className="font-display text-xl font-bold text-gray-900">Books and Finance</h2>
        {r ? <p className="text-sm text-gray-600">{r.subtitle}</p> : null}
      </div>
      <Card>
        <RangeForm range={d.range}>
          {d.stores.length > 1 ? (
            <select name="store" defaultValue={d.store?.id ?? ""} aria-label="Store" className={`${inputClass} w-44`}>
              {d.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null}
        </RangeForm>
        <p className="text-sm text-gray-600">
          Finance shows what your orders earned: the delivered orders placed in these days. Books shows what happened in these days, as an accountant counts it. Both are right; they answer different questions. Here's where they part.
        </p>
      </Card>

      {!r ? <Notice>Your books don't cover a store yet.</Notice> : null}
      {r?.problems.map((p) => (
        <Notice key={p} tone="warn">
          {p}
        </Notice>
      ))}
      {r && r.drafts > 0 ? (
        <Notice>
          {r.drafts} draft{r.drafts === 1 ? " is" : "s are"} waiting in these days and {r.drafts === 1 ? "isn't" : "aren't"} counted in Books yet.{" "}
          <Link to="/books/drafts" className="font-semibold underline">
            See what's waiting
          </Link>
          .
        </Notice>
      ) : null}
      {r?.coverage.map((c) => <Notice key={c}>{c}</Notice>)}

      {r?.rows ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 text-left font-semibold" />
                  <th className="px-3 py-2 text-right font-semibold">Finance</th>
                  <th className="px-3 py-2 text-right font-semibold">Books</th>
                  <th className="px-3 py-2 text-right font-semibold">Difference</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((x) => (
                  <tr key={x.key} className="border-b border-gray-50 align-top">
                    <td className="py-2 pr-4">
                      <span className="font-semibold text-gray-900">{x.label}</span>
                      {!x.same ? <p className="mt-0.5 max-w-xl text-xs text-gray-500">{x.why}</p> : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money value={x.finance} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money value={x.books} />
                    </td>
                    <td className="px-3 py-2 text-right">{x.same ? <span className="text-xs text-gray-500">Same</span> : <Money value={x.difference} />}</td>
                  </tr>
                ))}
                <tr className="border-y-2 border-gray-700 font-semibold">
                  <td className="py-2">Profit</td>
                  <td className="px-3 py-2 text-right">{r.financeNet !== null ? <Money value={r.financeNet} /> : null}</td>
                  <td className="px-3 py-2 text-right">
                    <Money value={r.booksNet} />
                  </td>
                  <td className="px-3 py-2 text-right">{r.netSame ? <span className="text-xs text-gray-500">Same</span> : null}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {r.financeMissing.length ? (
            <p className="text-xs text-gray-500">
              Finance says its profit for these days is incomplete: {r.financeMissing.join("; ")}.
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
