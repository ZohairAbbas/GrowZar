/**
 * The accountant's views of the ledger: general ledger (every account's lines
 * with running balances), the journal (every entry with its debits and
 * credits), the activity log, what's owed to suppliers by age, and spending by
 * supplier. Read-only.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "~/lib/db.server";
import { actionPrefixes, activityText, type ActivityLine } from "./activity";
import { billPaidAmounts, fromDbDate, ledgerSums, reportAccounts, toDbDate, type BookView } from "./books.server";
import { DOC_LABELS, addDays, type DocType } from "./posting";
import { ageing, type ReportAccount } from "./reports";

const byCode = (x: { code: string }, y: { code: string }) => x.code.localeCompare(y.code, undefined, { numeric: true });

async function contactNames(ids: Iterable<string | null>): Promise<Map<string, string>> {
  const list = [...new Set([...ids].filter((x): x is string => !!x))];
  if (list.length === 0) return new Map();
  const rows = await prisma.bkContact.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
  return new Map(rows.map((c) => [c.id, c.name]));
}

// ── General ledger ───────────────────────────────────────────────────────────

export interface LedgerLine {
  id: string;
  date: string;
  documentId: string;
  number: string | null;
  kind: string;
  cancel: boolean;
  contactName: string | null;
  note: string | null;
  amount: bigint;
  running: bigint;
}

export interface LedgerAccount {
  account: ReportAccount;
  opening: bigint;
  lines: LedgerLine[];
  /** All movement in the period, even when the lines shown were cut short. */
  movement: bigint;
  closing: bigint;
}

export const GL_SCREEN_LIMIT = 2000;
export const GL_FILE_LIMIT = 200_000;

export async function generalLedger(book: BookView, opts: { from: string; to: string; accountId?: string | null; limit?: number }) {
  const limit = opts.limit ?? GL_SCREEN_LIMIT;
  const accounts = (await reportAccounts(book)).sort(byCode);
  const only = opts.accountId ? accounts.filter((a) => a.id === opts.accountId) : accounts;
  const [opening, movement, rows] = await Promise.all([
    ledgerSums(book.id, { to: addDays(opts.from, -1) }),
    ledgerSums(book.id, { from: opts.from, to: opts.to }),
    prisma.$queryRaw<
      Array<{ id: bigint; accountId: string; amount: bigint; date: Date; description: string | null; contactId: string | null; kind: string; documentId: string; number: string | null; type: string; memo: string | null; docContactId: string | null }>
    >`
      SELECT l.id, l."accountId", l.amount, l.date, l.description, l."contactId", e.kind, e."documentId", d.number, d.type, d.memo, d."contactId" AS "docContactId"
        FROM bk_entry_lines l
        JOIN bk_entries e ON e.id = l."entryId"
        JOIN bk_documents d ON d.id = e."documentId"
        JOIN bk_accounts a ON a.id = l."accountId"
       WHERE l."bookId" = ${book.id} AND l.date >= ${toDbDate(opts.from)} AND l.date <= ${toDbDate(opts.to)}
         ${opts.accountId ? Prisma.sql`AND l."accountId" = ${opts.accountId}` : Prisma.empty}
       ORDER BY a.code, l.date, l.id
       LIMIT ${limit + 1}`,
  ]);
  const truncated = rows.length > limit;
  const shown = truncated ? rows.slice(0, limit) : rows;
  const names = await contactNames(shown.flatMap((r) => [r.contactId, r.docContactId]));

  const byAccount = new Map<string, typeof shown>();
  for (const r of shown) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);

  const result: LedgerAccount[] = [];
  for (const a of only) {
    const open = opening.get(a.id) ?? 0n;
    const move = movement.get(a.id) ?? 0n;
    const ls = byAccount.get(a.id) ?? [];
    if (open === 0n && move === 0n && ls.length === 0) continue;
    let running = open;
    result.push({
      account: a,
      opening: open,
      movement: move,
      closing: open + move,
      lines: ls.map((r) => {
        running += r.amount;
        const contactId = r.contactId ?? r.docContactId;
        return {
          id: r.id.toString(),
          date: fromDbDate(r.date)!,
          documentId: r.documentId,
          number: r.number,
          kind: DOC_LABELS[r.type as DocType] ?? r.type,
          cancel: r.kind === "cancel",
          contactName: contactId ? names.get(contactId) ?? null : null,
          note: r.description ?? r.memo,
          amount: r.amount,
          running,
        };
      }),
    });
  }
  return { accounts: result, truncated, limit };
}

// ── Journal ──────────────────────────────────────────────────────────────────

export async function journal(book: BookView, opts: { from: string; to: string; page?: number; pageSize?: number }) {
  const pageSize = Math.min(opts.pageSize ?? 50, 5000);
  const page = Math.max(1, opts.page ?? 1);
  const where: Prisma.BkEntryWhereInput = { bookId: book.id, date: { gte: toDbDate(opts.from), lte: toDbDate(opts.to) } };
  const [count, entries] = await Promise.all([
    prisma.bkEntry.count({ where }),
    prisma.bkEntry.findMany({ where, orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize, include: { lines: { orderBy: { id: "asc" } } } }),
  ]);
  const docIds = [...new Set(entries.map((e) => e.documentId))];
  const docs = docIds.length ? await prisma.bkDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, number: true, type: true, memo: true, contactId: true } }) : [];
  const docMap = new Map(docs.map((d) => [d.id, d]));
  const names = await contactNames([...docs.map((d) => d.contactId), ...entries.flatMap((e) => e.lines.map((l) => l.contactId))]);
  return {
    count,
    page,
    pageSize,
    entries: entries.map((e) => {
      const d = docMap.get(e.documentId);
      return {
        id: e.id,
        date: fromDbDate(e.date)!,
        cancel: e.kind === "cancel",
        documentId: e.documentId,
        number: d?.number ?? null,
        kind: d ? DOC_LABELS[d.type as DocType] ?? d.type : "",
        memo: d?.memo ?? null,
        contactName: d?.contactId ? names.get(d.contactId) ?? null : null,
        lines: e.lines.map((l) => ({ id: l.id.toString(), accountId: l.accountId, amount: l.amount, description: l.description, contactName: l.contactId ? names.get(l.contactId) ?? null : null })),
      };
    }),
  };
}

// ── Activity ─────────────────────────────────────────────────────────────────

export async function activityLog(book: BookView, opts: { kind?: string; page?: number; pageSize?: number }) {
  const pageSize = Math.min(opts.pageSize ?? 50, 200);
  const page = Math.max(1, opts.page ?? 1);
  const prefixes = actionPrefixes(opts.kind ?? "");
  const where: Prisma.BkAuditEventWhereInput = { bookId: book.id, ...(prefixes ? { OR: prefixes.map((p) => ({ action: { startsWith: p } })) } : {}) };
  const [count, events] = await Promise.all([
    prisma.bkAuditEvent.count({ where }),
    prisma.bkAuditEvent.findMany({ where, orderBy: { id: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  const detail = (e: (typeof events)[number]) => (e.detail ?? {}) as Record<string, unknown>;
  const ids = (key: string) => [...new Set(events.map((e) => detail(e)[key]).filter((x): x is string => typeof x === "string"))];
  const docIds = [...new Set([...events.map((e) => e.documentId).filter((x): x is string => !!x), ...ids("documentId")])];
  const [accounts, contacts, docs] = await Promise.all([
    ids("accountId").length ? prisma.bkAccount.findMany({ where: { bookId: book.id, id: { in: ids("accountId") } }, select: { id: true, name: true } }) : [],
    ids("contactId").length ? prisma.bkContact.findMany({ where: { bookId: book.id, id: { in: ids("contactId") } }, select: { id: true, name: true } }) : [],
    docIds.length ? prisma.bkDocument.findMany({ where: { bookId: book.id, id: { in: docIds } }, select: { id: true, number: true, type: true } }) : [],
  ]);
  const acc = new Map(accounts.map((a) => [a.id, a.name]));
  const con = new Map(contacts.map((c) => [c.id, c.name]));
  const doc = new Map(docs.map((d) => [d.id, [d.number, DOC_LABELS[d.type as DocType] ?? d.type].filter(Boolean).join(" · ")]));
  const lookup = (m: Map<string, string>) => (id: unknown) => (typeof id === "string" ? m.get(id) ?? null : null);
  return {
    count,
    page,
    pageSize,
    events: events.map((e) => {
      // A discarded draft is gone; its event keeps the id but nothing to open.
      const line: ActivityLine = activityText({ action: e.action, detail: detail(e), documentId: e.documentId && doc.has(e.documentId) ? e.documentId : null }, { account: lookup(acc), contact: lookup(con), document: lookup(doc) });
      return { id: e.id.toString(), at: e.createdAt.toISOString(), actor: e.actor, ...line };
    }),
  };
}

// ── What you owe suppliers, by age ───────────────────────────────────────────

/**
 * Open bills today, grouped by supplier and how late they are, plus what the
 * "you owe" accounts hold that isn't a bill (opening balances, manual entries),
 * so the total matches the balance sheet.
 */
export async function agedPayables(book: BookView, asOf: string, kind: "bill" | "invoice" = "bill") {
  const bills = await prisma.bkDocument.findMany({ where: { bookId: book.id, type: kind, status: "posted" }, select: { id: true, number: true, date: true, contactId: true, total: true, data: true } });
  const paid = await billPaidAmounts(book.id, bills.map((b) => b.id));
  const names = await contactNames(bills.map((b) => b.contactId));
  const open = bills
    .map((b) => {
      const d = (b.data ?? {}) as { dueDate?: string | null };
      return { contactId: b.contactId, contactName: b.contactId ? names.get(b.contactId) ?? null : null, due: d.dueDate || fromDbDate(b.date)!, open: b.total - (paid.get(b.id) ?? 0n) };
    })
    .filter((b) => b.open > 0n);
  const aged = ageing(open, asOf);
  const accounts = await reportAccounts(book);
  const balances = await ledgerSums(book.id);
  // For customers: the "owed by customers" account (couriers and gateways have their own receivables, not invoices).
  const payables =
    kind === "bill"
      ? accounts.filter((a) => a.type === "liability" && a.subtype === "payable").reduce((s, a) => s + -(balances.get(a.id) ?? 0n), 0n)
      : accounts.filter((a) => a.systemKey === "receivables").reduce((s, a) => s + (balances.get(a.id) ?? 0n), 0n);
  return { ...aged, payables, notFromBills: payables - aged.total };
}

/** What customers owe on invoices, by how late it is; `payables` here is the "owed by customers" balance. */
export function agedReceivables(book: BookView, asOf: string) {
  return agedPayables(book, asOf, "invoice");
}

// ── Spending by supplier ─────────────────────────────────────────────────────

/** Document kinds whose costs aren't "spending with someone" (sales' cost of goods, stock counts, opening balances). */
const NOT_SPENDING = ["sales_summary", "stock_adjustment", "opening", "parcel_writeoff"];

/**
 * Costs (expense accounts) and stock bought, per contact, in a period. Read
 * from the ledger, so cancelled entries net to nothing.
 */
export async function spendingBySupplier(book: BookView, opts: { from: string; to: string }) {
  const rows = await prisma.$queryRaw<Array<{ contactId: string | null; accountId: string; amount: bigint }>>`
    SELECT d."contactId", l."accountId", SUM(l.amount)::bigint AS amount
      FROM bk_entry_lines l
      JOIN bk_entries e ON e.id = l."entryId"
      JOIN bk_documents d ON d.id = e."documentId"
      JOIN bk_accounts a ON a.id = l."accountId"
     WHERE l."bookId" = ${book.id} AND l.date >= ${toDbDate(opts.from)} AND l.date <= ${toDbDate(opts.to)}
       AND (a.type = 'expense' OR (a.type = 'asset' AND a.subtype = 'stock'))
       AND d.type <> ALL(${NOT_SPENDING})
     GROUP BY d."contactId", l."accountId"`;
  const accounts = new Map((await reportAccounts(book)).map((a) => [a.id, a]));
  const names = await contactNames(rows.map((r) => r.contactId));
  const by = new Map<string, { contactId: string | null; name: string; total: bigint; accounts: Array<{ accountId: string; name: string; amount: bigint }> }>();
  for (const r of rows) {
    if (r.amount === 0n) continue;
    const key = r.contactId ?? "";
    const row = by.get(key) ?? { contactId: r.contactId, name: r.contactId ? names.get(r.contactId) ?? "Unknown" : "No contact named", total: 0n, accounts: [] };
    row.total += r.amount;
    row.accounts.push({ accountId: r.accountId, name: accounts.get(r.accountId)?.name ?? "Unknown account", amount: r.amount });
    by.set(key, row);
  }
  const list = [...by.values()].filter((r) => r.total !== 0n);
  for (const r of list) r.accounts.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  list.sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.name.localeCompare(b.name)));
  return { rows: list, total: list.reduce((s, r) => s + r.total, 0n) };
}

// ── Stock ────────────────────────────────────────────────────────────────────

/**
 * How the Stock account moved in a period, by what moved it: bought (bills,
 * expenses), the cost of what you sold (sales), counts and checks, opening
 * balances, and anything else (manual entries).
 */
export async function stockMovement(book: BookView, stockAccountId: string, from: string, to: string) {
  const [before, rows] = await Promise.all([
    ledgerSums(book.id, { to: addDays(from, -1) }),
    prisma.$queryRaw<Array<{ type: string; amount: bigint }>>`
      SELECT d.type, SUM(l.amount)::bigint AS amount
        FROM bk_entry_lines l
        JOIN bk_entries e ON e.id = l."entryId"
        JOIN bk_documents d ON d.id = e."documentId"
       WHERE l."bookId" = ${book.id} AND l."accountId" = ${stockAccountId}
         AND l.date >= ${toDbDate(from)} AND l.date <= ${toDbDate(to)}
       GROUP BY d.type`,
  ]);
  const by = { bought: 0n, sold: 0n, adjusted: 0n, opening: 0n, other: 0n };
  for (const r of rows) {
    const k = r.type === "bill" || r.type === "expense" ? "bought" : r.type === "sales_summary" ? "sold" : r.type === "stock_adjustment" ? "adjusted" : r.type === "opening" ? "opening" : "other";
    by[k] += r.amount;
  }
  const start = before.get(stockAccountId) ?? 0n;
  const change = by.bought + by.sold + by.adjusted + by.opening + by.other;
  return { start, ...by, end: start + change };
}

// ── How much each account is used ────────────────────────────────────────────

/**
 * Per account: the last day anything was posted to it, how many lines in the
 * 90 days to `today`, and how many ever. For the chart of accounts ("in use",
 * "most recent first").
 */
export async function accountActivity(book: BookView, today: string): Promise<Map<string, { last: string | null; recent: number; total: number }>> {
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 90);
  const [all, recent] = await Promise.all([
    prisma.bkEntryLine.groupBy({ by: ["accountId"], where: { bookId: book.id }, _max: { date: true }, _count: { _all: true } }),
    prisma.bkEntryLine.groupBy({ by: ["accountId"], where: { bookId: book.id, date: { gte: since } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, { last: string | null; recent: number; total: number }>();
  for (const a of all) out.set(a.accountId, { last: a._max.date ? a._max.date.toISOString().slice(0, 10) : null, recent: 0, total: a._count._all });
  for (const r of recent) {
    const x = out.get(r.accountId);
    if (x) x.recent = r._count._all;
  }
  return out;
}
