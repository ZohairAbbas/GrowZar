import { prisma } from "../db.server";
import { foreignBalances, fxGainsAccount, getBook, ledgerSums, postDocument, upsertImported, type BookView } from "../books/books.server";
import { todayIn } from "../books/dates";
import { formatFxRate, parseFxRate, toBookAmount } from "../books/fx";
import { monthEndsDue } from "./fx";
import { bookRates } from "./fx.server";
import { booksOn } from "./switch.server";

/**
 * Month-end revaluation of foreign-currency accounts (v1.1 V1, D-99), ported
 * from Financify's fx.server.ts: on each month's last day, an account kept in
 * another currency (a USD card, an AED wallet) is set to its foreign balance
 * at that day's stored rate, the difference going to "Exchange gains and
 * losses". Each revaluation adjusts only what's left, so nothing counts twice
 * and none is reversed. Once the foreign balance is settled to zero, that
 * month's revaluation clears what remains: the realised gain or loss.
 *
 * Automatic, one entry per account and month (`fx_revaluation:<account>:<day>`),
 * never inside a closed month, and only for months already over.
 */

const SOURCE = "fx_revaluation";
/** A stored rate (up to 12 decimals) as the engine takes it (8). */
const engineRate = (rate: string) => {
  const [w, f = ""] = rate.split(".");
  return f ? `${w}.${f.slice(0, 8)}` : w!;
};

export async function revalueDue(book: BookView, now = new Date()): Promise<{ posted: number; notes: string[] }> {
  const accounts = await prisma.bkAccount.findMany({ where: { bookId: book.id, currency: { not: null }, archivedAt: null }, select: { id: true, name: true, currency: true } });
  if (!accounts.length || !book.settings.startDate) return { posted: 0, notes: [] };
  const today = todayIn(book.settings.timeZone, now);
  const due = monthEndsDue(book.settings.startDate, today).filter((d) => !book.lockedThrough || d > book.lockedThrough);
  if (!due.length) return { posted: 0, notes: [] };
  const done = new Set((await prisma.bkDocument.findMany({ where: { bookId: book.id, source: SOURCE, status: { not: "cancelled" } }, select: { sourceRef: true } })).map((d) => d.sourceRef));
  const rateOf = await bookRates(book, accounts.flatMap((a) => due.map((day) => ({ currency: a.currency!, day }))));
  const notes: string[] = [];
  let posted = 0;
  let gains: string | null = null;
  for (const a of accounts) {
    for (const day of due) {
      const ref = `${a.id}:${day}`;
      if (done.has(ref)) continue;
      const rate = rateOf(a.currency!, day);
      const scaled = rate ? parseFxRate(engineRate(rate.rate)) : null;
      if (!rate || scaled === null) {
        notes.push(`${a.name}: no ${a.currency} rate for ${day} yet, so it isn't revalued for that month`);
        continue;
      }
      const [fx, sums] = await Promise.all([foreignBalances(book.id, [a.id], day), ledgerSums(book.id, { to: day })]);
      const foreign = fx.get(a.id) ?? 0n;
      const before = sums.get(a.id) ?? 0n;
      const adjustment = toBookAmount(foreign, a.currency!, book.decimals, scaled) - before;
      if (adjustment === 0n) continue;
      gains ??= await fxGainsAccount(book);
      const res = await upsertImported(book, {
        source: SOURCE,
        sourceRef: ref,
        type: "fx_revaluation",
        date: day,
        memo: `${a.name} revalued at ${formatFxRate(scaled)} ${book.currency} per ${a.currency} (${rate.source}${rate.day !== day ? `, rate of ${rate.day}` : ""})`,
        data: { account: a.id, gainsAccount: gains, adjustment: adjustment.toString(), rate: formatFxRate(scaled), foreignBalance: foreign.toString(), bookBalanceBefore: before.toString() },
      });
      if (res.doc.status === "draft") await postDocument(book, res.doc.id, null);
      posted++;
    }
  }
  return { posted, notes };
}

/** Every book with an account in another currency, revalued where due, where Books is on (the worker's Books tick). */
export async function revalueAllBooks(now = new Date()): Promise<number> {
  const books = await prisma.bkBook.findMany({ where: { accounts: { some: { currency: { not: null }, archivedAt: null } } }, select: { organizationId: true } });
  let posted = 0;
  for (const b of books) {
    if (!(await booksOn(b.organizationId))) continue;
    const book = await getBook(b.organizationId);
    if (book) posted += (await revalueDue(book, now)).posted;
  }
  return posted;
}
