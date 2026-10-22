import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/books.drafts";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { MAX_APPROVE, approveDocuments, draftTotals, listDocuments } from "~/lib/books/books.server";
import { formatDate } from "~/lib/books/dates";
import { DOC_LABELS, type DocType } from "~/lib/books/posting";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Money, buttonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "To approve · Books · Growzar" }];
}

/**
 * Drafts waiting (B4): what the connectors brought in and what was kept as a
 * draft. Saved oldest first, each on its own: one refusal (a closed month, a
 * figure that changed since you looked) doesn't stop the rest, and every
 * outcome is listed.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const list = await listDocuments(book, { status: "draft", pageSize: 100 });
  const totals = await draftTotals(book, list.rows);
  const accountant = isAccountantRole(viewer.role);
  return {
    canManage,
    count: list.count,
    max: MAX_APPROVE,
    rows: [...list.rows]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((r) => ({ id: r.id, updatedAt: r.updatedAt.toISOString(), date: formatDate(r.date.toISOString().slice(0, 10)), label: DOC_LABELS[r.type as DocType] ?? r.type, memo: r.memo, contact: r.contactName, auto: r.source !== "manual", total: money(book, totals.get(r.id) ?? 0n, accountant) })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const items = form.getAll("pick").map((v) => {
    const [id, updatedAt] = String(v).split("|");
    return { id: id ?? "", updatedAt: updatedAt ?? "" };
  });
  if (items.length === 0) return { results: [], error: "Choose what to save." };
  try {
    return { results: await approveDocuments(book, items, viewer.userId) };
  } catch (e) {
    return { results: [], error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

export default function Drafts({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const results = actionData?.results ?? [];
  const saved = results.filter((r) => r.ok).length;
  const refused = results.filter((r) => !r.ok);
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <Form method="post" className="space-y-5">
      {actionData?.error ? <Notice tone="warn">{actionData.error}</Notice> : null}
      {results.length ? (
        <Notice tone={refused.length ? "warn" : "info"}>
          {saved} saved to the books.{refused.length ? ` ${refused.length} couldn't be: ${refused.slice(0, 5).map((r) => r.message).join("; ")}` : ""}
        </Notice>
      ) : null}
      <Card
        title={`${d.count} waiting`}
        aside={
          d.canManage && d.rows.length ? (
            <span className="flex gap-2">
              <button type="button" className="text-sm font-semibold text-accent-600" onClick={() => setPicked(new Set(d.rows.slice(0, d.max).map((r) => r.id)))}>
                Choose {Math.min(d.rows.length, d.max)}
              </button>
              <button type="submit" className={buttonClass} disabled={busy || picked.size === 0}>
                Save {picked.size || ""} to the books
              </button>
            </span>
          ) : null
        }
      >
        {d.rows.length === 0 ? <p className="text-sm text-gray-500">Nothing is waiting.</p> : null}
        <ul className="divide-y divide-gray-100">
          {d.rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
              {d.canManage ? <input type="checkbox" name="pick" value={`${r.id}|${r.updatedAt}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Choose ${r.label} ${r.date}`} className="h-4 w-4" /> : null}
              <Link to={`/books/entries/${r.id}`} className="grid min-w-0 flex-1 gap-1 md:grid-cols-[110px_1fr_150px]">
                <span className="text-gray-500">{r.date}</span>
                <span className="min-w-0 truncate text-gray-800">
                  {r.label}
                  {r.auto ? <span className="ml-1.5 rounded-full bg-field px-2 py-0.5 text-[11px] font-semibold text-gray-500">Automatic</span> : null}
                  {r.memo ? <span className="text-gray-500"> · {r.memo}</span> : null}
                </span>
                <Money value={r.total} className="text-right" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </Form>
  );
}
