import type { Route } from "./+types/books.attachments.$id";
import { requireBook } from "~/lib/books-app/access.server";
import { getAttachment } from "~/lib/books/attachments.server";

/** A receipt or bill kept with an entry (Books v1.1 V6): only to someone who can open Books, never cached. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { book } = await requireBook(request, "view");
  const a = await getAttachment(book, params.id);
  if (!a) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(a.data), {
    headers: {
      "Content-Type": a.contentType,
      "Content-Length": String(a.size),
      "Content-Disposition": `inline; filename="${a.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
