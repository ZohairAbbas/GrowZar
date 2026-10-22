import { CheckCircle2, Download, PenLine, RefreshCw } from "lucide-react";

import type { Route } from "./+types/books.sources";
import { prisma } from "~/lib/db.server";
import { requireBook } from "~/lib/books-app/access.server";
import { SOURCE_LABELS, installHref, storeCoverage, type SourceStatus } from "~/lib/books-app/coverage";
import { APP_LABELS } from "~/lib/sections";
import { Card } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Where entries come from · Books · Growzar" }];
}

/**
 * Where each store's entries come from (B2, D-66, D-78): automatic from an app
 * Growzar reads, missing (with the tracked install button), or by hand. The
 * page says what will post before anything does.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book } = await requireBook(request, "view");
  const stores = await prisma.store.findMany({
    where: { id: { in: book.settings.storeIds ?? [] }, organizationId: viewer.organizationId },
    orderBy: { shopDomain: "asc" },
    select: { id: true, shopDomain: true, displayName: true, connections: { select: { app: true, status: true, capabilities: true } } },
  });
  return {
    stores: stores.map((s) => ({
      id: s.id,
      name: s.displayName ?? s.shopDomain,
      sources: storeCoverage(s.connections).map((c) => ({ ...c, ...SOURCE_LABELS[c.source] })),
    })),
  };
}

function Status({ storeId, status }: { storeId: string; status: SourceStatus }) {
  switch (status.kind) {
    case "auto":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-mint-700">
          <CheckCircle2 className="h-4 w-4" /> Automatic from {status.note ?? APP_LABELS[status.app]}
        </span>
      );
    case "missing":
      return (
        <span className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
          <a href={installHref(storeId, status.app)} className="inline-flex items-center gap-1.5 rounded-full bg-navy px-3 py-1 text-xs font-semibold text-white hover:bg-navy-surface">
            <Download className="h-3.5 w-3.5" /> Install {APP_LABELS[status.app]}
          </a>
          or {status.byHand.charAt(0).toLowerCase() + status.byHand.slice(1)}
        </span>
      );
    case "update":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-gray-600">
          <RefreshCw className="h-4 w-4" /> {APP_LABELS[status.app]} needs an update for this. {status.byHand}
        </span>
      );
    case "by_hand":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-gray-600">
          <PenLine className="h-4 w-4" /> By hand. {status.byHand}
        </span>
      );
  }
}

export default function BooksSources({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-600">What reaches your books from each store. Automatic entries arrive each day as drafts you check and save, or saved for you once you trust them.</p>
      {d.stores.map((s) => (
        <Card key={s.id} title={s.name}>
          <ul className="divide-y divide-gray-100">
            {s.sources.map((src) => (
              <li key={src.source} className="grid gap-1 py-2.5 md:grid-cols-[220px_1fr]">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{src.label}</p>
                  <p className="text-xs text-gray-500">{src.what}</p>
                </div>
                <div className="md:pt-0.5">
                  <Status storeId={s.id} status={src.status} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
