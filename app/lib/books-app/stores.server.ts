import { prisma } from "../db.server";
import { BooksError, updateBookSettings, type BookView } from "../books/books.server";

/**
 * Adding one of the organization's stores to its book after setup (v1.1 V1,
 * D-96). A store in another currency goes in converted at each day's rate.
 * The connectors bring its days in from their own start dates: sales and
 * courier payouts keep their place per store, so the new store simply starts
 * at the beginning; ad spend keeps one place for the whole book, so it starts
 * over from its start date, and the days already saved are recognised, never
 * posted twice.
 */
export async function addStore(book: BookView, organizationId: string, storeId: string, actor: string | null): Promise<{ name: string; currency: string }> {
  const store = await prisma.store.findFirst({ where: { id: storeId, organizationId }, select: { id: true, shopDomain: true, displayName: true, currency: true } });
  if (!store) throw new BooksError("That store isn't in your organization");
  if (!store.currency) throw new BooksError("Growzar doesn't know this store's currency yet, so it can't go in");
  const name = store.displayName ?? store.shopDomain;
  let added = false;
  await updateBookSettings(book, (cur) => {
    const ids = cur.storeIds ?? [];
    if (ids.includes(store.id)) return {};
    added = true;
    return { storeIds: [...ids, store.id] };
  });
  if (!added) throw new BooksError(`${name} is already in these books`);
  await prisma.bkConnector.updateMany({ where: { bookId: book.id, key: "ad_spend" }, data: { syncedThrough: null } });
  await prisma.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "book.store_added", detail: { storeId: store.id, name, currency: store.currency } } });
  return { name, currency: store.currency };
}
