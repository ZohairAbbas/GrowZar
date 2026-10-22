/**
 * Courier settlements from a file: match each row to a parcel, show the sums,
 * and record one payout entry that clears what the courier owed, books what it
 * kept (by kind) and marks returned parcels so the next sales run takes them
 * off. See courier-sheet.ts for reading the file.
 *
 * Growzar: ported from Financify's Books (0cc8732). The book's own choice of
 * when COD sales count is used (D-69, D-83). A settlement or loadsheet doesn't
 * bring days in again: the sales connector reads the register's paid, returned
 * and dispatch dates as release evidence, and a sale let in late counts on the
 * next day it brings in (pack rule 3).
 */

import { prisma } from "~/lib/db.server";
import { BooksError, cancelDocument, createAccount, fromDbDate, listAccounts, saveAndPost, toDbDate, type BookView } from "./books.server";
import { courierAccounts } from "./connectors/parcels";
import { salesMapping } from "./connectors/parcels.server";
import { normOrderRef, normTracking, readSettlementFile, settlementTotals, type SheetLine } from "./courier-sheet";

export type TaxTreatment = "expense" | "claimable";

export interface CourierTaxSettings {
  /** Income tax the courier withheld: a cost, or tax you claim against your return. */
  withheld: TaxTreatment;
  /** Sales tax on the courier's charges: part of the charge, or claimable when you're registered. */
  salesTax: TaxTreatment;
}

export function courierTaxSettings(book: BookView): CourierTaxSettings {
  const s = book.settings.courierTax ?? {};
  return { withheld: s.withheld === "claimable" ? "claimable" : "expense", salesTax: s.salesTax === "claimable" ? "claimable" : "expense" };
}

interface ParcelRow {
  id: string;
  orderName: string;
  trackingNumber: string | null;
  courier: string | null;
  accountId: string;
  owed: bigint;
  paid: bigint;
  writtenOff: bigint;
  payoutDocId: string | null;
}

export interface MatchedLine extends SheetLine {
  parcelId: string | null;
  orderName: string | null;
  /** What Books has the parcel owing now (before this settlement). */
  owed: bigint | null;
  /** Already cleared by a payout in the books (this row would count twice). */
  alreadyPaid: { docId: string; number: string | null } | null;
  /** Collected differs from what Books has owing (short or over). */
  difference: bigint;
}

/** Find each row's parcel: by tracking number, else by order number (when only one order has it). */
async function matchLines(book: BookView, lines: SheetLine[]): Promise<MatchedLine[]> {
  const parcels: ParcelRow[] = await prisma.bkParcel.findMany({
    where: { bookId: book.id },
    select: { id: true, orderName: true, trackingNumber: true, courier: true, accountId: true, owed: true, paid: true, writtenOff: true, payoutDocId: true },
  });
  const byTracking = new Map<string, ParcelRow>();
  const byOrder = new Map<string, ParcelRow[]>();
  for (const p of parcels) {
    const t = normTracking(p.trackingNumber);
    if (t) byTracking.set(t, p);
    const o = normOrderRef(p.orderName);
    if (o) byOrder.set(o, [...(byOrder.get(o) ?? []), p]);
  }
  const payoutIds = [...new Set(parcels.map((p) => p.payoutDocId).filter((x): x is string => !!x))];
  const live = new Map(
    payoutIds.length ? (await prisma.bkDocument.findMany({ where: { bookId: book.id, id: { in: payoutIds }, status: "posted" }, select: { id: true, number: true } })).map((d) => [d.id, d.number]) : [],
  );
  const used = new Set<string>();
  return lines.map((l) => {
    let p = l.tracking ? byTracking.get(normTracking(l.tracking)) : undefined;
    if (!p && l.orderRef) {
      const c = byOrder.get(normOrderRef(l.orderRef)) ?? [];
      if (c.length === 1) p = c[0];
    }
    // The same parcel twice in one file: only the first row matches it.
    if (p && used.has(p.id)) p = undefined;
    if (p) used.add(p.id);
    const paidDoc = p?.payoutDocId && live.has(p.payoutDocId) ? { docId: p.payoutDocId, number: live.get(p.payoutDocId) ?? null } : null;
    const owed = p ? p.owed - p.writtenOff : null;
    return {
      ...l,
      parcelId: p?.id ?? null,
      orderName: p?.orderName ?? null,
      owed,
      alreadyPaid: paidDoc,
      difference: p && l.status === "delivered" ? l.collected - (owed ?? 0n) : 0n,
    };
  });
}

export interface SettlementPreview {
  lines: MatchedLine[];
  totals: ReturnType<typeof settlementTotals>;
  problems: string[];
  date: string | null;
  ref: string | null;
  columns: Record<string, string>;
  matched: number;
  unmatched: { count: number; collected: bigint };
  alreadyPaid: { count: number; collected: bigint; docs: string[] };
  short: { count: number; amount: bigint };
  over: { count: number; amount: bigint };
  duplicateOf: { id: string; documentId: string | null } | null;
  /** What this settlement would clear from "owed by couriers" (delivered, not already paid). */
  clears: bigint;
}

export async function previewSettlement(book: BookView, input: { text: string; courier: string; ref: string }): Promise<SettlementPreview> {
  const read = readSettlementFile(input.text, book.decimals);
  const lines = await matchLines(book, read.lines);
  const counted = lines.filter((l) => !l.alreadyPaid);
  const delivered = counted.filter((l) => l.status === "delivered");
  const sum = (ls: MatchedLine[], f: (l: MatchedLine) => bigint) => ls.reduce((s, l) => s + f(l), 0n);
  const ref = (input.ref || read.ref || "").trim();
  const dup = ref
    ? await prisma.bkCourierSheet.findFirst({ where: { bookId: book.id, kind: "settlement", status: "recorded", courier: { equals: input.courier.trim(), mode: "insensitive" }, ref: { equals: ref, mode: "insensitive" } }, select: { id: true, documentId: true } })
    : null;
  const paid = lines.filter((l) => l.alreadyPaid);
  return {
    lines,
    totals: settlementTotals(counted),
    problems: read.problems,
    date: read.date,
    ref: read.ref,
    columns: read.columns,
    matched: lines.filter((l) => l.parcelId).length,
    unmatched: { count: lines.filter((l) => !l.parcelId).length, collected: sum(lines.filter((l) => !l.parcelId), (l) => l.collected) },
    alreadyPaid: { count: paid.length, collected: sum(paid, (l) => l.collected), docs: [...new Set(paid.map((l) => l.alreadyPaid!.number ?? l.alreadyPaid!.docId))].slice(0, 5) },
    short: { count: delivered.filter((l) => l.difference < 0n).length, amount: -sum(delivered.filter((l) => l.difference < 0n), (l) => l.difference) },
    over: { count: delivered.filter((l) => l.difference > 0n).length, amount: sum(delivered.filter((l) => l.difference > 0n), (l) => l.difference) },
    duplicateOf: dup,
    clears: sum(delivered, (l) => l.collected),
  };
}

async function accountNamed(book: BookView, name: RegExp, create: { name: string; type: "expense" | "asset" | "liability"; subtype: string }, actor: string | null): Promise<string> {
  const all = await listAccounts(book);
  const found = all.find((a) => !a.archived && a.type === create.type && name.test(a.name));
  return found ? found.id : (await createAccount(book, { name: create.name, type: create.type, subtype: create.subtype }, actor)).id;
}

export interface RecordSettlementInput {
  text: string;
  fileName?: string | null;
  courier: string;
  ref: string;
  date: string;
  receivedIn: string;
  /** Delivered rows with no parcel in the register: owed from before Books (take off what couriers owe) or held apart. */
  unmatched: "owed" | "apart";
  /** One per form opened: a second submit (double click, retry) finds the first instead of recording twice. */
  formKey: string;
}

/**
 * Record a settlement: one payout entry (per owed-to account) and the parcels
 * marked paid or returned. Rows already cleared by another payout are left
 * out. Returns the entry and what was done.
 */
export async function recordSettlement(book: BookView, input: RecordSettlementInput, actor: string | null) {
  const courier = input.courier.trim().slice(0, 100);
  if (!courier) throw new BooksError("Which courier is this from?", "courier");
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(input.formKey)) throw new BooksError("Something went wrong sending the form. Reload and try again.");
  const earlier = await prisma.bkCourierSheet.findFirst({ where: { bookId: book.id, kind: "settlement", status: "recorded", totals: { path: ["formKey"], equals: input.formKey } } });
  if (earlier) return { sheetId: earlier.id, documents: [], totals: null, skipped: 0, again: true as const };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new BooksError("Choose the payment date", "date");
  if (book.lockedThrough && input.date <= book.lockedThrough) throw new BooksError(`Your books are closed through ${book.lockedThrough}. Use a later date or reopen that month.`, "date");
  const p = await previewSettlement(book, { text: input.text, courier, ref: input.ref });
  const ref = (input.ref || p.ref || "").trim().slice(0, 100);
  if (p.lines.length === 0) throw new BooksError(p.problems[0] ?? "No parcels found in that file");
  if (p.duplicateOf) throw new BooksError(`${courier} settlement ${ref} is already in your books`, "ref");
  const counted = p.lines.filter((l) => !l.alreadyPaid);
  if (counted.length === 0) throw new BooksError("Every parcel in this file is already paid in your books — nothing to record");

  const tax = courierTaxSettings(book);
  let codAccount: string | null = null;
  try {
    codAccount = [...courierAccounts(await salesMapping(book))][0] ?? null;
  } catch {
    codAccount = null;
  }
  if (!codAccount) codAccount = (await prisma.bkAccount.findFirst({ where: { bookId: book.id, name: "Owed by couriers", archivedAt: null }, select: { id: true } }))?.id ?? null;
  if (!codAccount) throw new BooksError("Books needs an “Owed by couriers” account for cash-on-delivery money. Add one in Settings → Accounts.");
  const parcelRows = await prisma.bkParcel.findMany({ where: { bookId: book.id, id: { in: counted.map((l) => l.parcelId).filter((x): x is string => !!x) } }, select: { id: true, accountId: true, storeId: true } });
  const parcelAccount = new Map(parcelRows.map((x) => [x.id, x.accountId]));
  // Growzar: one entry per owed-to account and store (D-65); rows with no parcel go with the file's first store.
  const parcelStore = new Map(parcelRows.map((x) => [x.id, x.storeId ?? ""]));
  const acc = {
    delivery: await accountNamed(book, /^delivery charges/i, { name: "Delivery charges", type: "expense", subtype: "cost_of_sales" }, actor),
    returnFee: await accountNamed(book, /^return charges/i, { name: "Return charges", type: "expense", subtype: "cost_of_sales" }, actor),
    claimable: await accountNamed(book, /^tax you can claim back/i, { name: "Tax you can claim back", type: "asset", subtype: "tax" }, actor),
    withheldCost: await accountNamed(book, /^tax withheld by others/i, { name: "Tax withheld by others", type: "expense", subtype: "operating" }, actor),
    shortfall: await accountNamed(book, /^courier shortfalls/i, { name: "Courier shortfalls", type: "expense", subtype: "cost_of_sales" }, actor),
  };
  const apart = input.unmatched === "apart" ? await accountNamed(book, /^courier money not for your orders/i, { name: "Courier money not for your orders", type: "liability", subtype: "other" }, actor) : null;

  // One entry per owed-to account and store (normally just one).
  const firstStore = parcelRows[0]?.storeId ?? "";
  const groups = new Map<string, MatchedLine[]>();
  for (const l of counted) {
    const a = (l.parcelId && parcelAccount.get(l.parcelId)) || codAccount;
    const st = (l.parcelId && parcelStore.get(l.parcelId)) || firstStore;
    groups.set(`${a}|${st}`, [...(groups.get(`${a}|${st}`) ?? []), l]);
  }
  const docs: Array<{ id: string; number: string | null }> = [];
  const sheet = await prisma.bkCourierSheet.create({
    data: { bookId: book.id, kind: "settlement", courier, ref, date: toDbDate(input.date), source: "file", fileName: input.fileName?.slice(0, 200) ?? null, status: "draft", createdBy: actor, totals: { formKey: input.formKey } },
  });
  let n = 0;
  for (const [key, ls] of groups) {
    const [receivable = codAccount, storeId = ""] = key.split("|");
    const t = settlementTotals(ls);
    const notOurs = apart ? ls.filter((l) => !l.parcelId).reduce((s, l) => s + l.collected, 0n) : 0n;
    const deductions = [
      { accountId: acc.delivery, amount: t.delivery, description: "Delivery charges" },
      { accountId: acc.returnFee, amount: t.returnFee, description: "Return charges" },
      { accountId: tax.salesTax === "claimable" ? acc.claimable : acc.delivery, amount: t.salesTax, description: "Sales tax on courier charges" },
      { accountId: tax.withheld === "claimable" ? acc.claimable : acc.withheldCost, amount: t.withheld, description: "Income tax withheld by the courier" },
      { accountId: acc.delivery, amount: t.otherFees, description: "Other courier fees" },
      // What the file's own sums don't explain (collected − kept − paid).
      { accountId: acc.shortfall, amount: t.unexplained, description: "Not explained by the courier's file" },
    ]
      .filter((x) => x.amount !== 0n)
      .map((x) => ({ ...x, amount: x.amount.toString() }));
    const res = await saveAndPost(
      book,
      {
        type: "courier_payout",
        date: input.date,
        storeId: storeId || null,
        newContactName: courier,
        newContactKind: "courier",
        clientKey: `cs-${input.formKey}-${n++}`,
        memo: `${courier} settlement${ref ? ` ${ref}` : ""} · ${t.delivered} delivered, ${t.returned} returned (from ${input.fileName || "a file"})`,
        data: { receivable, receivedIn: input.receivedIn, received: t.net.toString(), deductions, ...(apart && notOurs ? { others: { accountId: apart, amount: notOurs.toString() } } : {}) },
      },
      actor,
    );
    if (res.error) {
      // Nothing half-done: cancel what this settlement already posted, then say why.
      await prisma.bkCourierSheet.update({ where: { id: sheet.id }, data: { status: "discarded" } });
      if (docs.length) throw new BooksError(`${res.error.message} (part of this settlement was already recorded as ${docs.map((d) => d.number).join(", ")} — cancel it and try again)`, res.error.field);
      throw res.error;
    }
    docs.push({ id: res.doc.id, number: res.doc.number });
    // Parcels: delivered ones paid by this entry; returned ones marked so the sales run takes them off.
    for (const l of ls) {
      if (!l.parcelId) continue;
      const kept = l.delivery + l.returnFee + l.salesTax + l.withheld + l.otherFees;
      if (l.status === "delivered") {
        await prisma.bkParcel.update({ where: { id: l.parcelId }, data: { payoutDocId: res.doc.id, paid: l.collected, settlementRef: ref || null, settledAt: toDbDate(input.date), settledNet: l.net, settledFees: kept, settledStatus: "delivered" } });
      } else if (l.status === "returned") {
        await prisma.bkParcel.update({ where: { id: l.parcelId }, data: { settledStatus: "returned", settlementRef: ref || null, settledAt: toDbDate(input.date), settledFees: kept } });
      }
    }
  }
  const all = settlementTotals(counted);
  await prisma.bkCourierSheetLine.createMany({
    data: p.lines.map((l) => ({
      sheetId: sheet.id,
      bookId: book.id,
      row: l.row,
      tracking: l.tracking,
      orderRef: l.orderRef,
      parcelId: l.parcelId,
      status: l.status,
      rawStatus: l.rawStatus,
      cod: l.cod,
      collected: l.collected,
      delivery: l.delivery,
      returnFee: l.returnFee,
      salesTax: l.salesTax,
      withheld: l.withheld,
      otherFees: l.otherFees,
      net: l.net,
      note: l.alreadyPaid ? `Already paid in ${l.alreadyPaid.number ?? "another payout"}` : !l.parcelId ? "No matching order" : l.difference !== 0n ? `Collected ${l.difference > 0n ? "more" : "less"} than owed by ${(l.difference < 0n ? -l.difference : l.difference).toString()}` : null,
    })),
  });
  await prisma.bkCourierSheet.update({
    where: { id: sheet.id },
    data: { status: "recorded", documentId: docs[0]?.id ?? null, totals: JSON.parse(JSON.stringify({ ...all, documents: docs, formKey: input.formKey }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) },
  });
  // Sales held until paid (or delivered): the paid parcels count from the payment date.
  const rerun = await rerunFrom(book, input.date, ["money", "delivery"]);
  return { sheetId: sheet.id, documents: docs, totals: all, skipped: p.alreadyPaid.count, again: false as const, rerun };
}

/** Settlements and loadsheets recorded so far, newest first. */
export async function listCourierSheets(book: BookView, kind: "settlement" | "loadsheet") {
  const sheets = await prisma.bkCourierSheet.findMany({ where: { bookId: book.id, kind, status: { in: ["recorded"] } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 100 });
  const docIds = sheets.map((s) => s.documentId).filter((x): x is string => !!x);
  const live = new Map(docIds.length ? (await prisma.bkDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, number: true, status: true } })).map((d) => [d.id, d]) : []);
  return sheets.map((s) => ({
    id: s.id,
    courier: s.courier,
    ref: s.ref,
    date: fromDbDate(s.date)!,
    fileName: s.fileName,
    totals: s.totals as Record<string, unknown>,
    documentId: s.documentId,
    documentNumber: s.documentId ? live.get(s.documentId)?.number ?? null : null,
    cancelled: s.documentId ? live.get(s.documentId)?.status === "cancelled" : false,
  }));
}

// ── Loadsheets ───────────────────────────────────────────────────────────────

export interface LoadsheetPreview {
  lines: Array<MatchedLine & { saleOwed: bigint | null; dispatchedBefore: string | null }>;
  problems: string[];
  date: string | null;
  ref: string | null;
  columns: Record<string, string>;
  parcels: number;
  cod: bigint;
  matched: number;
  /** Not in the register yet (today's orders, or not cash on delivery): tied up when their sales come in. */
  unmatched: number;
  /** COD on the loadsheet differs from what Shopify says is owed (an edit after booking, a typo). */
  differs: { count: number; amount: bigint };
  /** Already on an earlier loadsheet: the earlier date stands. */
  again: number;
  duplicateOf: { id: string } | null;
  basis: "order" | "dispatch" | "delivery" | "money";
}

export async function previewLoadsheet(book: BookView, input: { text: string; courier: string; ref: string }): Promise<LoadsheetPreview> {
  const { readLoadsheetFile } = await import("./courier-sheet");
  const read = readLoadsheetFile(input.text, book.decimals);
  const lines = await matchLines(book, read.lines);
  const ids = lines.map((l) => l.parcelId).filter((x): x is string => !!x);
  const info = new Map(
    ids.length ? (await prisma.bkParcel.findMany({ where: { id: { in: ids } }, select: { id: true, saleOwed: true, dispatchedOn: true } })).map((p) => [p.id, p]) : [],
  );
  const out = lines.map((l) => {
    const p = l.parcelId ? info.get(l.parcelId) : undefined;
    return { ...l, saleOwed: p ? p.saleOwed : null, dispatchedBefore: p?.dispatchedOn ? fromDbDate(p.dispatchedOn) : null };
  });
  const ref = (input.ref || read.ref || "").trim();
  const dup = ref
    ? await prisma.bkCourierSheet.findFirst({ where: { bookId: book.id, kind: "loadsheet", status: "recorded", courier: { equals: input.courier.trim(), mode: "insensitive" }, ref: { equals: ref, mode: "insensitive" } }, select: { id: true } })
    : null;
  const differs = out.filter((l) => l.saleOwed !== null && l.saleOwed !== l.cod);
  const basis = (book.settings.codBasis ?? "delivery") as LoadsheetPreview["basis"];
  return {
    lines: out,
    problems: read.problems,
    date: read.date,
    ref: read.ref,
    columns: read.columns,
    parcels: out.length,
    cod: out.reduce((s, l) => s + l.cod, 0n),
    matched: out.filter((l) => l.parcelId).length,
    unmatched: out.filter((l) => !l.parcelId).length,
    differs: { count: differs.length, amount: differs.reduce((s, l) => s + (l.cod - (l.saleOwed ?? 0n)), 0n) },
    again: out.filter((l) => l.dispatchedBefore).length,
    duplicateOf: dup,
    basis,
  };
}

/**
 * Record a loadsheet: the parcels on it were handed to the courier that day.
 * With sales counted at dispatch, their held sales come in on that day — days
 * not yet saved are brought in again; a saved day keeps what it was saved with
 * and the sale comes in on the next new day.
 */
export async function recordLoadsheet(book: BookView, input: { text: string; fileName?: string | null; courier: string; ref: string; date: string; formKey: string }, actor: string | null) {
  const courier = input.courier.trim().slice(0, 100);
  if (!courier) throw new BooksError("Which courier is this for?", "courier");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new BooksError("Choose the dispatch date", "date");
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(input.formKey)) throw new BooksError("Something went wrong sending the form. Reload and try again.");
  const earlier = await prisma.bkCourierSheet.findFirst({ where: { bookId: book.id, kind: "loadsheet", status: "recorded", totals: { path: ["formKey"], equals: input.formKey } } });
  if (earlier) return { sheetId: earlier.id, rerun: false };
  const p = await previewLoadsheet(book, { text: input.text, courier, ref: input.ref });
  const ref = (input.ref || p.ref || "").trim().slice(0, 100);
  if (p.lines.length === 0) throw new BooksError(p.problems[0] ?? "No parcels found in that file");
  if (p.duplicateOf) throw new BooksError(`${courier} loadsheet ${ref} is already in your books`, "ref");
  const totals = { formKey: input.formKey, parcels: p.parcels, cod: p.cod.toString(), matched: p.matched, unmatched: p.unmatched, again: p.again };
  const sheet = await prisma.bkCourierSheet.create({
    data: { bookId: book.id, kind: "loadsheet", courier, ref, date: toDbDate(input.date), source: "file", fileName: input.fileName?.slice(0, 200) ?? null, status: "recorded", createdBy: actor, totals },
  });
  await prisma.bkCourierSheetLine.createMany({
    data: p.lines.map((l) => ({
      sheetId: sheet.id,
      bookId: book.id,
      row: l.row,
      tracking: l.tracking,
      orderRef: l.orderRef,
      parcelId: l.parcelId,
      status: "other",
      cod: l.cod,
      note: !l.parcelId ? "Not in the register yet" : l.dispatchedBefore ? `Already on a loadsheet of ${l.dispatchedBefore}` : l.saleOwed !== null && l.saleOwed !== l.cod ? "COD differs from the order" : null,
    })),
  });
  // The earliest dispatch date stands (a parcel re-listed on a later sheet doesn't move).
  for (const l of p.lines) {
    if (!l.parcelId || (l.dispatchedBefore && l.dispatchedBefore <= input.date)) continue;
    await prisma.bkParcel.update({ where: { id: l.parcelId }, data: { dispatchedOn: toDbDate(input.date), loadsheetId: sheet.id, ...(l.tracking ? { trackingNumber: l.tracking } : {}) } });
    await prisma.bkParcel.updateMany({ where: { id: l.parcelId, courier: null }, data: { courier } });
  }
  // Sales counted at dispatch: bring the unsaved days from the dispatch date in again.
  const rerun = p.basis === "dispatch" ? await rerunFrom(book, input.date) : false;
  return { sheetId: sheet.id, rerun };
}

/**
 * Each recorded loadsheet and where its parcels are now: dispatched =
 * delivered (paid or waiting for payout) + came back + still on the way +
 * not tied to an order yet. The check the merchant does against the courier.
 */
export async function loadsheetProgress(book: BookView) {
  const sheets = await prisma.bkCourierSheet.findMany({ where: { bookId: book.id, kind: "loadsheet", status: "recorded" }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 60, include: { lines: { select: { cod: true, parcelId: true } } } });
  const ids = [...new Set(sheets.flatMap((s) => s.lines.map((l) => l.parcelId)).filter((x): x is string => !!x))];
  const parcels = new Map(
    ids.length
      ? (await prisma.bkParcel.findMany({ where: { id: { in: ids } }, select: { id: true, trackingStatus: true, settledStatus: true, payoutDocId: true, paid: true, deliveredAt: true } })).map((p) => [p.id, p])
      : [],
  );
  const RETURNED = /RETURN|RTO|RTS|REFUSED|UNDELIVERED|FAILED/;
  return sheets.map((s) => {
    const t = { parcels: s.lines.length, cod: 0n, paid: 0n, delivered: 0n, returned: 0n, moving: 0n, loose: 0n, counts: { paid: 0, delivered: 0, returned: 0, moving: 0, loose: 0 } };
    for (const l of s.lines) {
      t.cod += l.cod;
      const p = l.parcelId ? parcels.get(l.parcelId) : undefined;
      const status = String(p?.trackingStatus ?? "").toUpperCase();
      const bucket: "paid" | "delivered" | "returned" | "moving" | "loose" = !p
        ? "loose"
        : p.settledStatus === "returned" || RETURNED.test(status)
          ? "returned"
          : p.payoutDocId
            ? "paid"
            : p.settledStatus === "delivered" || status === "DELIVERED" || p.deliveredAt
              ? "delivered"
              : "moving";
      t[bucket] += l.cod;
      t.counts[bucket]++;
    }
    return { id: s.id, courier: s.courier, ref: s.ref, date: fromDbDate(s.date)!, fileName: s.fileName, ...t };
  });
}

/**
 * Undo a recorded settlement: its payout entries are cancelled (a mirror entry,
 * nothing deleted) and its parcels go back to waiting — paid ones owed again,
 * returned ones back to what tracking says.
 */
export async function undoSettlement(book: BookView, sheetId: string, actor: string | null) {
  const sheet = await prisma.bkCourierSheet.findFirst({ where: { id: sheetId, bookId: book.id, kind: "settlement", status: "recorded" } });
  if (!sheet) throw new BooksError("That settlement isn't in your books");
  const docs = ((sheet.totals as { documents?: Array<{ id: string }> }).documents ?? []).map((d) => d.id);
  if (sheet.documentId && !docs.includes(sheet.documentId)) docs.push(sheet.documentId);
  const live = await prisma.bkDocument.findMany({ where: { id: { in: docs }, bookId: book.id, status: "posted" }, select: { id: true } });
  for (const d of live) await cancelDocument(book, d.id, `Settlement ${sheet.ref || sheet.courier} undone`, actor);
  const lines = await prisma.bkCourierSheetLine.findMany({ where: { sheetId }, select: { parcelId: true } });
  const ids = lines.map((l) => l.parcelId).filter((x): x is string => !!x);
  if (ids.length) {
    await prisma.bkParcel.updateMany({ where: { id: { in: ids }, payoutDocId: { in: docs } }, data: { payoutDocId: null, paid: 0n, settlementRef: null, settledAt: null, settledNet: null, settledFees: null, settledStatus: null } });
    await prisma.bkParcel.updateMany({ where: { id: { in: ids }, payoutDocId: null, settledStatus: "returned", settlementRef: sheet.ref || null }, data: { settledStatus: null, settlementRef: null, settledAt: null, settledFees: null } });
  }
  await prisma.bkCourierSheet.update({ where: { id: sheetId }, data: { status: "discarded" } });
  await rerunFrom(book, fromDbDate(sheet.date)!, ["money", "delivery"]);
  return { cancelled: live.length };
}

/**
 * Remove a loadsheet recorded by mistake: its parcels lose that dispatch date
 * (or take the next loadsheet's, if they're on another). With sales counted at
 * dispatch, days not yet saved are brought in again.
 */
export async function removeLoadsheet(book: BookView, sheetId: string) {
  const sheet = await prisma.bkCourierSheet.findFirst({ where: { id: sheetId, bookId: book.id, kind: "loadsheet", status: "recorded" } });
  if (!sheet) throw new BooksError("That loadsheet isn't in your books");
  await prisma.bkCourierSheet.update({ where: { id: sheetId }, data: { status: "discarded" } });
  const parcels = await prisma.bkParcel.findMany({ where: { bookId: book.id, loadsheetId: sheetId }, select: { id: true } });
  for (const p of parcels) {
    const other = await prisma.bkCourierSheetLine.findFirst({ where: { parcelId: p.id, sheet: { kind: "loadsheet", status: "recorded" } }, orderBy: { sheet: { date: "asc" } }, select: { sheetId: true, sheet: { select: { date: true } } } });
    await prisma.bkParcel.update({ where: { id: p.id }, data: other ? { dispatchedOn: other.sheet.date, loadsheetId: other.sheetId } : { dispatchedOn: null, loadsheetId: null } });
  }
  return { parcels: parcels.length, rerun: await rerunFrom(book, fromDbDate(sheet.date)!, ["dispatch"]) };
}

/**
 * Growzar: nothing to bring in again. The sales connector reads the register's
 * evidence (paid, returned, dispatched) on its next run, and a held sale let
 * in for a day it already brought in counts on the next new day. Kept so the
 * callers read as Financify's; always false.
 */
export async function rerunFrom(_book: BookView, _day: string, _bases: string[] = ["dispatch", "money"]): Promise<boolean> {
  return false;
}

/**
 * Loadsheet rows that came before their order did (today's orders on today's
 * loadsheet): tie them to the parcel once the sales run has made it, and date
 * its dispatch. Called after each sales run.
 */
export async function linkLoadsheets(book: BookView): Promise<number> {
  const loose = await prisma.bkCourierSheetLine.findMany({
    where: { bookId: book.id, parcelId: null, sheet: { kind: "loadsheet", status: "recorded" } },
    select: { id: true, tracking: true, orderRef: true, sheetId: true, sheet: { select: { date: true, courier: true } } },
    take: 5000,
  });
  if (loose.length === 0) return 0;
  const lines = await matchLines(book, loose.map((l, i) => ({ row: i, tracking: l.tracking, orderRef: l.orderRef, status: "other" as const, rawStatus: null, cod: 0n, collected: 0n, delivery: 0n, returnFee: 0n, salesTax: 0n, withheld: 0n, otherFees: 0n, net: 0n, unexplained: 0n })));
  let n = 0;
  for (let i = 0; i < loose.length; i++) {
    const parcelId = lines[i]!.parcelId;
    if (!parcelId) continue;
    const l = loose[i];
    await prisma.bkCourierSheetLine.update({ where: { id: l!.id }, data: { parcelId, note: null } });
    const p = await prisma.bkParcel.findUnique({ where: { id: parcelId }, select: { dispatchedOn: true, courier: true, trackingNumber: true } });
    if (!p) continue;
    if (!p.dispatchedOn || p.dispatchedOn > l!.sheet.date) {
      await prisma.bkParcel.update({ where: { id: parcelId }, data: { dispatchedOn: l!.sheet.date, loadsheetId: l!.sheetId, ...(p.courier ? {} : { courier: l!.sheet.courier }), ...(p.trackingNumber || !l!.tracking ? {} : { trackingNumber: l!.tracking }) } });
    }
    n++;
  }
  return n;
}
