import { Form, Link } from "react-router";

import type { Route } from "./+types/books.activity";
import { prisma } from "~/lib/db.server";
import { requireBook } from "~/lib/books-app/access.server";
import { ACTIVITY_KINDS, actorLabel } from "~/lib/books/activity";
import { activityLog } from "~/lib/books/ledger-views.server";
import { Card, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Activity · Books · Growzar" }];
}

/** Who did what in the books, in plain words, newest first (B4). */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book } = await requireBook(request, "view");
  const kind = url.searchParams.get("kind") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const log = await activityLog(book, { kind, page, pageSize: 50 });
  const actors = [...new Set(log.events.map((e) => e.actor).filter((x): x is string => !!x))];
  const users = actors.length ? await prisma.user.findMany({ where: { id: { in: actors } }, select: { id: true, name: true } }) : [];
  const name = new Map(users.map((u) => [u.id, u.name]));
  return {
    kind,
    page: log.page,
    pages: Math.max(1, Math.ceil(log.count / log.pageSize)),
    events: log.events.map((e) => ({ ...e, who: e.actor ? name.get(e.actor) ?? actorLabel(e.actor, viewer.userId) : "Automatic" })),
  };
}

export default function Activity({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <Card>
        <Form method="get" className="flex flex-wrap gap-2">
          <select name="kind" defaultValue={d.kind} aria-label="What" className={`${inputClass} md:w-72`}>
            {ACTIVITY_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <button type="submit" className={quietButtonClass}>
            Show
          </button>
        </Form>
      </Card>
      <Card>
        <ul className="divide-y divide-gray-100">
          {d.events.map((e) => (
            <li key={e.id} className="grid gap-1 py-2 text-sm md:grid-cols-[170px_160px_1fr]">
              <span className="text-gray-500">{new Date(e.at).toLocaleString("en-GB")}</span>
              <span className="text-gray-600">{e.who}</span>
              <span className="text-gray-800">
                {e.link ? <Link to={e.link} className="text-accent-600">{e.text}</Link> : e.text}
              </span>
            </li>
          ))}
        </ul>
        {d.pages > 1 ? (
          <div className="flex items-center gap-3 text-sm">
            {d.page > 1 ? <Link to={`?kind=${d.kind}&page=${d.page - 1}`} className="font-semibold text-accent-600">Newer</Link> : null}
            <span className="text-gray-500">
              Page {d.page} of {d.pages}
            </span>
            {d.page < d.pages ? <Link to={`?kind=${d.kind}&page=${d.page + 1}`} className="font-semibold text-accent-600">Older</Link> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
