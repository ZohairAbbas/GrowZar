import { prisma } from "../db.server";
import type { BookView } from "../books/books.server";
import { pickRate, RATE_LOOKBACK_DAYS, type BookRate } from "./fx";

/**
 * The stored rates a set of foreign amounts needs, into the book's currency
 * (D-98: Financify's daily rates, and the past days filled in), as a lookup.
 */
export async function bookRates(book: Pick<BookView, "currency">, needs: ReadonlyArray<{ currency: string; day: string }>): Promise<(currency: string, day: string) => BookRate | null> {
  const foreign = needs.filter((n) => n.currency && n.currency !== book.currency);
  if (!foreign.length) return () => null;
  const days = foreign.map((n) => n.day).sort();
  const from = new Date(Date.parse(`${days[0]}T00:00:00Z`) - RATE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await prisma.fxRate.findMany({
    where: { base: book.currency, currency: { in: [...new Set(foreign.map((n) => n.currency))] }, day: { gte: from, lte: days.at(-1)! } },
    select: { currency: true, day: true, rate: true, source: true },
  });
  return (currency, day) => pickRate(rows, currency, day);
}
