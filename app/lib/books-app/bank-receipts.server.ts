import { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { booksOn } from "./switch.server";
import { bankSummary, lastInBankByCourier } from "./bank-receipts";
import { courierName } from "./connectors/courier-payouts";

/**
 * "Received in bank" (display rule #17's second stage, B7): a courier payout
 * in Books whose money line on a bank account or mobile wallet is matched to
 * a statement line, alone or in a group, or cleared in a finished
 * reconciliation. Only the amount, the payout's date and courier, and the
 * day the bank shows leave Books; never a statement line's words (D-72, D-73).
 *
 * Null when the store's organization has no book, Books is off, or no
 * statement has been brought in yet: then nobody knows what reached the bank.
 */
export type PayoutInBank = {
  docId: string;
  /** Courierify's settlement id (the payout connector's sourceRef); null for a payout typed in or from a file. */
  settlementId: string | null;
  /** The courier as Books names it ("PostEx"). */
  courier: string | null;
  /** The payout's own date. */
  day: string;
  /** What was paid into the account, minor units. */
  net: bigint;
  /** The statement's date for it, or the reconciliation's, when it reached the bank. */
  inBankOn: string | null;
};

export type BankReceipts = { currency: string; decimals: number; payouts: PayoutInBank[] };

const BANKS = ["bank", "mobile_wallet"];
const day = (d: Date) => d.toISOString().slice(0, 10);

export async function payoutsInBank(storeId: string, opts: { from?: string; to?: string } = {}): Promise<BankReceipts | null> {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { organizationId: true } });
  if (!store || !(await booksOn(store.organizationId))) return null;
  const book = await prisma.bkBook.findUnique({ where: { organizationId: store.organizationId }, select: { id: true, currency: true, currencyDecimals: true } });
  if (!book) return null;
  if (!(await prisma.bkStatementImport.findFirst({ where: { bookId: book.id }, select: { id: true } }))) return null;
  const rows = await prisma.$queryRaw<Array<{ docId: string; sourceRef: string | null; source: string | null; date: Date; courier: string | null; lineId: bigint; amount: bigint }>>`
    SELECT d.id AS "docId", d."sourceRef", d.source, d.date, c.name AS courier, l.id AS "lineId", l.amount
      FROM bk_documents d
      JOIN bk_entries e ON e."documentId" = d.id AND e.kind = 'post'
      JOIN bk_entry_lines l ON l."entryId" = e.id
      JOIN bk_accounts a ON a.id = l."accountId"
      LEFT JOIN bk_contacts c ON c.id = d."contactId"
     WHERE d."bookId" = ${book.id} AND d.type = 'courier_payout' AND d.status = 'posted' AND d."storeId" = ${storeId}
       AND a.subtype IN (${Prisma.join(BANKS)}) AND l.amount > 0
       ${opts.from ? Prisma.sql`AND d.date >= ${new Date(`${opts.from}T00:00:00Z`)}` : Prisma.empty}
       ${opts.to ? Prisma.sql`AND d.date <= ${new Date(`${opts.to}T00:00:00Z`)}` : Prisma.empty}`;
  if (rows.length === 0) return { currency: book.currency, decimals: book.currencyDecimals, payouts: [] };
  const ids = rows.map((r) => r.lineId);
  const [single, grouped, cleared] = await Promise.all([
    prisma.bkStatementLine.findMany({ where: { bookId: book.id, status: "matched", entryLineId: { in: ids } }, select: { entryLineId: true, date: true } }),
    prisma.bkStatementMatch.findMany({ where: { bookId: book.id, entryLineId: { in: ids } }, select: { entryLineId: true, groupId: true } }),
    prisma.bkClearedLine.findMany({ where: { bookId: book.id, entryLineId: { in: ids }, reconciliation: { status: "done" } }, select: { entryLineId: true, reconciliation: { select: { statementDate: true } } } }),
  ]);
  const groupDays = new Map<string, Date>();
  if (grouped.length) {
    const lines = await prisma.bkStatementLine.findMany({ where: { bookId: book.id, status: "matched", matchGroup: { in: [...new Set(grouped.map((g) => g.groupId))] } }, select: { matchGroup: true, date: true } });
    // A group's money reached the bank on its earliest statement line.
    for (const l of lines) if (l.matchGroup && (!groupDays.has(l.matchGroup) || l.date < groupDays.get(l.matchGroup)!)) groupDays.set(l.matchGroup, l.date);
  }
  const inBank = new Map<bigint, Date>();
  for (const s of single) if (s.entryLineId !== null) inBank.set(s.entryLineId, s.date);
  for (const g of grouped) {
    const d = groupDays.get(g.groupId);
    if (d && !inBank.has(g.entryLineId)) inBank.set(g.entryLineId, d);
  }
  for (const c of cleared) if (!inBank.has(c.entryLineId)) inBank.set(c.entryLineId, c.reconciliation.statementDate);

  const byDoc = new Map<string, PayoutInBank>();
  for (const r of rows) {
    const at = inBank.get(r.lineId);
    const p = byDoc.get(r.docId) ?? { docId: r.docId, settlementId: r.source === "courierify_payouts" ? r.sourceRef : null, courier: r.courier, day: day(r.date), net: 0n, inBankOn: null };
    p.net += r.amount;
    // A payout split over two accounts is in the bank once all of it is, on the later day.
    if (at) p.inBankOn = !p.inBankOn || day(at) > p.inBankOn ? day(at) : p.inBankOn;
    byDoc.set(r.docId, p);
  }
  // …and not while any of its lines is still unmatched.
  const unmatchedDocs = new Set(rows.filter((r) => !inBank.has(r.lineId)).map((r) => r.docId));
  return {
    currency: book.currency,
    decimals: book.currencyDecimals,
    payouts: [...byDoc.values()].map((p) => (unmatchedDocs.has(p.docId) ? { ...p, inBankOn: null } : p)).sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** Finance's "Received in bank" for a store's period; null when Books can't tell. */
export async function receivedInBank(storeId: string, from: string, to: string) {
  const r = await payoutsInBank(storeId, { from, to });
  return r ? bankSummary(r.payouts, r.currency, r.decimals) : null;
}

/**
 * D-93: per payer (Courierify's courier key, "postex"), the latest day the
 * bank shows one of its payouts. Null when Books can't tell (no book, Books
 * off, no statement brought in).
 */
export async function lastInBankByPayer(storeId: string, payers: readonly string[]): Promise<Map<string, string> | null> {
  const r = await payoutsInBank(storeId);
  if (!r) return null;
  const byName = lastInBankByCourier(r.payouts);
  const out = new Map<string, string>();
  for (const p of payers) {
    const day = byName.get(courierName(p).toLowerCase());
    if (day) out.set(p, day);
  }
  return out;
}
