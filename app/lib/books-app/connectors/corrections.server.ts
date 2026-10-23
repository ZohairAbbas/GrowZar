import { prisma } from "../../db.server";
import { discardDraft, postDocument, upsertImported, type BookView } from "../../books/books.server";
import { correctionDate, difference } from "./ad-spend";
import type { RunResult } from "./runs.server";
import { foreignLines } from "../fx";

/**
 * A late change to something already saved (pack §1 rule 3): the saved entry
 * is never edited; the difference between what the source says now and what
 * the ledger holds for that item posts as a correction journal,
 * `<sourceRef>:c<n>`, dated on the item's day while it's open, else on the day
 * the change is seen (D-84's rule, used for every connector).
 *
 * "What the ledger holds" is read from the ledger itself: every entry line of
 * the item and its corrections, cancels included, so a cancelled correction
 * counts as nothing. A correction the merchant cancelled for exactly this
 * difference isn't raised again.
 */
export async function postDifference(
  book: BookView,
  item: {
    source: string;
    base: string;
    day: string;
    today: string;
    current: Map<string, bigint>;
    memo: string;
    storeId: string | null;
    contactName?: string | null;
    mode: string;
    /** v1.1 V1b: a store in another currency's "owed" accounts, kept in that currency: their foreign sums now, valued at the day's rate where needed. */
    foreign?: { current: Map<string, bigint>; toBook: (foreignMinor: bigint, accountId: string) => bigint; gains: string };
  },
  r: RunResult,
): Promise<void> {
  const docs = await prisma.bkDocument.findMany({
    where: { bookId: book.id, source: item.source, OR: [{ sourceRef: item.base }, { sourceRef: { startsWith: `${item.base}:c` } }], NOT: { sourceRef: { contains: "~" } } },
    select: { id: true, sourceRef: true, status: true },
  });
  const lines = await prisma.bkEntryLine.findMany({ where: { entry: { documentId: { in: docs.map((d) => d.id) } } }, select: { accountId: true, amount: true, fxAmount: true, entry: { select: { documentId: true, kind: true } } } });
  const booked = new Map<string, bigint>();
  const bookedFx = new Map<string, bigint>();
  for (const l of lines) {
    booked.set(l.accountId, (booked.get(l.accountId) ?? 0n) + l.amount);
    if (l.fxAmount !== null) bookedFx.set(l.accountId, (bookedFx.get(l.accountId) ?? 0n) + l.fxAmount);
  }
  let delta = difference(item.current, [booked]);
  let fx: Record<string, { amount: string }> | undefined;
  if (item.foreign) {
    const fxDelta = new Map<string, bigint>();
    for (const id of new Set([...item.foreign.current.keys(), ...bookedFx.keys()])) fxDelta.set(id, (item.foreign.current.get(id) ?? 0n) - (bookedFx.get(id) ?? 0n));
    const f = foreignLines(delta, fxDelta, item.foreign.toBook, item.foreign.gains);
    delta = f.sums;
    fx = f.fx;
  }
  const corrections = docs.filter((d) => d.sourceRef !== item.base);
  const draft = corrections.find((d) => d.status === "draft");
  if (delta.size === 0) {
    if (draft) await discardDraft(book, draft.id, null);
    return;
  }
  const declined = corrections
    .filter((d) => d.status === "cancelled")
    .some((d) => {
      const own = new Map<string, bigint>();
      for (const l of lines) if (l.entry.documentId === d.id && l.entry.kind === "post") own.set(l.accountId, (own.get(l.accountId) ?? 0n) + l.amount);
      return difference(delta, [own]).size === 0;
    });
  if (declined) {
    r.skipped++;
    return;
  }
  const ref = draft?.sourceRef ?? `${item.base}:c${corrections.filter((d) => d.status !== "draft").length + 1}`;
  const res = await upsertImported(book, {
    source: item.source,
    sourceRef: ref,
    type: "manual",
    date: correctionDate(item.day, book.lockedThrough, item.today),
    data: { lines: [...delta].sort(([a], [b]) => a.localeCompare(b)).map(([accountId, v]) => (v > 0n ? { accountId, debit: v.toString() } : { accountId, credit: (-v).toString() })), ...(fx && Object.keys(fx).length ? { fx } : {}) },
    memo: item.memo,
    contactName: item.contactName ?? null,
    contactKind: "courier",
    storeId: item.storeId,
  });
  if (res.action === "created") r.created++;
  else if (res.action === "updated") r.updated++;
  if (item.mode === "auto" && res.doc.status === "draft") {
    try {
      await postDocument(book, res.doc.id, null);
    } catch (e) {
      r.status = "partial";
      r.notes.push(`${item.memo}: kept as a draft — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
