import type { Prisma } from "@prisma/client";

import { prisma } from "../../db.server";
import { BooksError, cancelDocument, discardDraft, toDbDate, type BookView } from "../../books/books.server";
import { todayIn } from "../../books/dates";
import { addDays, isIsoDate } from "../../books/posting";
import { getConnector } from "./runs.server";

/**
 * Bring sales in again from a date (Books v1.1 V3, D-100), ported from
 * Financify's rebuildShopifySales: each day saved from then on is cancelled
 * (its mirror entry, so nothing is lost from the record), drafts are thrown
 * away, those days' parcel events are cleared, and the import starts again
 * from the date with today's settings and data. Days before it stay as they
 * are; nothing inside a closed month is touched.
 *
 * Growzar: one store or all (entries carry the store), and the days are
 * chosen by the day in each entry's reference (`<store>:<day>[:c<n>]`), not
 * its date: a correction for an earlier day can be dated later (its month was
 * closed, D-84), and must stay. The worker picks the connector up within half
 * an hour and keeps going until it's caught up (schedule.server.ts).
 */

const SOURCE = "shopify_sales";
const PARCEL_KINDS = ["returned", "reinstated", "adjusted", "held", "released"];

const refDay = (ref: string | null) => (ref ?? "").split(":")[1] ?? "";
const refStore = (ref: string | null) => (ref ?? "").split(":")[0] ?? "";

async function inScope(book: BookView, from: string, storeId: string | null) {
  const docs = await prisma.bkDocument.findMany({
    where: { bookId: book.id, source: SOURCE, status: { in: ["draft", "posted"] }, NOT: { sourceRef: { contains: "~" } }, ...(storeId ? { storeId } : {}) },
    select: { id: true, status: true, sourceRef: true },
  });
  return docs.filter((d) => refDay(d.sourceRef) >= from && (!storeId || refStore(d.sourceRef) === storeId));
}

/** Checks, and what bringing in again would cancel: the screen shows it before anything changes. */
export async function rebuildPreview(book: BookView, input: { from: string; storeId: string | null }) {
  if (!isIsoDate(input.from)) throw new BooksError("Choose the day to bring sales in again from", "rebuildFrom");
  const yesterday = addDays(todayIn(book.settings.timeZone), -1);
  if (input.from > yesterday) throw new BooksError("Choose a day before today", "rebuildFrom");
  if (book.lockedThrough && input.from <= book.lockedThrough) throw new BooksError(`Your books are closed up to ${book.lockedThrough}. Choose a later day, or reopen that period first.`, "rebuildFrom");
  const c = await getConnector(book, "shopify_sales");
  if (!c.exists || !c.enabled) throw new BooksError("Turn sales on first");
  if (c.startDate && input.from < c.startDate) throw new BooksError(`Sales come in from ${c.startDate}. To start earlier, change "Bring in sales from" instead.`, "rebuildFrom");
  if (input.storeId && !(book.settings.storeIds ?? []).includes(input.storeId)) throw new BooksError("That store isn't in these books", "rebuildStore");
  const docs = await inScope(book, input.from, input.storeId);
  return { days: docs.filter((d) => d.status === "posted" && !/:c\d+$/.test(d.sourceRef ?? "")).length, entries: docs.filter((d) => d.status === "posted").length, drafts: docs.filter((d) => d.status === "draft").length };
}

export async function rebuildSales(book: BookView, input: { from: string; storeId: string | null }, actor: string | null): Promise<{ cancelled: number; discarded: number }> {
  await rebuildPreview(book, input);
  // Hold the connector's run lock while the days are cleared, so no run writes in between.
  const locked = await prisma.$queryRaw<Array<{ id: string; startDate: Date | null; settings: Prisma.JsonValue }>>`
    UPDATE bk_connectors SET "runningSince" = now()
     WHERE "bookId" = ${book.id} AND key = ${SOURCE}
       AND ("runningSince" IS NULL OR "runningSince" < now() - interval '15 minutes')
     RETURNING id, "startDate", settings`;
  const row = locked[0];
  if (!row) throw new BooksError("Sales are being brought in right now. Try again once that's finished.");
  let cancelled = 0;
  let discarded = 0;
  try {
    const stores = input.storeId ? [input.storeId] : (book.settings.storeIds ?? []);
    const docs = await inScope(book, input.from, input.storeId);
    for (const d of docs.sort((a, b) => refDay(b.sourceRef).localeCompare(refDay(a.sourceRef)))) {
      if (d.status === "draft") {
        await discardDraft(book, d.id, actor);
        discarded++;
      } else {
        await cancelDocument(book, d.id, `Sales brought in again from ${input.from}`, actor);
        cancelled++;
      }
    }
    // Cancelled days give up their reference (one document per source item), so the new ones can take it.
    const stamp = Date.now().toString(36);
    const old = await prisma.bkDocument.findMany({ where: { bookId: book.id, source: SOURCE, status: "cancelled", NOT: { sourceRef: { contains: "~" } } }, select: { id: true, sourceRef: true } });
    for (const d of old) {
      if (refDay(d.sourceRef) >= input.from && stores.includes(refStore(d.sourceRef))) await prisma.bkDocument.update({ where: { id: d.id }, data: { sourceRef: `${d.sourceRef}~${stamp}` } });
    }
    const start = row.startDate ? row.startDate.toISOString().slice(0, 10) : input.from;
    const settings = (row.settings ?? {}) as { progress?: Record<string, string> };
    const progress = { ...(settings.progress ?? {}) };
    for (const s of stores) {
      if (input.from > start) progress[s] = addDays(input.from, -1);
      else delete progress[s];
    }
    // Synced through the earliest store's day; none while a store starts over from the beginning.
    const each = (book.settings.storeIds ?? []).map((s) => progress[s]);
    const synced = each.length && each.every(Boolean) ? (each as string[]).sort()[0]! : null;
    await prisma.$transaction([
      prisma.bkParcelEvent.deleteMany({ where: { bookId: book.id, storeId: { in: stores }, day: { gte: toDbDate(input.from) }, kind: { in: PARCEL_KINDS } } }),
      // "Nothing to take back" notes are looked at afresh: how an order is paid may read differently now.
      prisma.bkParcelEvent.deleteMany({ where: { bookId: book.id, storeId: { in: stores }, kind: "skip" } }),
      prisma.bkConnector.update({
        where: { id: row.id },
        data: { settings: { ...settings, progress } as Prisma.InputJsonValue, syncedThrough: synced ? toDbDate(synced) : null, lastRunAt: null },
      }),
      prisma.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "connector.rebuilt", detail: { key: SOURCE, from: input.from, storeId: input.storeId, cancelled, discarded } } }),
    ]);
  } finally {
    await prisma.bkConnector.update({ where: { id: row.id }, data: { runningSince: null } }).catch(() => undefined);
  }
  return { cancelled, discarded };
}
