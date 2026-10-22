import type { Route } from "./+types/books.export.pack";
import { requireBook } from "~/lib/books-app/access.server";
import { organizationName } from "~/lib/books-app/reports.server";
import { todayIn } from "~/lib/books/dates";
import { accountantPack } from "~/lib/books/report-data.server";

/** Every report for a period as CSV files in a ZIP (B6): what an accountant asks for at year end. */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book } = await requireBook(request, "export");
  const { filename, body } = await accountantPack(book, todayIn(book.settings.timeZone), url.searchParams, await organizationName(viewer.organizationId));
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(body.length),
      "Content-Disposition": `attachment; filename="${filename}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
