import { prisma } from "../db.server";
import { Forbidden, getViewer, hasPermission, type Viewer } from "../authorize.server";
import { getBook, type BookView } from "../books/books.server";
import type { Action } from "../permissions";
import { booksServerOn, canClosePeriod, scopeAllowsBooks } from "./access";

/**
 * Books' gate (B2, D-80, D-81, D-91). Every Books loader and action calls
 * `requireBooks`; hiding the navigation is presentation only.
 */
export const booksEnabled = () => booksServerOn(process.env.BOOKS_ENABLED);

/** Is Books on for this organization (server switch and the organization's own)? */
export async function booksOn(organizationId: string): Promise<boolean> {
  if (!booksEnabled()) return false;
  const s = await prisma.booksSettings.findUnique({ where: { organizationId }, select: { enabled: true } });
  return Boolean(s?.enabled);
}

/** Should the navigation show Books to this viewer? Same rules as `requireBooks`, without throwing. */
export async function booksVisible(request: Request, viewer: Viewer): Promise<boolean> {
  if (!scopeAllowsBooks(viewer.scopedStoreIds)) return false;
  if (!(await booksOn(viewer.organizationId))) return false;
  return hasPermission(request, viewer.organizationId, "books", "view");
}

export type BooksContext = {
  viewer: Viewer;
  /** null until the organization sets its book up. */
  book: BookView | null;
  canManage: boolean;
  canExport: boolean;
  /** Owners and admins only (D-70). */
  canClose: boolean;
};

/**
 * The viewer, their book and what they may do in it. A Books page that is off
 * answers 404, as Plan does, so the pilot stays invisible; a member who may
 * not use it gets 403 with the reason.
 */
export async function requireBooks(request: Request, action: Action = "view"): Promise<BooksContext> {
  const viewer = await getViewer(request);
  if (!(await booksOn(viewer.organizationId))) throw new Response("Not found", { status: 404 });
  const [view, manage, exp] = await Promise.all([
    hasPermission(request, viewer.organizationId, "books", "view"),
    hasPermission(request, viewer.organizationId, "books", "manage"),
    hasPermission(request, viewer.organizationId, "books", "export"),
  ]);
  const allowed = { view, manage, export: exp }[action];
  if (!allowed) throw new Forbidden(`Your role does not allow ${action} on books.`);
  if (!scopeAllowsBooks(viewer.scopedStoreIds)) {
    throw new Forbidden("Books covers every store in the organization, so it needs access to all of them.");
  }
  const book = await getBook(viewer.organizationId);
  return { viewer, book, canManage: manage, canExport: exp, canClose: canClosePeriod(viewer.role) };
}

/** As `requireBooks`, and the book must exist. */
export async function requireBook(request: Request, action: Action = "view"): Promise<BooksContext & { book: BookView }> {
  const ctx = await requireBooks(request, action);
  if (!ctx.book) throw new Response(null, { status: 302, headers: { Location: "/books/setup" } });
  return ctx as BooksContext & { book: BookView };
}
