import type { Route } from "./+types/books.export.workbook";
import { requireBook } from "~/lib/books-app/access.server";
import { organizationName } from "~/lib/books-app/reports.server";
import { todayIn } from "~/lib/books/dates";
import { buildWorkbook } from "~/lib/books/workbook.server";

/** The full Books export as an Excel workbook (B6, D-91), a sheet per report. */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book } = await requireBook(request, "export");
  const { filename, body } = await buildWorkbook(book, todayIn(book.settings.timeZone), url.searchParams, await organizationName(viewer.organizationId));
  return new Response(Buffer.from(body), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": String(body.length),
      "Content-Disposition": `attachment; filename="${filename}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
