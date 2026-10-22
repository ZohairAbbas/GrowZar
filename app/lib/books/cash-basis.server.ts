/**
 * Cash-basis movements for a period, from the ledger (see cash-basis.ts for
 * the rules). Same shape as ledgerSums, so every P&L view — one period, month
 * by month, against another period, by tag — works on either basis.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "~/lib/db.server";
import { toDbDate } from "./books.server";
import { CASH_ROWS, cashMovements, type CashEntry, type CashLine } from "./cash-basis";
import type { ReportAccount } from "./reports";

const MONEY = ["bank", "cash", "mobile_wallet", "ad_wallet", "card"];

export async function cashSums(bookId: string, opts: { from?: string; to?: string; tag?: string | null; storeId?: string } = {}): Promise<Map<string, bigint>> {
  const rows = await prisma.$queryRaw<Array<{ entryId: string; documentId: string; type: string; accountId: string; amount: bigint }>>`
    SELECT l."entryId", e."documentId", d.type, l."accountId", l.amount
      FROM bk_entry_lines l
      JOIN bk_entries e ON e.id = l."entryId"
      JOIN bk_documents d ON d.id = e."documentId"
     WHERE l."bookId" = ${bookId}
       ${opts.from ? Prisma.sql`AND l.date >= ${toDbDate(opts.from)}` : Prisma.empty}
       ${opts.to ? Prisma.sql`AND l.date <= ${toDbDate(opts.to)}` : Prisma.empty}
       ${opts.storeId === undefined ? Prisma.empty : Prisma.sql`AND l."storeId" = ${opts.storeId}`}
       ${opts.tag === undefined || opts.tag === null ? Prisma.empty : opts.tag === "" ? Prisma.sql`AND cardinality(d.tags) = 0` : Prisma.sql`AND d.tags @> ARRAY[${opts.tag}]::text[]`}
       AND EXISTS (
         SELECT 1 FROM bk_entry_lines m JOIN bk_accounts a ON a.id = m."accountId"
          WHERE m."entryId" = l."entryId" AND a.subtype IN (${Prisma.join(MONEY)})
       )
     ORDER BY l."entryId"`;
  if (rows.length === 0) return new Map();
  const entries = new Map<string, CashEntry>();
  for (const r of rows) {
    let e = entries.get(r.entryId);
    if (!e) entries.set(r.entryId, (e = { documentId: r.documentId, docType: r.type, lines: [] }));
    e.lines.push({ accountId: r.accountId, amount: BigInt(r.amount) });
  }
  const docIds = [...new Set(rows.map((r) => r.documentId))];
  const [accounts, allocs] = await Promise.all([
    prisma.bkAccount.findMany({ where: { bookId }, select: { id: true, type: true, subtype: true, systemKey: true } }),
    prisma.bkAllocation.findMany({ where: { bookId, paymentId: { in: docIds }, voidedAt: null }, select: { paymentId: true, billId: true, amount: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const allocations = new Map<string, Array<{ targetId: string; amount: bigint }>>();
  for (const a of allocs) allocations.set(a.paymentId, [...(allocations.get(a.paymentId) ?? []), { targetId: a.billId, amount: a.amount }]);
  const targetIds = [...new Set(allocs.map((a) => a.billId))];
  const targets = new Map<string, CashLine[]>();
  if (targetIds.length) {
    const t = await prisma.$queryRaw<Array<{ documentId: string; accountId: string; s: bigint }>>`
      SELECT e."documentId", l."accountId", SUM(l.amount)::bigint AS s
        FROM bk_entry_lines l JOIN bk_entries e ON e.id = l."entryId"
       WHERE l."bookId" = ${bookId} AND e."documentId" IN (${Prisma.join(targetIds)})
       GROUP BY 1, 2`;
    for (const r of t) if (BigInt(r.s) !== 0n) targets.set(r.documentId, [...(targets.get(r.documentId) ?? []), { accountId: r.accountId, amount: BigInt(r.s) }]);
  }
  return cashMovements({ entries: [...entries.values()], accounts: new Map(accounts.map((a) => [a.id, a])), allocations, targets });
}

/** The cash-only rows, as accounts the P&L can show (they don't open a register). */
export const CASH_ACCOUNTS: ReportAccount[] = Object.values(CASH_ROWS).map((r) => ({ id: r.id, code: "", name: r.name, type: r.type, subtype: r.subtype, systemKey: null, archived: false }));
