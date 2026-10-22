import type { Route } from "./+types/books.export.$report";
import { requireBook } from "~/lib/books-app/access.server";
import { todayIn } from "~/lib/books/dates";
import { reportFile } from "~/lib/books/report-data.server";

/** The reports with a screen in Growzar (B6); the file always matches the screen. */
const FILES = new Set(["profit-and-loss", "balance-sheet", "trial-balance", "cash-flow", "general-ledger", "journal"]);

/** A Books report as CSV (B6). A resource route: the screens link to it, the session authenticates it. */
export async function loader({ request, params, url }: Route.LoaderArgs) {
  const { book } = await requireBook(request, "export");
  if (!FILES.has(params.report)) return new Response("Unknown report", { status: 404 });
  const { filename, body } = await reportFile(book, todayIn(book.settings.timeZone), params.report, url.searchParams);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
