import { Link } from "react-router";

import type { Route } from "./+types/books.new._index";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { RECORD_TYPES } from "~/lib/books-app/record";

export function meta() {
  return [{ title: "Record · Books · Growzar" }];
}

/** The Record menu (B4): what a person can record by hand, in plain words. */
export async function loader({ request }: Route.LoaderArgs) {
  const { canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  return null;
}

export default function RecordMenu() {
  return (
    <div className="space-y-3">
      <h2 className="font-display text-xl font-bold text-gray-900">What would you like to record?</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {RECORD_TYPES.map((t) => (
          <Link key={t.type} to={`/books/new/${t.type}`} className="rounded-2xl bg-white p-4 transition hover:ring-2 hover:ring-accent-500/30">
            <p className="font-semibold text-gray-900">{t.label}</p>
            <p className="mt-1 text-sm text-gray-600">{t.help}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
