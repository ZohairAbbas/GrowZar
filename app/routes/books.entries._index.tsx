import { Form, Link } from "react-router";

import type { Route } from "./+types/books.entries._index";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { loadDocumentRows } from "~/lib/books/describe.server";
import { formatDate } from "~/lib/books/dates";
import { DOC_LABELS, DOC_TYPES, isDocType, isIsoDate, type DocType } from "~/lib/books/posting";
import { Card, Money, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Entries · Books · Growzar" }];
}

/** Every entry in the books (B4), newest first, filtered by kind, state, dates and words. */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book } = await requireBook(request, "view");
  const p = url.searchParams;
  const type = p.get("type") ?? "";
  const status = p.get("status") ?? "";
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  const q = p.get("q") ?? "";
  const page = Math.max(1, Number(p.get("page") ?? 1) || 1);
  const list = await loadDocumentRows(book, {
    types: isDocType(type) ? [type] : undefined,
    status: status === "draft" || status === "posted" || status === "cancelled" ? status : undefined,
    from: isIsoDate(from) ? from : undefined,
    to: isIsoDate(to) ? to : undefined,
    search: q || undefined,
    page,
    pageSize: 50,
  });
  const accountant = isAccountantRole(viewer.role);
  return {
    filters: { type, status, from, to, q },
    page: list.page,
    pages: Math.max(1, Math.ceil(list.count / list.pageSize)),
    count: list.count,
    rows: list.rows.map((r) => ({ ...r, label: DOC_LABELS[r.type as DocType] ?? r.type, date: formatDate(r.date), total: money(book, BigInt(r.total), accountant) })),
  };
}

const STATUS = { draft: "Draft", posted: "Saved", cancelled: "Cancelled" } as const;

export default function Entries({ loaderData: d }: Route.ComponentProps) {
  const f = d.filters;
  const qs = (page: number) => `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page) }).toString()}`;
  return (
    <div className="space-y-5">
      <Card>
        <Form method="get" className="grid gap-3 md:grid-cols-[1fr_150px_150px_150px_1fr_auto]">
          <select name="type" defaultValue={f.type} aria-label="Kind" className={inputClass}>
            <option value="">Every kind</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOC_LABELS[t]}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={f.status} aria-label="State" className={inputClass}>
            <option value="">Any state</option>
            <option value="draft">Drafts</option>
            <option value="posted">Saved</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input type="date" name="from" defaultValue={f.from} aria-label="From" className={inputClass} />
          <input type="date" name="to" defaultValue={f.to} aria-label="To" className={inputClass} />
          <input name="q" defaultValue={f.q} placeholder="Number or memo" aria-label="Search" className={inputClass} />
          <button type="submit" className={quietButtonClass}>
            Show
          </button>
        </Form>
      </Card>

      <Card title={`${d.count.toLocaleString("en-US")} entr${d.count === 1 ? "y" : "ies"}`}>
        <ul className="divide-y divide-gray-100">
          {d.rows.map((r) => (
            <li key={r.id}>
              <Link to={`/books/entries/${r.id}`} className="grid gap-1 py-2.5 text-sm hover:bg-field md:grid-cols-[110px_110px_1fr_110px_150px]">
                <span className="text-gray-500">{r.date}</span>
                <span className="font-semibold text-gray-900">{r.number ?? "Draft"}</span>
                <span className="min-w-0 truncate text-gray-800">
                  {r.label}: {r.what}
                  {r.contactName ? <span className="text-gray-500"> · {r.contactName}</span> : null}
                  {r.memo ? <span className="text-gray-500"> · {r.memo}</span> : null}
                </span>
                <span className={r.status === "draft" ? "text-accent-600" : r.status === "cancelled" ? "text-gray-400 line-through" : "text-gray-600"}>{STATUS[r.status as keyof typeof STATUS] ?? r.status}</span>
                <Money value={r.total} className="text-right" />
              </Link>
            </li>
          ))}
        </ul>
        {d.pages > 1 ? (
          <div className="flex items-center gap-3 text-sm">
            {d.page > 1 ? <Link to={qs(d.page - 1)} className="font-semibold text-accent-600">Newer</Link> : null}
            <span className="text-gray-500">
              Page {d.page} of {d.pages}
            </span>
            {d.page < d.pages ? <Link to={qs(d.page + 1)} className="font-semibold text-accent-600">Older</Link> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
