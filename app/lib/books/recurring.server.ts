/**
 * Recurring entries: rent, salaries, subscriptions. A rule holds an entry's
 * contents and a schedule; each due date becomes a draft (or is saved
 * straight to the books). Making an occurrence is idempotent — source
 * "recurring", sourceRef "<rule>:<date>" — so the scheduler and a page load
 * running at once can't make it twice.
 *
 * Growzar (v1.1 V6): ported from Financify's Books (0cc8732). A rule keeps the
 * store of the entry it was made from (D-65); the book is found by its
 * organization, and the worker runs only books whose organization has Books
 * on. Drafts are the default (D-101).
 */

import { Prisma, type BkRecurring } from "@prisma/client";
import { prisma } from "~/lib/db.server";
import { checkPosting, fromDbDate, getBook, postDocument, toDbDate, upsertImported, type BookView } from "./books.server";
import { todayIn } from "./dates";
import { BooksError, DOC_LABELS, addDays, isIsoDate, type DocType } from "./posting";
import { FREQUENCIES, RECURRING_TYPES, describeSchedule, dueOccurrences, occurrenceOnOrAfter, type Frequency, type Schedule } from "./recurring";

export interface ScheduleInput {
  name: string;
  frequency: string;
  interval: number;
  dayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
  mode: string;
}

function cleanSchedule(input: ScheduleInput): ScheduleInput & { frequency: Frequency; mode: "draft" | "auto" } {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw new BooksError("Give it a name, like “Office rent”", "name");
  if (name.length > 120) throw new BooksError("That name is too long", "name");
  if (!FREQUENCIES.some((f) => f.value === input.frequency)) throw new BooksError("Choose how often", "frequency");
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 12) throw new BooksError("Choose every 1 to 12", "interval");
  if (input.frequency === "weekly" ? input.dayOfMonth !== null : input.dayOfMonth !== null && !(Number.isInteger(input.dayOfMonth) && input.dayOfMonth >= 1 && input.dayOfMonth <= 31)) {
    throw new BooksError("Choose a day of the month", "dayOfMonth");
  }
  if (!isIsoDate(input.startDate)) throw new BooksError("Choose when it starts", "startDate");
  if (input.endDate !== null && (!isIsoDate(input.endDate) || input.endDate < input.startDate)) throw new BooksError("The end date must be after the start", "endDate");
  if (input.mode !== "draft" && input.mode !== "auto") throw new BooksError("Choose drafts or saving automatically", "mode");
  return { ...input, name, frequency: input.frequency as Frequency, mode: input.mode };
}

const scheduleOf = (r: Pick<BkRecurring, "frequency" | "interval" | "dayOfMonth" | "startDate" | "endDate">): Schedule => ({
  frequency: r.frequency as Frequency,
  interval: r.interval,
  dayOfMonth: r.dayOfMonth,
  startDate: fromDbDate(r.startDate)!,
  endDate: fromDbDate(r.endDate),
});

/** Make an entry repeat: its contents become the rule's template. */
export async function createRecurringFromDocument(book: BookView, documentId: string, input: ScheduleInput, actor: string | null) {
  const doc = await prisma.bkDocument.findFirst({ where: { id: documentId, bookId: book.id } });
  if (!doc) throw new BooksError("That entry doesn't exist");
  if (!(RECURRING_TYPES as readonly string[]).includes(doc.type)) throw new BooksError(`A ${DOC_LABELS[doc.type as DocType]?.toLowerCase() ?? "entry"} can't repeat`);
  const s = cleanSchedule(input);
  const data = (doc.data ?? {}) as Record<string, unknown>;
  const docDate = fromDbDate(doc.date)!;
  const dueDays = typeof data.dueDate === "string" && isIsoDate(data.dueDate) ? Math.max(0, Math.round((Date.parse(data.dueDate) - Date.parse(docDate)) / 86400000)) : null;
  // The template must post as it stands (accounts not archived, contact present…).
  await checkPosting(book, doc.type as DocType, data, doc.contactId);
  const schedule: Schedule = { frequency: s.frequency, interval: s.interval, dayOfMonth: s.frequency === "weekly" ? null : s.dayOfMonth, startDate: s.startDate, endDate: s.endDate };
  const next = occurrenceOnOrAfter(schedule, s.startDate);
  if (!next) throw new BooksError("That schedule has no dates before it ends", "endDate");
  return prisma.$transaction(async (tx) => {
    const r = await tx.bkRecurring.create({
      data: {
        bookId: book.id,
        name: s.name,
        type: doc.type,
        contactId: doc.contactId,
        memo: doc.memo,
        data: data as Prisma.InputJsonValue,
        storeId: doc.storeId,
        dueDays,
        frequency: s.frequency,
        interval: s.interval,
        dayOfMonth: schedule.dayOfMonth,
        startDate: toDbDate(s.startDate),
        endDate: s.endDate ? toDbDate(s.endDate) : null,
        nextDate: toDbDate(next),
        mode: s.mode,
        createdBy: actor,
      },
    });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "recurring.created", documentId: doc.id, detail: { recurringId: r.id, name: s.name, schedule: describeSchedule(schedule) } } });
    return r;
  });
}

/** Change the name, schedule or mode. The next date is worked out again from today. */
export async function updateRecurring(book: BookView, id: string, input: ScheduleInput, today: string, actor: string | null) {
  const s = cleanSchedule(input);
  const r = await prisma.bkRecurring.findFirst({ where: { id, bookId: book.id } });
  if (!r) throw new BooksError("Not found");
  const schedule: Schedule = { frequency: s.frequency, interval: s.interval, dayOfMonth: s.frequency === "weekly" ? null : s.dayOfMonth, startDate: s.startDate, endDate: s.endDate };
  // Carry on from where it had got to: dates before its next date were already made
  // (or skipped while paused); a finished rule that's extended carries on from tomorrow.
  const later = (a: string, b: string) => (a > b ? a : b);
  const nextBefore = fromDbDate(r.nextDate);
  const from = nextBefore ? later(nextBefore, s.startDate) : r.lastRunAt ? later(addDays(today, 1), s.startDate) : s.startDate;
  const next = occurrenceOnOrAfter(schedule, from);
  await prisma.$transaction(async (tx) => {
    await tx.bkRecurring.update({
      where: { id },
      data: { name: s.name, frequency: s.frequency, interval: s.interval, dayOfMonth: schedule.dayOfMonth, startDate: toDbDate(s.startDate), endDate: s.endDate ? toDbDate(s.endDate) : null, mode: s.mode, nextDate: next ? toDbDate(next) : null },
    });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "recurring.updated", detail: { recurringId: id, name: s.name, schedule: describeSchedule(schedule) } } });
  });
}

/** Pause, or resume from the next date after today (missed dates aren't made). */
export async function setRecurringPaused(book: BookView, id: string, paused: boolean, today: string, actor: string | null) {
  const r = await prisma.bkRecurring.findFirst({ where: { id, bookId: book.id } });
  if (!r) throw new BooksError("Not found");
  // Resuming: the next date on or after today (and never before where it had got to).
  const later = (a: string, b: string) => (a > b ? a : b);
  const from = [today, fromDbDate(r.startDate)!, fromDbDate(r.nextDate) ?? today].reduce(later);
  const next = paused ? fromDbDate(r.nextDate) : occurrenceOnOrAfter(scheduleOf(r), from);
  await prisma.$transaction(async (tx) => {
    await tx.bkRecurring.update({ where: { id }, data: { paused, nextDate: next ? toDbDate(next) : null } });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: paused ? "recurring.paused" : "recurring.resumed", detail: { recurringId: id, name: r.name } } });
  });
}

/** Stop for good. Entries already made stay. */
export async function deleteRecurring(book: BookView, id: string, actor: string | null) {
  const r = await prisma.bkRecurring.findFirst({ where: { id, bookId: book.id } });
  if (!r) return;
  await prisma.$transaction(async (tx) => {
    await tx.bkRecurring.delete({ where: { id } });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "recurring.deleted", detail: { recurringId: id, name: r.name } } });
  });
}

export async function listRecurring(book: BookView) {
  const rules = await prisma.bkRecurring.findMany({ where: { bookId: book.id }, orderBy: [{ paused: "asc" }, { nextDate: "asc" }, { name: "asc" }] });
  const contacts = await prisma.bkContact.findMany({ where: { id: { in: rules.map((r) => r.contactId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const out = [];
  for (const r of rules) {
    let total: bigint | null = null;
    let problem: string | null = null;
    try {
      total = await checkPosting(book, r.type as DocType, r.data, r.contactId);
    } catch (e) {
      problem = e instanceof BooksError ? e.message : "This can't be saved as it stands";
    }
    out.push({
      id: r.id,
      name: r.name,
      kind: DOC_LABELS[r.type as DocType] ?? r.type,
      contactName: contacts.find((c) => c.id === r.contactId)?.name ?? null,
      total,
      problem,
      schedule: describeSchedule(scheduleOf(r)),
      frequency: r.frequency,
      interval: r.interval,
      dayOfMonth: r.dayOfMonth,
      startDate: fromDbDate(r.startDate)!,
      endDate: fromDbDate(r.endDate),
      nextDate: fromDbDate(r.nextDate),
      mode: r.mode,
      paused: r.paused,
      lastMessage: r.lastMessage,
    });
  }
  return out;
}

/**
 * Make every occurrence due by `today` for one book. Safe to run from
 * several places at once: each occurrence has its own key, and the next date
 * only moves forward from the value this run read.
 */
export async function runRecurring(book: BookView, today: string): Promise<number> {
  const rules = await prisma.bkRecurring.findMany({ where: { bookId: book.id, paused: false, nextDate: { not: null, lte: toDbDate(today) } } });
  let made = 0;
  for (const r of rules) {
    const readNext = fromDbDate(r.nextDate);
    const { dates, next } = dueOccurrences(scheduleOf(r), readNext, today);
    const notes: string[] = [];
    for (const date of dates) {
      const data = { ...((r.data ?? {}) as Record<string, unknown>) };
      if (r.dueDays !== null && "dueDate" in data) data.dueDate = addDays(date, r.dueDays);
      try {
        const { doc, action } = await upsertImported(book, { source: "recurring", sourceRef: `${r.id}:${date}`, type: r.type as DocType, date, data, memo: r.memo, contactId: r.contactId, storeId: r.storeId });
        if (action === "created") made++;
        if (r.mode === "auto" && doc.status === "draft") {
          try {
            await postDocument(book, doc.id, null);
          } catch (e) {
            notes.push(`${date}: kept as a draft — ${e instanceof BooksError ? e.message : "it couldn't be saved"}`);
          }
        }
      } catch (e) {
        notes.push(`${date}: ${e instanceof BooksError ? e.message : "couldn't be made"}`);
        if (!(e instanceof BooksError)) console.error("[books] recurring entry failed", { bookId: book.id, recurringId: r.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Only move forward from what this run read; a parallel run that got further wins.
    await prisma.bkRecurring.updateMany({
      where: { id: r.id, nextDate: readNext ? toDbDate(readNext) : null },
      data: { nextDate: next ? toDbDate(next) : null, lastRunAt: new Date(), lastMessage: notes.length ? notes.slice(0, 5).join("; ").slice(0, 1000) : null },
    });
  }
  return made;
}

/** The scheduler's pass over every book with something due. */
export async function runAllRecurring(now = new Date(), isOn: (organizationId: string) => Promise<boolean> = async () => true): Promise<number> {
  // Anything due by tomorrow in UTC covers every time zone's "today".
  const due = await prisma.bkRecurring.findMany({ where: { paused: false, nextDate: { not: null, lte: toDbDate(addDays(now.toISOString().slice(0, 10), 1)) } }, select: { bookId: true }, distinct: ["bookId"] });
  let made = 0;
  for (const { bookId } of due) {
    try {
      const row = await prisma.bkBook.findUnique({ where: { id: bookId }, select: { organizationId: true } });
      // An organization whose Books is switched off keeps its rules but makes nothing.
      const book = row && (await isOn(row.organizationId)) ? await getBook(row.organizationId) : null;
      if (book) made += await runRecurring(book, todayIn(book.settings.timeZone, now));
    } catch (e) {
      console.error("[books] recurring pass failed for a book", { bookId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return made;
}

/** Read the schedule fields a RepeatForm sends. */
export function readScheduleForm(form: FormData): ScheduleInput {
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  return {
    name: get("name"),
    frequency: get("frequency"),
    interval: Number(get("interval")) || 0,
    dayOfMonth: get("dayOfMonth") ? Number(get("dayOfMonth")) : null,
    startDate: get("startDate"),
    endDate: get("endDate") || null,
    mode: get("mode"),
  };
}
