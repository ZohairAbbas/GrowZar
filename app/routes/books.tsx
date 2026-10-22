import { Outlet, redirect } from "react-router";
import { BookOpen } from "lucide-react";

import type { Route } from "./+types/books";
import { requireBooks } from "~/lib/books-app/access.server";
import { formatDate } from "~/lib/books/dates";
import { Notice } from "~/components/metrics/Metrics";
import { BooksTabs } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Books · Growzar" }];
}

/**
 * Books (B2): the organization's double-entry books (D-62). Every child route
 * runs its own `requireBooks`; this layout only frames them and sends a
 * first visit to setup.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { book, canManage } = await requireBooks(request, "view");
  const onSetup = url.pathname.replace(/\/+$/, "") === "/books/setup";
  if (!book) {
    if (canManage && !onSetup) throw redirect("/books/setup");
    return { setUp: false as const, canManage, onSetup };
  }
  if (onSetup) throw redirect("/books");
  return {
    setUp: true as const,
    canManage,
    onSetup,
    currency: book.currency,
    startDate: formatDate(book.settings.startDate ?? null),
    closedThrough: book.lockedThrough ? formatDate(book.lockedThrough) : null,
  };
}

export default function BooksLayout({ loaderData: d }: Route.ComponentProps) {
  if (!d.setUp && !d.onSetup) {
    return <Notice>Your organization's books aren't set up yet. An owner, admin or accountant can set them up.</Notice>;
  }
  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold text-gray-900">
            <BookOpen className="h-6 w-6 text-accent-600" /> Books
          </h1>
          {d.setUp ? (
            <p className="mt-1 text-sm text-gray-600">
              In {d.currency}, from {d.startDate}.{d.closedThrough ? ` Closed through ${d.closedThrough}.` : ""}
            </p>
          ) : (
            <p className="mt-1 text-sm text-gray-600">Set up your organization's books. It takes a few minutes, and nothing is posted until you finish.</p>
          )}
        </div>
        {d.setUp ? <BooksTabs /> : null}
      </header>
      <Outlet />
    </div>
  );
}
