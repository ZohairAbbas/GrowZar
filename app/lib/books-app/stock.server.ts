import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { BooksError, listAccounts, saveDraft, toDbDate, type BookView } from "../books/books.server";
import { decimalToMinor, type SalesMapping } from "../books/connectors/shopify-sales";
import { isIsoDate } from "../books/posting";
import { stockNotYetIn } from "./connectors/sales.server";

/**
 * The stock check (Books v1.1 V4, D-97), ported from Financify's: what the
 * books say a store's stock is worth, against Inventorify's stock available
 * now at its cost per item. The difference becomes a stock adjustment, always
 * a draft first: nothing changes in the books until the owner saves it from
 * To approve (D-97). A count typed in by hand works the same way, for any day.
 * The difference goes to cost of what you sold, stock lost or damaged, or (a
 * first count with no opening stock yet) the opening balance.
 *
 * Why "available": it drops when an order is placed, the moment Books takes
 * the cost for an order it counts then. Days the sales connector hasn't
 * brought in yet, and its drafts, are worked out by its own rules
 * (stockNotYetIn); cash-on-delivery orders held off the books until delivered
 * keep their cost in Books' stock while Inventorify has them committed, so
 * their cost is taken off too ("held").
 *
 * Books keeps one Stock account with the store on each line. A store is
 * checked against its own lines; stock not tied to a store (opening stock,
 * usually) is shown apart, unless the book has one store.
 */

const FRESH_MS = 30 * 60 * 1000;

export type StockItem = { variantId: string; name: string; sku: string | null; units: number; unitCost: bigint | null; value: bigint; state: "valued" | "no_cost" | "oversold" | "none" };

export type StockSnapshot = {
  at: string;
  storeId: string;
  /** Σ available units × Inventorify's cost per item (items with a cost, not oversold). */
  counted: string;
  /** The store's lines on Stock when the check ran (and lines with no store, for a one-store book). */
  booksValue: string;
  /** What sales will still move on Stock: days not brought in yet and drafts, less COD orders held back. */
  pending: string;
  held: string;
  /** Stock lines not tied to a store, left out of a store's check in a book with several stores. */
  notTied: string;
  items: number;
  itemsNoCost: number;
  unitsNoCost: number;
  oversoldUnits: number;
  /** Variants whose cost is in another currency than the book's: left out. */
  otherCurrency: number;
};

/** Inventorify's variants for a store with their available units (active locations) and cost. */
export async function inventorifyStock(book: Pick<BookView, "currency" | "decimals">, storeId: string): Promise<{ items: StockItem[]; otherCurrency: number }> {
  const [variants, levels] = await Promise.all([
    prisma.rawRecord.findMany({ where: { storeId, app: "INVENTORIFY", entity: "INVENTORY_VARIANT", deletedAt: null }, select: { payload: true } }),
    prisma.rawRecord.findMany({ where: { storeId, app: "INVENTORIFY", entity: "STOCK_LEVEL", deletedAt: null }, select: { payload: true } }),
  ]);
  const available = new Map<string, number>();
  for (const l of levels) {
    const p = l.payload as { variantId?: unknown; available?: unknown; locationActive?: unknown };
    if (p.variantId == null || p.locationActive === false || typeof p.available !== "number") continue;
    available.set(String(p.variantId), (available.get(String(p.variantId)) ?? 0) + p.available);
  }
  let otherCurrency = 0;
  const items: StockItem[] = [];
  for (const v of variants) {
    const p = v.payload as { variantId?: unknown; title?: unknown; variantTitle?: unknown; sku?: unknown; unitCost?: { amount?: unknown; currency?: unknown } | null };
    if (p.variantId == null) continue;
    const id = String(p.variantId);
    const units = available.get(id) ?? 0;
    const cur = typeof p.unitCost?.currency === "string" ? p.unitCost.currency : book.currency;
    if (cur !== book.currency) {
      otherCurrency++;
      continue;
    }
    const raw = p.unitCost?.amount;
    const unitCost = raw == null || raw === "" || Number(raw) <= 0 ? null : decimalToMinor(String(raw), book.decimals);
    const title = String(p.title ?? "").trim();
    const variantTitle = String(p.variantTitle ?? "").trim();
    const name = (title ? (variantTitle && variantTitle !== "Default Title" ? `${title} — ${variantTitle}` : title) : "") || `Variant ${id}`;
    const sku = typeof p.sku === "string" && p.sku.trim() ? p.sku.trim() : null;
    const state: StockItem["state"] = units < 0 ? "oversold" : unitCost === null ? "no_cost" : units === 0 ? "none" : "valued";
    items.push({ variantId: id, name, sku, units, unitCost, value: state === "valued" ? unitCost! * BigInt(units) : 0n, state });
  }
  return { items: items.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : a.name.localeCompare(b.name))), otherCurrency };
}

async function stockAccountId(book: BookView): Promise<string> {
  const a = (await listAccounts(book)).find((x) => x.systemKey === "stock");
  if (!a) throw new BooksError("This book has no Stock account");
  return a.id;
}

/** The store's lines on Stock, up to a day (or all), and those with no store. */
async function booksStock(book: BookView, stockId: string, storeId: string, to?: string) {
  const date = to ? { date: { lte: toDbDate(to) } } : {};
  const [own, none] = await Promise.all([
    prisma.bkEntryLine.aggregate({ where: { bookId: book.id, accountId: stockId, storeId, ...date }, _sum: { amount: true } }),
    prisma.bkEntryLine.aggregate({ where: { bookId: book.id, accountId: stockId, storeId: null, ...date }, _sum: { amount: true } }),
  ]);
  const single = (book.settings.storeIds ?? []).length === 1;
  const notTied = none._sum.amount ?? 0n;
  return { books: (own._sum.amount ?? 0n) + (single ? notTied : 0n), notTied: single ? 0n : notTied };
}

/** Cost of COD orders held off the books (saved days): back in Books' stock, committed in Inventorify. */
async function heldCost(book: BookView, storeId: string, mapping: SalesMapping | undefined): Promise<bigint> {
  if (!mapping?.held || !mapping.stock) return 0n;
  const ev = await prisma.bkParcelEvent.findMany({ where: { bookId: book.id, storeId, kind: { in: ["held", "released", "adjusted"] }, document: { status: "posted" } }, select: { orderId: true, lines: true } });
  const by = new Map<string, Record<string, bigint>>();
  for (const e of ev) {
    const t = by.get(e.orderId) ?? {};
    for (const [k, v] of Object.entries(e.lines as Record<string, string>)) t[k] = (t[k] ?? 0n) + BigInt(v);
    by.set(e.orderId, t);
  }
  let held = 0n;
  for (const t of by.values()) if ((t[mapping.held] ?? 0n) !== 0n) held += t[mapping.stock] ?? 0n;
  return held;
}

/** Check a store against Inventorify now, and keep the result for the adjustment. */
export async function checkStock(book: BookView, storeId: string, now = new Date()): Promise<StockSnapshot> {
  if (!(book.settings.storeIds ?? []).includes(storeId)) throw new BooksError("That store isn't in these books");
  const connected = await prisma.appConnection.findFirst({ where: { storeId, app: "INVENTORIFY", status: "CONNECTED" } });
  if (!connected) throw new BooksError("Inventorify isn't connected for this store. Count the stock and enter its value instead.");
  const stockId = await stockAccountId(book);
  const sales = await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId: book.id, key: "shopify_sales" } }, select: { settings: true } });
  const mapping = (sales?.settings as { mapping?: SalesMapping } | null)?.mapping;
  const [{ items, otherCurrency }, stock, notYet, held] = await Promise.all([inventorifyStock(book, storeId), booksStock(book, stockId, storeId), stockNotYetIn(book, storeId), heldCost(book, storeId, mapping)]);
  const pending = (notYet ? notYet.notYetIn + notYet.drafts : 0n) - held;
  const snap: StockSnapshot = {
    at: now.toISOString(),
    storeId,
    counted: items.reduce((t, i) => t + i.value, 0n).toString(),
    booksValue: stock.books.toString(),
    pending: pending.toString(),
    held: held.toString(),
    notTied: stock.notTied.toString(),
    items: items.length,
    itemsNoCost: items.filter((i) => i.state === "no_cost" && i.units > 0).length,
    unitsNoCost: items.filter((i) => i.state === "no_cost" && i.units > 0).reduce((t, i) => t + i.units, 0),
    oversoldUnits: items.filter((i) => i.state === "oversold").reduce((t, i) => t + i.units, 0),
    otherCurrency,
  };
  const c = await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId: book.id, key: "stock_check" } } });
  const snapshots = { ...(((c?.settings ?? {}) as { snapshots?: Record<string, StockSnapshot> }).snapshots ?? {}), [storeId]: snap };
  await prisma.bkConnector.upsert({
    where: { bookId_key: { bookId: book.id, key: "stock_check" } },
    create: { bookId: book.id, key: "stock_check", enabled: true, settings: { snapshots } as unknown as Prisma.InputJsonValue },
    update: { settings: { ...((c?.settings ?? {}) as object), snapshots } as unknown as Prisma.InputJsonValue, lastRunAt: now },
  });
  return snap;
}

export async function lastChecks(book: BookView): Promise<Record<string, StockSnapshot>> {
  const c = await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId: book.id, key: "stock_check" } }, select: { settings: true } });
  return ((c?.settings ?? {}) as { snapshots?: Record<string, StockSnapshot> }).snapshots ?? {};
}

/**
 * Where a stock difference can go (Financify's choices): cost of what you
 * sold (the default), stock lost or damaged, or, for the first count of a
 * book with no opening stock yet, the opening balance: stock you already had
 * on your first day isn't a cost.
 */
export async function stockCounters(book: BookView) {
  const accounts = await listAccounts(book);
  const stock = accounts.find((a) => a.systemKey === "stock");
  const counted = stock
    ? await prisma.bkEntryLine.count({ where: { bookId: book.id, accountId: stock.id, entry: { kind: "post", document: { status: "posted", type: { in: ["opening", "stock_adjustment"] } } } } })
    : 0;
  const pick = (f: (a: (typeof accounts)[number]) => boolean) => accounts.find((a) => !a.archived && f(a));
  const cogs = pick((a) => a.systemKey === "cogs");
  const loss = pick((a) => a.code === "6100" || /^stock lost/i.test(a.name));
  const opening = pick((a) => a.systemKey === "opening_balance");
  const choices = [
    cogs && { id: cogs.id, label: "Cost of what you sold" },
    loss && { id: loss.id, label: loss.name },
    opening && { id: opening.id, label: "Opening balance (first count)" },
  ].filter((x): x is { id: string; label: string } => !!x);
  const firstCount = counted === 0;
  return { choices, firstCount, openingId: opening?.id ?? null, defaultId: (firstCount ? opening?.id : cogs?.id) ?? choices[0]?.id ?? null };
}

/** The change the books need: what was counted, less what the books will hold once sales catch up. */
export const proposedChange = (s: Pick<StockSnapshot, "counted" | "booksValue" | "pending">) => BigInt(s.counted) - (BigInt(s.booksValue) + BigInt(s.pending));

/**
 * Prepare the stock adjustment as a draft (D-97): from the store's last
 * Inventorify check (fresh, and nothing on Stock saved since), or from a
 * count typed in for a day (sales for that day all in the books).
 */
export async function prepareStockAdjustment(
  book: BookView,
  input: { storeId: string; method: "inventorify" | "count"; counted?: string; date?: string; counter?: string | null },
  today: string,
  actor: string | null,
): Promise<{ id: string; waiting: boolean }> {
  if (!(book.settings.storeIds ?? []).includes(input.storeId)) throw new BooksError("That store isn't in these books");
  // One adjustment at a time: a second draft would double the correction once both are saved.
  const waiting = await prisma.bkDocument.findFirst({ where: { bookId: book.id, type: "stock_adjustment", status: "draft" } });
  if (waiting) return { id: waiting.id, waiting: true };
  const accounts = await listAccounts(book);
  const stockId = accounts.find((a) => a.systemKey === "stock")?.id;
  if (!stockId) throw new BooksError("This book has no Stock account");
  const counters = await stockCounters(book);
  const counter = input.counter ? counters.choices.find((c) => c.id === input.counter)?.id : counters.defaultId;
  if (!counter) throw new BooksError("Choose where the difference goes", "counter");
  let date = today;
  let counted: bigint;
  let books: bigint;
  let pending = 0n;
  if (input.method === "inventorify") {
    const snap = (await lastChecks(book))[input.storeId];
    if (!snap) throw new BooksError("Check Inventorify first");
    if (Date.now() - Date.parse(snap.at) > FRESH_MS) throw new BooksError("This check is more than 30 minutes old. Check again so the figures are current.");
    // The books as they were at the check: if Stock moved since (a sales day saved, a bill), check again.
    const moved = await prisma.bkEntryLine.count({ where: { bookId: book.id, accountId: stockId, entry: { createdAt: { gt: new Date(snap.at) } } } });
    if (moved > 0) throw new BooksError("Stock in the books changed since the check (something was saved). Check again so the figures line up.");
    counted = BigInt(snap.counted);
    books = BigInt(snap.booksValue);
    pending = BigInt(snap.pending);
  } else {
    date = input.date ?? "";
    if (!isIsoDate(date)) throw new BooksError("Choose the day you counted", "date");
    if (date > today) throw new BooksError("The count can't be in the future", "date");
    if (!/^-?\d+$/.test(input.counted ?? "")) throw new BooksError("Enter what the stock was worth", "counted");
    counted = BigInt(input.counted!);
    // A count only lines up with books that hold every sale up to that day.
    const sales = await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId: book.id, key: "shopify_sales" } }, select: { enabled: true, settings: true } });
    const s = (sales?.settings ?? {}) as { mapping?: SalesMapping; progress?: Record<string, string> };
    if (sales?.enabled && s.mapping?.cogs) {
      const through = s.progress?.[input.storeId];
      if (!through || through < date) throw new BooksError(`Sales up to ${date} aren't all in your books yet${through ? ` (brought in up to ${through})` : ""}. Use an earlier count day, or wait for that day to come in.`, "date");
      const drafts = await prisma.bkDocument.count({ where: { bookId: book.id, source: "shopify_sales", storeId: input.storeId, status: "draft", date: { lte: toDbDate(date) } } });
      if (drafts > 0) throw new BooksError(`${drafts} day${drafts === 1 ? "" : "s"} of sales up to ${date} ${drafts === 1 ? "is" : "are"} still a draft. Save ${drafts === 1 ? "it" : "them"} first so the count lines up.`, "date");
    }
    books = (await booksStock(book, stockId, input.storeId, date)).books;
  }
  const change = counted - (books + pending);
  if (change === 0n) throw new BooksError("Stock already matches; there's nothing to adjust");
  const doc = await saveDraft(
    book,
    {
      type: "stock_adjustment",
      date,
      storeId: input.storeId,
      memo: input.method === "inventorify" ? "Stock brought in line with Inventorify" : "Stock brought in line with a count",
      data: { stock: stockId, counter, amount: change.toString(), method: input.method, countedValue: counted.toString(), booksValue: books.toString(), pendingValue: pending.toString() },
    },
    actor,
  );
  return { id: doc.id, waiting: false };
}
