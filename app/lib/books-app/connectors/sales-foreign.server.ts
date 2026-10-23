import { prisma } from "../../db.server";
import { fxGainsAccount, type BookView } from "../../books/books.server";
import { isMoneySubtype, nextCode } from "../../books/chart";
import { parseFxRate, toBookAmount } from "../../books/fx";
import { currencyDecimals } from "../../books/money";
import type { DaySummary, ParcelEvent, ParcelLines, SalesMapping } from "../../books/connectors/shopify-sales";
import { addDays } from "../../books/posting";
import { foreignLines, RATE_LOOKBACK_DAYS, type BookRate } from "../fx";
import { bookRates } from "../fx.server";
import { toSums } from "./ad-spend";

/**
 * A store in another currency than its book's (v1.1 V1b, D-99): what it's
 * owed is kept in its own currency, so a payout clears it exactly and the
 * difference from the sale day's rate is an exchange gain or loss, never a
 * remainder stuck in "owed".
 *
 * Sales are summed twice from the same orders: in the book's currency (as
 * every store's are) and in the store's own. The book figures post as
 * always; the "owed" lines move to sub-accounts kept in the store's currency
 * ("Owed by payment gateways (AED)"), each carrying its amount in that
 * currency from the second sum. Each order converts at its own day's rate
 * both ways, so a refund or a return of an older order uses that order's rate.
 */
export type ForeignStore = {
  currency: string;
  decimals: number;
  /** Book "owed" accounts (from the sales mapping) that move to a sub-account kept in the store's currency. */
  candidates: Set<string>;
  /** Those sub-accounts, made the first time a day uses them (ensureOwed). */
  owed: Map<string, string>;
  gains: string;
  /** Book units per one store unit, on a day (or the latest within a week before it). */
  rateOf: (day: string) => BookRate | null;
};

const engineRate = (rate: string) => {
  const [w, f = ""] = rate.split(".");
  return parseFxRate(f ? `${w}.${f.slice(0, 8)}` : w!);
};

/** The sub-account kept in `currency` under a book "owed" account, made the first time it's needed. */
export async function foreignOwedAccount(book: BookView, parentId: string, currency: string): Promise<string> {
  const found = await prisma.bkAccount.findFirst({ where: { bookId: book.id, parentId, currency, archivedAt: null }, select: { id: true } });
  if (found) return found.id;
  const parent = await prisma.bkAccount.findFirstOrThrow({ where: { id: parentId, bookId: book.id } });
  const used = await prisma.bkAccount.findMany({ where: { bookId: book.id }, select: { code: true } });
  return (
    await prisma.bkAccount.create({
      data: { bookId: book.id, code: nextCode(used.map((u) => u.code), Number(parent.code) + 1), name: `${parent.name} (${currency})`, type: parent.type, subtype: parent.subtype, parentId: parent.id, currency },
    })
  ).id;
}

/** The store's foreign context, or null when it's in the book's currency. */
export async function foreignStore(book: BookView, storeCurrency: string | null, mapping: SalesMapping, from: string, to: string): Promise<ForeignStore | null> {
  if (!storeCurrency || storeCurrency === book.currency) return null;
  const mapped = [...new Set([mapping.cod, mapping.prepaid, mapping.selfDelivery, ...Object.values(mapping.gateways ?? {})].filter((x): x is string => !!x))];
  const accounts = await prisma.bkAccount.findMany({ where: { bookId: book.id, id: { in: mapped } }, select: { id: true, type: true, subtype: true, currency: true } });
  // Money accounts and accounts already in a currency keep their own rules; only "owed to you" moves.
  const candidates = new Set(accounts.filter((a) => a.type === "asset" && !isMoneySubtype(a.subtype) && !a.currency).map((a) => a.id));
  const owed = new Map<string, string>();
  for (const sub of await prisma.bkAccount.findMany({ where: { bookId: book.id, parentId: { in: [...candidates] }, currency: storeCurrency, archivedAt: null }, select: { id: true, parentId: true } })) owed.set(sub.parentId!, sub.id);
  const needs: Array<{ currency: string; day: string }> = [];
  for (let d = addDays(from, -RATE_LOOKBACK_DAYS); d <= to; d = addDays(d, 1)) needs.push({ currency: storeCurrency, day: d });
  const lookup = await bookRates(book, needs);
  return { currency: storeCurrency, decimals: currencyDecimals(storeCurrency), candidates, owed, gains: await fxGainsAccount(book), rateOf: (day) => lookup(storeCurrency, day) };
}

/** The sub-accounts a day's lines need, made where missing. */
export async function ensureOwed(book: BookView, f: ForeignStore, accountIds: Iterable<string>): Promise<void> {
  for (const id of accountIds) if (f.candidates.has(id) && !f.owed.has(id)) f.owed.set(id, await foreignOwedAccount(book, id, f.currency));
}

/** A book amount (minor units) in the store's currency at a rate, half away from zero. */
function toStore(bookMinor: bigint, bookDecimals: number, f: ForeignStore, rate: string): bigint | null {
  const r = engineRate(rate);
  if (r === null) return null;
  const num = bookMinor * 10n ** BigInt(f.decimals) * 100_000_000n;
  const den = r * 10n ** BigInt(bookDecimals);
  const neg = (num < 0n) !== (den < 0n);
  const [x, y] = [num < 0n ? -num : num, den < 0n ? -den : den];
  const q = (2n * x + y) / (2n * y);
  return neg ? -q : q;
}

/**
 * Parcel events (book currency, as they're saved) in the store's currency,
 * each at its order's own day's rate. Null when an order's rate is missing.
 */
export function shadowEvents(events: readonly ParcelEvent[], bookDecimals: number, f: ForeignStore, orderDay: (orderId: string) => string | null): ParcelEvent[] | null {
  const out: ParcelEvent[] = [];
  for (const e of events) {
    const day = orderDay(e.orderId) ?? e.day;
    const rate = f.rateOf(day);
    if (!rate) return null;
    const lines: ParcelLines = {};
    for (const [acc, v] of Object.entries(e.lines)) {
      const x = toStore(BigInt(v), bookDecimals, f, rate.rate);
      if (x === null) return null;
      lines[acc] = x.toString();
    }
    out.push({ ...e, lines });
  }
  return out;
}

/**
 * One day's posting for the store: the book-currency summary with its "owed"
 * lines on the sub-accounts kept in the store's currency, each carrying its
 * amount from the store-currency summary of the same day.
 */
export function foreignDay(book: Pick<BookView, "decimals">, f: ForeignStore, day: string, inBook: Pick<DaySummary, "debits" | "credits"> | null, inStore: Pick<DaySummary, "debits" | "credits"> | null) {
  const sums = toSums(inBook);
  const own = toSums(inStore);
  const moved = new Map<string, bigint>();
  const foreign = new Map<string, bigint>();
  for (const [id, v] of sums) {
    const to = f.owed.get(id);
    moved.set(to ?? id, (moved.get(to ?? id) ?? 0n) + v);
  }
  for (const [id, sub] of f.owed) foreign.set(sub, own.get(id) ?? 0n);
  const rate = f.rateOf(day);
  const scaled = rate ? engineRate(rate.rate) : null;
  const toBook = (foreignMinor: bigint) => (scaled === null ? 0n : toBookAmount(foreignMinor, f.currency, book.decimals, scaled));
  const out = foreignLines(moved, foreign, toBook, f.gains);
  // The foreign amounts as signed sums (the ledger's sign), for comparing with what's booked.
  const fxSigned = new Map(Object.entries(out.fx).map(([id, a]) => [id, (out.sums.get(id) ?? 0n) < 0n ? -BigInt(a.amount) : BigInt(a.amount)]));
  return { ...out, fxSigned };
}
