import { prisma } from "../db.server";
import type { BookView } from "../books/books.server";

/** The book's stores by name, for the "which store" choice on the profit and loss (D-65). */
export async function bookStores(book: BookView): Promise<Array<{ id: string; name: string }>> {
  const ids = book.settings.storeIds ?? [];
  if (ids.length === 0) return [];
  const rows = await prisma.store.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, shopDomain: true } });
  return rows.map((s) => ({ id: s.id, name: s.displayName || s.shopDomain.replace(/\.myshopify\.com$/, "") })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The organization's name, for the workbook and printed statements. */
export async function organizationName(organizationId: string): Promise<string> {
  const o = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  return o?.name || "Your business";
}
