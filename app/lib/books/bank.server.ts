/**
 * Bank statements and reconciliation.
 *
 *  - Import: a statement file becomes statement lines on a money account
 *    (lines already imported are skipped).
 *  - Review: each line is matched to the entry it is, recorded as a new entry
 *    (with rules suggesting the account), or ignored.
 *  - Reconcile: tick the entries the statement shows until the books agree
 *    with the statement's closing balance, then finish.
 *
 * Statement amounts are + money into the account, − out: the same sign the
 * ledger uses for that account's lines, so they compare directly.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "~/lib/db.server";
import { MATCH_WINDOW_DAYS, balanceNotes, bestMatches, contactsNamed, nameMatch, possibleDuplicates, splitAmounts, splitProblem, reconcileFigures, reversalPairs, ruleFor, ruleWordsFrom, suggestClose, suggestGroups, suggestMatches } from "./bank";
import { randomUUID } from "node:crypto";
import { mentionsNumber as mentionsNumberOf } from "./bank";
import { formatAmount } from "./money";
import { foreignBalances, fromDbDate, saveAndPost, toDbDate, type BookView } from "./books.server";
import { currencyDecimals } from "./money";
import { isMoneySubtype, naturalBalance } from "./chart";
import { DOC_LABELS, BooksError, addDays, isIsoDate, type DocType } from "./posting";
import { DATE_FORMATS, MAX_STATEMENT_BYTES, lineKeys, parseCsv, readStatement, type StatementMapping } from "./statement-csv";

async function moneyAccount(book: BookView, accountId: string) {
  const a = await prisma.bkAccount.findFirst({ where: { id: accountId, bookId: book.id } });
  if (!a) throw new BooksError("Choose an account", "accountId");
  if (!isMoneySubtype(a.subtype)) throw new BooksError(`"${a.name}" isn't a bank, cash, wallet or card account`, "accountId");
  return a;
}

async function audit(bookId: string, actor: string | null, action: string, detail: Record<string, unknown>, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  await tx.bkAuditEvent.create({ data: { bookId, actor, action, detail: detail as Prisma.InputJsonValue } });
}

// ── Overview ─────────────────────────────────────────────────────────────────

export async function bankOverview(book: BookView) {
  const accounts = await prisma.bkAccount.findMany({ where: { bookId: book.id, archivedAt: null, subtype: { in: ["bank", "cash", "mobile_wallet", "ad_wallet", "card"] } }, orderBy: { code: "asc" } });
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return [];
  const [balances, open, lastLines, recs] = await Promise.all([
    prisma.bkEntryLine.groupBy({ by: ["accountId"], where: { bookId: book.id, accountId: { in: ids } }, _sum: { amount: true } }),
    prisma.bkStatementLine.groupBy({ by: ["accountId"], where: { bookId: book.id, accountId: { in: ids }, status: "open" }, _count: true }),
    prisma.$queryRaw<Array<{ accountId: string; date: Date; balance: bigint | null }>>`
      SELECT DISTINCT ON ("accountId") "accountId", date, balance
        FROM bk_statement_lines WHERE "bookId" = ${book.id}
       ORDER BY "accountId", date DESC, id DESC`,
    prisma.bkReconciliation.findMany({ where: { bookId: book.id, accountId: { in: ids } }, orderBy: [{ statementDate: "desc" }, { createdAt: "desc" }] }),
  ]);
  const bal = new Map(balances.map((b) => [b.accountId, b._sum.amount ?? 0n]));
  const fxBal = await foreignBalances(book.id, accounts.filter((a) => a.currency).map((a) => a.id));
  const toReview = new Map(open.map((o) => [o.accountId, o._count]));
  const last = new Map(lastLines.map((l) => [l.accountId, l]));
  return accounts.map((a) => {
    const done = recs.find((r) => r.accountId === a.id && r.status === "done");
    const openRec = recs.find((r) => r.accountId === a.id && r.status === "open");
    const l = last.get(a.id);
    return {
      id: a.id,
      name: a.name,
      subtype: a.subtype,
      balance: naturalBalance(a.type, bal.get(a.id) ?? 0n),
      currency: a.currency,
      // Statement figures are in the account's own currency.
      fxBalance: a.currency ? naturalBalance(a.type, fxBal.get(a.id) ?? 0n) : null,
      toReview: toReview.get(a.id) ?? 0,
      lastStatementDate: l ? fromDbDate(l.date) : null,
      lastStatementBalance: l?.balance != null ? naturalBalance(a.type, l.balance) : null,
      reconciledThrough: done ? fromDbDate(done.statementDate) : null,
      reconciledBalance: done ? naturalBalance(a.type, done.statementBalance) : null,
      openReconciliationId: openRec?.id ?? null,
    };
  });
}

// ── Import ───────────────────────────────────────────────────────────────────

function checkMapping(m: unknown): StatementMapping {
  const x = (m ?? {}) as Partial<StatementMapping>;
  const int = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v < 1000;
  const optInt = (v: unknown) => v === null || int(v, 0);
  if (!int(x.headerRow, -1) || !int(x.dateCol, 0) || !Array.isArray(x.descCols) || !x.descCols.every((c) => int(c, 0))) throw new BooksError("Choose the columns again", "mapping");
  if (!DATE_FORMATS.some((f) => f.value === x.dateFormat)) throw new BooksError("Choose how dates are written", "dateFormat");
  if (!optInt(x.amountCol) || !optInt(x.outCol) || !optInt(x.inCol) || !optInt(x.balanceCol)) throw new BooksError("Choose the columns again", "mapping");
  if (x.amountCol === null && (x.outCol === null || x.inCol === null)) throw new BooksError("Choose the amount column, or the money-out and money-in columns", "amountCol");
  return { headerRow: x.headerRow!, dateCol: x.dateCol!, dateFormat: x.dateFormat!, descCols: x.descCols!.slice(0, 5), amountCol: x.amountCol ?? null, outCol: x.outCol ?? null, inCol: x.inCol ?? null, balanceCol: x.balanceCol ?? null, flip: !!x.flip };
}

export async function importStatement(book: BookView, input: { accountId: string; fileName: string | null; text: string; mapping: unknown }, actor: string | null) {
  const account = await moneyAccount(book, input.accountId);
  if (account.archivedAt) throw new BooksError(`"${account.name}" is archived`, "accountId");
  if (!input.text.trim()) throw new BooksError("Choose a statement file", "file");
  if (input.text.length > MAX_STATEMENT_BYTES) throw new BooksError("That file is too large (900 KB at most). Export a shorter period.", "file");
  const mapping = checkMapping(input.mapping);
  // A foreign account's statement is in its own currency.
  const read = readStatement(parseCsv(input.text), mapping, account.currency ? currencyDecimals(account.currency) : book.decimals);
  if (read.lines.length === 0) throw new BooksError(read.problems.length ? `No line could be read — ${read.problems[0]!.message} (row ${read.problems[0]!.row})` : "No transactions found with these columns", "mapping");
  const keys = lineKeys(read.lines);
  const dates = read.lines.map((l) => l.date).sort();
  const decimals = account.currency ? currencyDecimals(account.currency) : book.decimals;
  // Lines already in from other files over the same days, and the balance the last import ended on.
  const [existing, before] = await Promise.all([
    prisma.bkStatementLine.findMany({ where: { bookId: book.id, accountId: account.id, date: { gte: toDbDate(dates[0]!), lte: toDbDate(dates[dates.length - 1]!) } }, select: { id: true, date: true, amount: true, key: true } }),
    prisma.bkStatementLine.findFirst({ where: { bookId: book.id, accountId: account.id, date: { lt: toDbDate(dates[0]!) }, balance: { not: null } }, orderBy: [{ date: "desc" }, { id: "desc" }], select: { date: true, balance: true } }),
  ]);
  const existingKeys = new Set(existing.map((e) => e.key));
  const freshIdx = read.lines.map((_, i) => i).filter((i) => !existingKeys.has(keys[i]!));
  const dupMap = possibleDuplicates(
    freshIdx.map((i) => ({ date: read.lines[i]!.date, amount: read.lines[i]!.amount })),
    existing.map((e) => ({ id: e.id.toString(), date: fromDbDate(e.date)!, amount: e.amount })),
  );
  const dupOfKey = new Map<string, bigint>([...dupMap].map(([k, id]) => [keys[freshIdx[k]!]!, BigInt(id)]));
  const notes = balanceNotes(read.lines, before && before.balance !== null ? { date: fromDbDate(before.date)!, balance: before.balance } : null, (v) => formatAmount(v, decimals));

  const result = await prisma.$transaction(
    async (tx) => {
      const imp = await tx.bkStatementImport.create({
        data: { bookId: book.id, accountId: account.id, fileName: input.fileName?.slice(0, 200) ?? null, added: 0, duplicates: 0, firstDate: toDbDate(dates[0]!), lastDate: toDbDate(dates[dates.length - 1]!), balanceNote: notes.join(" ") || null, createdBy: actor },
      });
      let added = 0;
      for (let i = 0; i < read.lines.length; i += 1000) {
        const r = await tx.bkStatementLine.createMany({
          data: read.lines.slice(i, i + 1000).map((l, j) => ({
            bookId: book.id,
            accountId: account.id,
            importId: imp.id,
            date: toDbDate(l.date),
            description: l.description,
            amount: l.amount,
            balance: l.balance,
            key: keys[i + j]!,
            dupOfId: dupOfKey.get(keys[i + j]!) ?? null,
          })),
          skipDuplicates: true,
        });
        added += r.count;
      }
      const duplicates = read.lines.length - added;
      if (added === 0) {
        // Nothing new: keep no empty import behind.
        await tx.bkStatementImport.delete({ where: { id: imp.id } });
      } else {
        await tx.bkStatementImport.update({ where: { id: imp.id }, data: { added, duplicates } });
        await audit(book.id, actor, "statement.imported", { accountId: account.id, name: account.name, added, duplicates, fileName: input.fileName ?? null }, tx);
      }
      const flagged = added ? await tx.bkStatementLine.count({ where: { importId: imp.id, dupOfId: { not: null } } }) : 0;
      return { importId: added ? imp.id : null, added, duplicates, possibleDuplicates: flagged };
    },
    { timeout: 60_000 },
  );
  return { ...result, problems: read.problems.slice(0, 50), problemCount: read.problems.length, skipped: read.skipped, balanceNotes: notes };
}

/** Take back an import, as long as none of its lines has been matched or recorded. */
export async function undoImport(book: BookView, importId: string, actor: string | null) {
  await prisma.$transaction(async (tx) => {
    const imp = await tx.bkStatementImport.findFirst({ where: { id: importId, bookId: book.id } });
    if (!imp) throw new BooksError("Import not found");
    const used = await tx.bkStatementLine.count({ where: { importId, status: "matched" } });
    if (used > 0) throw new BooksError(`${used} line${used === 1 ? " is" : "s are"} already matched. Unmatch ${used === 1 ? "it" : "them"} first.`);
    await tx.bkStatementImport.delete({ where: { id: importId } });
    await audit(book.id, actor, "statement.import_undone", { accountId: imp.accountId, added: imp.added, fileName: imp.fileName }, tx);
  });
}

// ── Review ───────────────────────────────────────────────────────────────────

type CandidateRow = { id: bigint; date: Date; amount: bigint; documentId: string; number: string | null; type: string; memo: string | null; contactId: string | null };

/** Posted entries' lines on an account that no statement line has claimed yet. */
async function unmatchedLedgerLines(book: BookView, accountId: string, from: string, to: string, amounts: bigint[] | null): Promise<CandidateRow[]> {
  if (amounts && amounts.length === 0) return [];
  return prisma.$queryRaw<CandidateRow[]>`
    SELECT l.id, l.date, COALESCE(l."fxAmount", l.amount) AS amount, e."documentId", d.number, d.type, d.memo, d."contactId"
      FROM bk_entry_lines l
      JOIN bk_entries e ON e.id = l."entryId" AND e.kind = 'post'
      JOIN bk_documents d ON d.id = e."documentId" AND d.status = 'posted'
     WHERE l."bookId" = ${book.id} AND l."accountId" = ${accountId}
       AND l.date >= ${toDbDate(from)} AND l.date <= ${toDbDate(to)}
       ${amounts ? Prisma.sql`AND COALESCE(l."fxAmount", l.amount) = ANY(${amounts})` : Prisma.empty}
       AND NOT EXISTS (SELECT 1 FROM bk_statement_lines s WHERE s."entryLineId" = l.id)
       AND NOT EXISTS (SELECT 1 FROM bk_statement_matches m WHERE m."entryLineId" = l.id)
     ORDER BY l.date, l.id
     LIMIT 5000`;
}

/** Statement lines whose entry was cancelled since: back to "to review" (a group goes back whole). */
async function releaseCancelled(book: BookView, accountId: string) {
  await prisma.$executeRaw`
    UPDATE bk_statement_lines s SET status = 'open', "entryLineId" = NULL, "documentId" = NULL, "matchedAt" = NULL
      FROM bk_documents d
     WHERE s."bookId" = ${book.id} AND s."accountId" = ${accountId} AND s.status = 'matched' AND s."matchGroup" IS NULL
       AND d.id = s."documentId" AND d.status = 'cancelled'`;
  const bad = await prisma.$queryRaw<Array<{ groupId: string }>>`
    SELECT DISTINCT m."groupId" FROM bk_statement_matches m
      JOIN bk_entry_lines l ON l.id = m."entryLineId"
      JOIN bk_entries e ON e.id = l."entryId"
      JOIN bk_documents d ON d.id = e."documentId"
     WHERE m."bookId" = ${book.id} AND l."accountId" = ${accountId} AND d.status = 'cancelled'`;
  for (const g of bad) await releaseGroup(book, g.groupId);
}

/** Undo a match group: its lines go back to "to review". */
async function releaseGroup(book: BookView, groupId: string, client?: Prisma.TransactionClient) {
  const run = async (tx: Prisma.TransactionClient) => {
    await tx.bkStatementLine.updateMany({ where: { bookId: book.id, matchGroup: groupId }, data: { status: "open", matchGroup: null, documentId: null, matchedAt: null } });
    await tx.bkStatementMatch.deleteMany({ where: { bookId: book.id, groupId } });
  };
  return client ? run(client) : prisma.$transaction(run);
}

export async function statementReview(book: BookView, accountId: string, opts: { show?: string; page?: number }) {
  const account = await moneyAccount(book, accountId);
  await releaseCancelled(book, accountId);
  const show = (["open", "matched", "ignored"] as const).find((s) => s === opts.show) ?? "open";
  const pageSize = 50;
  const page = Math.max(1, opts.page ?? 1);
  const where = { bookId: book.id, accountId, status: show };
  const [count, lines, counts, rules] = await Promise.all([
    prisma.bkStatementLine.count({ where }),
    prisma.bkStatementLine.findMany({ where, orderBy: show === "open" ? [{ date: "asc" }, { id: "asc" }] : [{ date: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.bkStatementLine.groupBy({ by: ["status"], where: { bookId: book.id, accountId }, _count: true }),
    prisma.bkBankRule.findMany({ where: { bookId: book.id } }),
  ]);

  // Suggestions for the open lines on this page, worked out with the open lines and entries around them.
  let candidates: CandidateRow[] = [];
  let suggested = new Map<string, string>();
  const scoreOf = new Map<string, { strength: string; reasons: string[] }>();
  const groupOf = new Map<string, { statementIds: string[]; ledgerIds: string[] }>();
  const closeOf = new Map<string, { ledgerId: string; difference: bigint }>();
  const reversalOf = new Map<string, string>();
  let around: Array<{ id: bigint; date: Date; amount: bigint; description: string }> = [];
  if (show === "open" && lines.length) {
    const dates = lines.map((l) => fromDbDate(l.date)!).sort();
    const from = addDays(dates[0]!, -MATCH_WINDOW_DAYS);
    const to = addDays(dates[dates.length - 1]!, MATCH_WINDOW_DAYS);
    // Entries from further around too: scoring decides how far is too far.
    [candidates, around] = await Promise.all([
      unmatchedLedgerLines(book, accountId, addDays(dates[0]!, -45), addDays(dates[dates.length - 1]!, 45), null),
      prisma.bkStatementLine.findMany({ where: { bookId: book.id, accountId, status: "open", date: { gte: toDbDate(from), lte: toDbDate(to) } }, select: { id: true, date: true, amount: true, description: true }, orderBy: [{ date: "asc" }, { id: "asc" }], take: 3000 }),
    ]);
    const st = around.map((l) => ({ id: l.id.toString(), date: fromDbDate(l.date)!, amount: l.amount, description: l.description }));
    const led = candidates.map((c) => ({ id: c.id.toString(), date: fromDbDate(c.date)!, amount: c.amount }));
    // Scored: amount, date, and the words (the entry's number, its contact's name).
    const candDocs = await prisma.bkDocument.findMany({ where: { id: { in: [...new Set(candidates.map((c) => c.documentId))] } }, select: { id: true, contactId: true } });
    const candContacts = await prisma.bkContact.findMany({ where: { id: { in: candDocs.map((d) => d.contactId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const contactOfDoc = new Map(candDocs.map((d) => [d.id, candContacts.find((c) => c.id === d.contactId)?.name ?? null]));
    const scored = bestMatches(
      st,
      candidates.map((c) => ({ id: c.id.toString(), date: fromDbDate(c.date)!, amount: c.amount, number: c.number, memo: c.memo, contactName: contactOfDoc.get(c.documentId) ?? null })),
    );
    // A payment and its reversal pair up before a match that isn't strong takes one of them.
    const paired = new Set(reversalPairs(st).flat());
    for (const [lineId, sc] of [...scored]) if (paired.has(lineId) && sc.strength !== "strong") scored.delete(lineId);
    for (const [lineId, sc] of scored) {
      if (sc.difference === 0n) {
        suggested.set(lineId, sc.id);
        scoreOf.set(lineId, sc);
      }
    }
    const usedL = new Set(suggested.values());
    let restS = st.filter((x) => !suggested.has(x.id));
    let restL = led.filter((x) => !usedL.has(x.id));
    for (const g of suggestGroups(restS, restL)) for (const sid of g.statementIds) groupOf.set(sid, g);
    restS = restS.filter((x) => !groupOf.has(x.id));
    const groupedL = new Set([...groupOf.values()].flatMap((g) => g.ledgerIds));
    restL = restL.filter((x) => !groupedL.has(x.id));
    // Close amounts: the scored pick when there is one (it weighs names and dates too), else the plain closest.
    for (const [lineId, sc] of scored) {
      if (sc.difference !== 0n && restS.some((x) => x.id === lineId) && restL.some((x) => x.id === sc.id)) {
        closeOf.set(lineId, { ledgerId: sc.id, difference: sc.difference });
        scoreOf.set(lineId, sc);
      }
    }
    const closeUsed = new Set([...closeOf.values()].map((c) => c.ledgerId));
    for (const c of suggestClose(restS.filter((x) => !closeOf.has(x.id)), restL.filter((x) => !closeUsed.has(x.id)))) closeOf.set(c.statementId, { ledgerId: c.ledgerId, difference: c.difference });
    restS = restS.filter((x) => !closeOf.has(x.id));
    for (const [a, b] of reversalPairs(restS)) {
      reversalOf.set(a, b);
      reversalOf.set(b, a);
    }
  }
  const dupIds = lines.map((l) => l.dupOfId).filter((x): x is bigint => x !== null);
  // For lines nothing in the books matches: an open bill or invoice of the same amount, or a contact the description names.
  const { listBills, listContacts } = await import("./books.server");
  const [openBills, openInvoices, allContacts] = show === "open" && lines.length ? await Promise.all([listBills(book, { open: true, type: "bill" }), listBills(book, { open: true, type: "invoice" }), listContacts(book)]) : [[], [], []];
  const dups = dupIds.length ? await prisma.bkStatementLine.findMany({ where: { id: { in: dupIds } }, select: { id: true, date: true, description: true, status: true, import: { select: { fileName: true } } } }) : [];
  const docIds = [...new Set([...candidates.map((c) => c.documentId), ...lines.map((l) => l.documentId).filter((x): x is string => !!x)])];
  const docs = docIds.length ? await prisma.bkDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, number: true, type: true, memo: true, contactId: true } }) : [];
  const contactIds = [...new Set([...docs.map((d) => d.contactId), ...rules.map((r) => r.contactId)].filter((x): x is string => !!x))];
  const [contacts, accounts] = await Promise.all([
    contactIds.length ? prisma.bkContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }) : [],
    prisma.bkAccount.findMany({ where: { bookId: book.id, id: { in: rules.flatMap((r) => [r.accountId, ...ruleSplit(r.split).map((x) => x.accountId)]) } }, select: { id: true, name: true, archivedAt: true } }),
  ]);
  const cName = new Map(contacts.map((c) => [c.id, c.name]));
  const aName = new Map(accounts.filter((a) => !a.archivedAt).map((a) => [a.id, a.name]));
  const docInfo = (id: string | null) => {
    const d = docs.find((x) => x.id === id);
    return d ? { id: d.id, number: d.number, kind: DOC_LABELS[d.type as DocType] ?? d.type, memo: d.memo, contactName: d.contactId ? cName.get(d.contactId) ?? null : null } : null;
  };
  // A rule whose account (or a split's) was archived since doesn't suggest anything.
  const liveRules = rules
    .map((r) => ({ ...r, direction: r.direction as "in" | "out", split: ruleSplit(r.split) }))
    .filter((r) => aName.has(r.accountId) && r.split.every((x) => aName.has(x.accountId)) && !(r.kind === "transfer" && r.accountId === accountId));

  return {
    account: { id: account.id, name: account.name, subtype: account.subtype, currency: account.currency },
    show,
    count,
    page,
    pageSize,
    counts: { open: 0, matched: 0, ignored: 0, ...Object.fromEntries(counts.map((c) => [c.status, c._count])) } as Record<"open" | "matched" | "ignored", number>,
    lines: lines.map((l) => {
      const sug = suggested.get(l.id.toString());
      const cand = sug ? candidates.find((c) => c.id.toString() === sug) : undefined;
      const rule = show === "open" && !cand && !groupOf.has(l.id.toString()) && !closeOf.has(l.id.toString()) ? ruleFor(liveRules, l.description, l.amount) : null;
      return {
        id: l.id.toString(),
        date: fromDbDate(l.date)!,
        description: l.description,
        amount: l.amount,
        balance: l.balance,
        status: l.status,
        matched: l.documentId ? docInfo(l.documentId) : null,
        suggestion: cand ? { entryLineId: cand.id.toString(), date: fromDbDate(cand.date)!, ...docInfo(cand.documentId)!, strength: scoreOf.get(l.id.toString())?.strength ?? "likely", reasons: scoreOf.get(l.id.toString())?.reasons ?? [] } : null,
        settle: (() => {
          if (show !== "open" || cand || groupOf.has(l.id.toString()) || closeOf.has(l.id.toString())) return null;
          const out = l.amount < 0n;
          const size = out ? -l.amount : l.amount;
          const pool = (out ? openBills : openInvoices).filter((b) => b.open === size);
          // The one the description names, or the only one of that amount.
          const named = pool.filter((b) => nameMatch(l.description, b.contactName) >= 1 || mentionsNumberOf(l.description, b.number));
          const pick = named.length === 1 ? named[0] : pool.length === 1 ? pool[0] : null;
          return pick ? { id: pick.id, number: pick.number, contactName: pick.contactName, open: pick.open, kind: out ? "bill" : "invoice", strength: named.length === 1 ? "strong" : "likely" } : null;
        })(),
        named: (() => {
          if (show !== "open" || cand) return null;
          const c = contactsNamed(l.description, allContacts.map((x) => ({ id: x.id, name: x.name })))[0];
          if (!c) return null;
          const full = allContacts.find((x) => x.id === c.id)!;
          return { contactId: c.id, contactName: c.name, accountId: full.lastAccountId ?? null, accountName: full.lastAccountId ? aName.get(full.lastAccountId) ?? null : null };
        })(),
        group: (() => {
          const g = !cand ? groupOf.get(l.id.toString()) : undefined;
          if (!g) return null;
          return {
            lineIds: g.statementIds,
            lines: g.statementIds.map((id) => around.find((a) => a.id.toString() === id)).filter(Boolean).map((a) => ({ id: a!.id.toString(), date: fromDbDate(a!.date)!, description: a!.description, amount: a!.amount })),
            entries: g.ledgerIds.map((id) => candidates.find((c) => c.id.toString() === id)!).map((c) => ({ entryLineId: c.id.toString(), date: fromDbDate(c.date)!, amount: c.amount, ...docInfo(c.documentId)! })),
          };
        })(),
        close: (() => {
          const c = !cand ? closeOf.get(l.id.toString()) : undefined;
          const e = c ? candidates.find((x) => x.id.toString() === c.ledgerId) : undefined;
          return c && e ? { entryLineId: c.ledgerId, date: fromDbDate(e.date)!, amount: e.amount, difference: c.difference, ...docInfo(e.documentId)! } : null;
        })(),
        reversal: (() => {
          const o = !cand ? reversalOf.get(l.id.toString()) : undefined;
          const a = o ? around.find((x) => x.id.toString() === o) : undefined;
          return a ? { lineId: o!, date: fromDbDate(a.date)!, description: a.description, amount: a.amount } : null;
        })(),
        duplicateOf: (() => {
          const d = l.dupOfId ? dups.find((x) => x.id === l.dupOfId) : undefined;
          return d ? { lineId: d.id.toString(), date: fromDbDate(d.date)!, description: d.description, status: d.status, fileName: d.import.fileName } : null;
        })(),
        rule: rule
          ? {
              id: rule.id,
              kind: rule.kind,
              accountId: rule.accountId,
              accountName: rule.kind === "transfer" ? `${l.amount < 0n ? "Moved to" : "Moved from"} ${aName.get(rule.accountId)!}` : rule.split.length ? rule.split.map((x) => `${aName.get(x.accountId)} ${x.percent}%`).join(" + ") : aName.get(rule.accountId)!,
              contactId: rule.contactId,
              contactName: rule.contactId ? cName.get(rule.contactId) ?? null : null,
            }
          : null,
        ruleWords: ruleWordsFrom(l.description),
      };
    }),
  };
}

/** Other unmatched entries a line could be (same amount, any date), for "Find a match". */
export async function matchChoices(book: BookView, lineId: string) {
  if (!/^\d+$/.test(lineId)) throw new BooksError("Line not found");
  const line = await prisma.bkStatementLine.findFirst({ where: { id: BigInt(lineId), bookId: book.id } });
  if (!line) throw new BooksError("Line not found");
  const date = fromDbDate(line.date)!;
  const rows = await unmatchedLedgerLines(book, line.accountId, addDays(date, -60), addDays(date, 60), [line.amount]);
  const docs = await prisma.bkDocument.findMany({ where: { id: { in: rows.map((r) => r.documentId) } }, select: { id: true, type: true, contactId: true } });
  const contacts = await prisma.bkContact.findMany({ where: { id: { in: docs.map((d) => d.contactId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return rows
    .map((r) => ({ entryLineId: r.id.toString(), date: fromDbDate(r.date)!, number: r.number, kind: DOC_LABELS[r.type as DocType] ?? r.type, memo: r.memo, contactName: contacts.find((c) => c.id === docs.find((d) => d.id === r.documentId)?.contactId)?.name ?? null, gap: Math.abs(Date.parse(fromDbDate(r.date)!) - Date.parse(date)) }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 20);
}

async function lockLine(tx: Prisma.TransactionClient, book: BookView, lineId: string) {
  let id: bigint;
  try {
    id = BigInt(lineId);
  } catch {
    throw new BooksError("Line not found");
  }
  const rows = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM bk_statement_lines WHERE id = ${id} AND "bookId" = ${book.id} FOR UPDATE`;
  if (!rows.length) throw new BooksError("Line not found");
  return tx.bkStatementLine.findUniqueOrThrow({ where: { id } });
}

/** Match a statement line to the ledger line it is. */
export async function matchStatementLine(book: BookView, lineId: string, entryLineId: string, client?: Prisma.TransactionClient) {
  const run = async (tx: Prisma.TransactionClient) => {
    const line = await lockLine(tx, book, lineId);
    if (line.status === "matched") throw new BooksError("This line is already matched");
    if (!/^\d+$/.test(entryLineId)) throw new BooksError("That entry isn't on this account");
    const ledger = await tx.bkEntryLine.findFirst({ where: { id: BigInt(entryLineId), bookId: book.id }, include: { entry: { select: { kind: true, documentId: true } } } });
    if (!ledger || ledger.accountId !== line.accountId) throw new BooksError("That entry isn't on this account");
    if (ledger.entry.kind !== "post") throw new BooksError("A cancellation can't be matched");
    // Foreign accounts compare in their own currency.
    if ((ledger.fxAmount ?? ledger.amount) !== line.amount) throw new BooksError("The amounts are different");
    const doc = await tx.bkDocument.findUniqueOrThrow({ where: { id: ledger.entry.documentId } });
    if (doc.status !== "posted") throw new BooksError("That entry has been cancelled");
    const taken = (await tx.bkStatementLine.findFirst({ where: { entryLineId: ledger.id } })) ?? (await tx.bkStatementMatch.findUnique({ where: { entryLineId: ledger.id } }));
    if (taken) throw new BooksError("That entry is already matched to another statement line");
    await tx.bkStatementLine.update({ where: { id: line.id }, data: { status: "matched", entryLineId: ledger.id, documentId: doc.id, matchedAt: new Date() } });
  };
  if (client) return run(client);
  return prisma.$transaction(run).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new BooksError("That entry is already matched to another statement line");
    throw e;
  });
}

export async function unmatchStatementLine(book: BookView, lineId: string) {
  await prisma.$transaction(async (tx) => {
    const line = await lockLine(tx, book, lineId);
    if (line.status !== "matched") return;
    if (line.matchGroup) return releaseGroup(book, line.matchGroup, tx);
    await tx.bkStatementLine.update({ where: { id: line.id }, data: { status: "open", entryLineId: null, documentId: null, matchedAt: null } });
  });
}

export async function setStatementLineIgnored(book: BookView, lineId: string, ignored: boolean) {
  await prisma.$transaction(async (tx) => {
    const line = await lockLine(tx, book, lineId);
    if (line.status === "matched") throw new BooksError("Unmatch this line first");
    await tx.bkStatementLine.update({ where: { id: line.id }, data: { status: ignored ? "ignored" : "open" } });
  });
}

/**
 * Link a statement line to an entry just saved from it (a form opened from the
 * line). Matches the entry's line on the statement's account with the same
 * amount; returns false when there isn't one (the amount or account changed).
 */
export async function linkStatementLineToDocument(book: BookView, lineId: string, documentId: string): Promise<boolean> {
  if (!/^\d+$/.test(lineId)) return false;
  const line = await prisma.bkStatementLine.findFirst({ where: { id: BigInt(lineId), bookId: book.id } });
  if (!line || line.status !== "open") return false;
  const candidates = await prisma.bkEntryLine.findMany({ where: { bookId: book.id, accountId: line.accountId, entry: { documentId, kind: "post" } } });
  const ledger = candidates.find((l) => (l.fxAmount ?? l.amount) === line.amount);
  if (!ledger) return false;
  try {
    await matchStatementLine(book, lineId, ledger.id.toString());
    return true;
  } catch (e) {
    if (e instanceof BooksError) return false;
    throw e;
  }
}

/**
 * Record a statement line as a new entry: money out as an expense, money in
 * as money in, on the line's date and account. Optionally remember the
 * account (and contact) for lines with the same words.
 */
export async function recordFromStatementLine(
  book: BookView,
  lineId: string,
  input: { accountId: string; contactId?: string | null; newContactName?: string | null; remember?: boolean; ruleWords?: string | null; ruleId?: string | null },
  actor: string | null,
) {
  // Recording by a rule: a transfer, or a split, as the rule says.
  if (input.ruleId) {
    const rule = await prisma.bkBankRule.findFirst({ where: { id: input.ruleId, bookId: book.id } });
    if (!rule) throw new BooksError("That rule was removed");
    if (rule.kind === "transfer" || ruleSplit(rule.split).length) return recordByRule(book, lineId, rule, actor);
  }
  if (!/^\d+$/.test(lineId)) throw new BooksError("Line not found");
  const line = await prisma.bkStatementLine.findFirst({ where: { id: BigInt(lineId), bookId: book.id } });
  if (!line) throw new BooksError("Line not found");
  if (line.status !== "open") throw new BooksError(line.status === "matched" ? "This line is already matched" : "This line is ignored");
  // A closed period would leave a draft behind that can't be saved: refuse first.
  const closed = fromDbDate((await prisma.bkBook.findUniqueOrThrow({ where: { id: book.id }, select: { lockedThrough: true } })).lockedThrough);
  if (closed && fromDbDate(line.date)! <= closed) throw new BooksError(`The books are closed through ${closed}, so this line can't be recorded. Reopen the books, or record it by hand on a later date.`, "date");
  const out = line.amount < 0n;
  const own = out ? -line.amount : line.amount;
  // Growzar: version 1 keeps one currency (D-89); a foreign account's line is recorded on the full form, with its rate.
  const account = await prisma.bkAccount.findUniqueOrThrow({ where: { id: line.accountId } });
  if (account.currency) throw new BooksError(`This account is in ${account.currency}. Record this line on the full form, where you can give the rate.`);
  const amount = own.toString();
  const fx: Record<string, { amount: string }> | undefined = undefined;
  const rateNote = "";
  const type = out ? "expense" : "money_in";
  const base = out ? { paidFrom: line.accountId, lines: [{ accountId: input.accountId, amount, description: null }] } : { receivedIn: line.accountId, lines: [{ accountId: input.accountId, amount, description: null }] };
  const data = fx ? { ...base, fx } : base;
  const { doc, error } = await saveAndPost(
    book,
    {
      type,
      date: fromDbDate(line.date)!,
      contactId: input.contactId || null,
      newContactName: input.contactId ? null : input.newContactName?.trim() || null,
      newContactKind: out ? "supplier" : "customer",
      memo: (line.description.slice(0, 960) + rateNote).trim() || null,
      data,
      // Same line, same key: a double click finds the first entry (keys allow [A-Za-z0-9_-], 8–64 long).
      clientKey: `stmt-line-${line.id}`,
    },
    actor,
  );
  if (error) throw new BooksError(error.message, error.field === "lines.0.accountId" ? "accountId" : error.field);
  const linked = await linkStatementLineToDocument(book, lineId, doc.id);
  if (input.remember) {
    const contactForRule = doc.contactId ?? null;
    const contains = (input.ruleWords ?? ruleWordsFrom(line.description)).trim().slice(0, 60);
    if (contains.length >= 3) {
      await prisma.bkBankRule.upsert({
        where: { bookId_direction_contains: { bookId: book.id, direction: out ? "out" : "in", contains } },
        create: { bookId: book.id, direction: out ? "out" : "in", contains, accountId: input.accountId, contactId: contactForRule },
        update: { accountId: input.accountId, contactId: contactForRule },
      });
    }
  }
  return { documentId: doc.id, number: doc.number, linked };
}

export type SuggestionItem =
  | { lineId: string; kind: "match"; entryLineId: string }
  | { lineId: string; kind: "record"; accountId: string; contactId: string | null; ruleId?: string | null }
  | { lineId: string; kind: "group"; lineIds: string[]; entryLineIds: string[] }
  | { lineId: string; kind: "reversal"; otherLineId: string }
  | { lineId: string; kind: "settle"; items: Array<{ id: string; amount: string }> };

/** Accept several suggestions at once. Each stands alone; every outcome is reported. */
export async function applySuggestions(book: BookView, items: SuggestionItem[], actor: string | null) {
  const results: Array<{ lineId: string; ok: boolean; message?: string }> = [];
  for (const it of items.slice(0, 200)) {
    try {
      if (it.kind === "match") await matchStatementLine(book, it.lineId, it.entryLineId);
      else if (it.kind === "group") await matchGroup(book, it.lineIds, it.entryLineIds);
      else if (it.kind === "reversal") await pairReversal(book, it.lineId, it.otherLineId);
      else if (it.kind === "settle") await settleFromLine(book, { lineId: it.lineId, items: it.items }, actor);
      else await recordFromStatementLine(book, it.lineId, { accountId: it.accountId, contactId: it.contactId, ruleId: it.ruleId ?? null }, actor);
      results.push({ lineId: it.lineId, ok: true });
    } catch (e) {
      if (!(e instanceof BooksError)) console.error("[books] applying a statement suggestion failed", { bookId: book.id, error: e instanceof Error ? e.message : String(e) });
      results.push({ lineId: it.lineId, ok: false, message: e instanceof BooksError ? e.message : "Something went wrong" });
    }
  }
  return results;
}

export function ruleSplit(v: unknown): Array<{ accountId: string; percent: number }> {
  return Array.isArray(v) ? v.filter((x) => x && typeof x.accountId === "string" && typeof x.percent === "number") : [];
}

export async function listBankRules(book: BookView) {
  const rules = await prisma.bkBankRule.findMany({ where: { bookId: book.id }, orderBy: [{ direction: "asc" }, { contains: "asc" }] });
  const [accounts, contacts] = await Promise.all([
    prisma.bkAccount.findMany({ where: { bookId: book.id, id: { in: rules.flatMap((r) => [r.accountId, ...ruleSplit(r.split).map((x) => x.accountId)]) } }, select: { id: true, name: true, archivedAt: true } }),
    prisma.bkContact.findMany({ where: { bookId: book.id, id: { in: rules.map((r) => r.contactId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  return rules.map((r) => {
    const split = ruleSplit(r.split);
    const archived = [r.accountId, ...split.map((x) => x.accountId)].some((id) => accounts.find((a) => a.id === id)?.archivedAt);
    return {
      id: r.id,
      contains: r.contains,
      direction: r.direction,
      kind: r.kind,
      accountId: r.accountId,
      contactId: r.contactId,
      minAmount: r.minAmount,
      maxAmount: r.maxAmount,
      split,
      accountName: r.kind === "transfer" ? `${r.direction === "out" ? "Moved to" : "Moved from"} ${name(r.accountId)}` : split.length ? split.map((x) => `${name(x.accountId)} ${x.percent}%`).join(" + ") : name(r.accountId),
      contactName: contacts.find((c) => c.id === r.contactId)?.name ?? null,
      archived,
    };
  });
}

/** Add or change a rule. */
export async function saveBankRule(
  book: BookView,
  input: { id?: string | null; contains: string; direction: string; kind: string; accountId: string; contactId?: string | null; minAmount?: string | null; maxAmount?: string | null; split?: Array<{ accountId: string; percent: number }> | null },
  actor: string | null,
) {
  const contains = input.contains.replace(/\s+/g, " ").trim().slice(0, 60);
  if (contains.replace(/[^\p{L}]/gu, "").length < 3) throw new BooksError("Give at least one word (3 letters or more) the lines mention", "contains");
  const direction = input.direction === "in" ? "in" : "out";
  const kind = input.kind === "transfer" ? "transfer" : "account";
  const accounts = await prisma.bkAccount.findMany({ where: { bookId: book.id, archivedAt: null } });
  const acc = (id: string) => accounts.find((a) => a.id === id);
  const fits = (id: string) => {
    const a = acc(id);
    if (!a) return false;
    if (kind === "transfer") return isMoneySubtype(a.subtype) && !a.currency;
    return direction === "out" ? a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype)) : a.type === "income" || a.type === "liability" || (a.type === "asset" && !isMoneySubtype(a.subtype));
  };
  const split = kind === "account" && input.split && input.split.length ? input.split.map((x) => ({ accountId: x.accountId, percent: Math.round(Number(x.percent) * 100) / 100 })) : null;
  if (split) {
    const p = splitProblem(split);
    if (p) throw new BooksError(p, "split");
    const bad = split.find((x) => !fits(x.accountId));
    if (bad) throw new BooksError(`"${acc(bad.accountId)?.name ?? "That account"}" can't be used for money ${direction}`, "split");
  }
  const accountId = split ? split[0]!.accountId : input.accountId;
  if (!fits(accountId)) throw new BooksError(kind === "transfer" ? "Choose the other account (bank, cash, wallet or card, in your books' currency)" : `Choose what money ${direction} like this is`, "accountId");
  const amt = (v: string | null | undefined, field: string) => {
    if (v == null || v.trim() === "") return null;
    if (!/^\d+$/.test(v)) throw new BooksError("Enter an amount", field);
    return BigInt(v);
  };
  const minAmount = amt(input.minAmount, "minAmount");
  const maxAmount = amt(input.maxAmount, "maxAmount");
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) throw new BooksError("The smallest amount is more than the largest", "maxAmount");
  const contactId = kind === "account" && input.contactId ? input.contactId : null;
  if (contactId && !(await prisma.bkContact.findFirst({ where: { id: contactId, bookId: book.id } }))) throw new BooksError("That contact doesn't exist", "contactId");
  const data = { contains, direction, kind, accountId, contactId, minAmount, maxAmount, split: (split ?? Prisma.JsonNull) as Prisma.InputJsonValue };
  const clash = await prisma.bkBankRule.findFirst({ where: { bookId: book.id, direction, contains: { equals: contains, mode: "insensitive" }, ...(input.id ? { id: { not: input.id } } : {}) } });
  if (clash) throw new BooksError(`There's already a rule for "${contains}" on money ${direction}`, "contains");
  const rule = input.id ? await prisma.bkBankRule.update({ where: { id: (await prisma.bkBankRule.findFirstOrThrow({ where: { id: input.id, bookId: book.id } })).id }, data }) : await prisma.bkBankRule.create({ data: { bookId: book.id, ...data } });
  await audit(book.id, actor, input.id ? "bank_rule.changed" : "bank_rule.added", { contains, direction, kind });
  return rule;
}

/** Record a line the way a transfer or split rule says. */
async function recordByRule(book: BookView, lineId: string, rule: { kind: string; accountId: string; contactId: string | null; split: unknown }, actor: string | null) {
  if (!/^\d+$/.test(lineId)) throw new BooksError("Line not found");
  const line = await prisma.bkStatementLine.findFirst({ where: { id: BigInt(lineId), bookId: book.id } });
  if (!line) throw new BooksError("Line not found");
  if (line.status !== "open") throw new BooksError(line.status === "matched" ? "This line is already matched" : "This line is ignored");
  const account = await prisma.bkAccount.findUniqueOrThrow({ where: { id: line.accountId } });
  if (account.currency) throw new BooksError(`This account is in ${account.currency}: record it with the full form`);
  const closed = fromDbDate((await prisma.bkBook.findUniqueOrThrow({ where: { id: book.id }, select: { lockedThrough: true } })).lockedThrough);
  if (closed && fromDbDate(line.date)! <= closed) throw new BooksError(`The books are closed through ${closed}, so this line can't be recorded.`, "date");
  const out = line.amount < 0n;
  const size = out ? -line.amount : line.amount;
  let input: Parameters<typeof saveAndPost>[1];
  if (rule.kind === "transfer") {
    if (rule.accountId === line.accountId) throw new BooksError("A transfer rule can't move money to the same account");
    input = { type: "transfer", date: fromDbDate(line.date)!, memo: line.description.slice(0, 960) || null, data: { from: out ? line.accountId : rule.accountId, to: out ? rule.accountId : line.accountId, amount: size.toString() }, clientKey: `stmt-line-${line.id}` };
  } else {
    const parts = splitAmounts(size, ruleSplit(rule.split));
    const lines = parts.map((p) => ({ accountId: p.accountId, amount: p.amount.toString(), description: null }));
    input = { type: out ? "expense" : "money_in", date: fromDbDate(line.date)!, contactId: rule.contactId, memo: line.description.slice(0, 960) || null, data: out ? { paidFrom: line.accountId, lines } : { receivedIn: line.accountId, lines }, clientKey: `stmt-line-${line.id}` };
  }
  const { doc, error } = await saveAndPost(book, input, actor);
  if (error) throw new BooksError(error.message, error.field);
  const linked = await linkStatementLineToDocument(book, lineId, doc.id);
  return { documentId: doc.id, number: doc.number, linked };
}

export async function deleteBankRule(book: BookView, id: string) {
  await prisma.bkBankRule.deleteMany({ where: { id, bookId: book.id } });
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/** Sum of lines cleared in finished reconciliations of an account (ledger sign). */
async function clearedBefore(book: BookView, accountId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const r = await tx.$queryRaw<Array<{ s: bigint | null }>>`
    SELECT SUM(c.amount)::bigint AS s FROM bk_cleared_lines c
      JOIN bk_reconciliations r ON r.id = c."reconciliationId" AND r.status = 'done'
     WHERE c."bookId" = ${book.id} AND c."accountId" = ${accountId}`;
  return r[0]?.s ?? 0n;
}

/**
 * Start (or change the statement date and balance of) the reconciliation in
 * progress. The balance is as the statement shows it (what's in the account,
 * or for a card what you owe). Lines already matched to the statement, and
 * cancelled pairs, start ticked.
 */
export async function startReconciliation(book: BookView, accountId: string, statementDate: string, shownBalance: bigint, actor: string | null) {
  const account = await moneyAccount(book, accountId);
  if (!isIsoDate(statementDate)) throw new BooksError("Choose the statement's end date", "statementDate");
  const ledgerBalance = naturalBalance(account.type, shownBalance); // natural ↔ ledger is its own inverse
  return prisma.$transaction(async (tx) => {
    const last = await tx.bkReconciliation.findFirst({ where: { bookId: book.id, accountId, status: "done" }, orderBy: { statementDate: "desc" } });
    if (last && fromDbDate(last.statementDate)! >= statementDate) throw new BooksError(`This account is reconciled through ${fromDbDate(last.statementDate)}. Choose a later statement date.`, "statementDate");
    const open = await tx.bkReconciliation.findFirst({ where: { bookId: book.id, accountId, status: "open" } });
    const rec = open
      ? await tx.bkReconciliation.update({ where: { id: open.id }, data: { statementDate: toDbDate(statementDate), statementBalance: ledgerBalance } })
      : await tx.bkReconciliation.create({ data: { bookId: book.id, accountId, statementDate: toDbDate(statementDate), statementBalance: ledgerBalance, createdBy: actor } });
    // Lines ticked earlier but now after the statement date come off.
    if (open) {
      await tx.$executeRaw`
        DELETE FROM bk_cleared_lines c USING bk_entry_lines l
         WHERE c."reconciliationId" = ${rec.id} AND l.id = c."entryLineId" AND l.date > ${toDbDate(statementDate)}`;
    }
    // Start with what the statement already confirmed, and cancelled pairs (they cancel out).
    await tx.$executeRaw`
      INSERT INTO bk_cleared_lines ("entryLineId", "bookId", "accountId", "reconciliationId", amount)
      SELECT l.id, l."bookId", l."accountId", ${rec.id}, COALESCE(l."fxAmount", l.amount)
        FROM bk_entry_lines l
        JOIN bk_entries e ON e.id = l."entryId"
        JOIN bk_documents d ON d.id = e."documentId"
       WHERE l."bookId" = ${book.id} AND l."accountId" = ${accountId} AND l.date <= ${toDbDate(statementDate)}
         AND NOT EXISTS (SELECT 1 FROM bk_cleared_lines c WHERE c."entryLineId" = l.id)
         AND (
           EXISTS (SELECT 1 FROM bk_statement_lines s WHERE s."entryLineId" = l.id AND s.date <= ${toDbDate(statementDate)})
           OR EXISTS (SELECT 1 FROM bk_statement_matches m
                       WHERE m."entryLineId" = l.id
                         AND NOT EXISTS (SELECT 1 FROM bk_statement_lines s WHERE s."bookId" = m."bookId" AND s."matchGroup" = m."groupId" AND s.date > ${toDbDate(statementDate)}))
           OR (d.status = 'cancelled' AND NOT EXISTS (
                SELECT 1 FROM bk_entry_lines l2 JOIN bk_entries e2 ON e2.id = l2."entryId"
                 WHERE e2."documentId" = d.id AND l2."accountId" = ${accountId} AND l2.date > ${toDbDate(statementDate)}))
         )
      ON CONFLICT DO NOTHING`;
    if (!open) await audit(book.id, actor, "reconciliation.started", { accountId, name: account.name, statementDate }, tx);
    return rec.id;
  });
}

export async function reconciliationView(book: BookView, recId: string) {
  const rec = await prisma.bkReconciliation.findFirst({ where: { id: recId, bookId: book.id } });
  if (!rec) throw new BooksError("Reconciliation not found");
  const account = await prisma.bkAccount.findUniqueOrThrow({ where: { id: rec.accountId } });
  const statementDate = fromDbDate(rec.statementDate)!;
  const [previous, rows] = await Promise.all([
    clearedBefore(book, rec.accountId),
    prisma.$queryRaw<Array<{ id: bigint; date: Date; amount: bigint; documentId: string; kind: string; number: string | null; type: string; memo: string | null; contactId: string | null; ticked: boolean; matched: boolean }>>`
      SELECT l.id, l.date, COALESCE(l."fxAmount", l.amount) AS amount, e."documentId", e.kind, d.number, d.type, d.memo, d."contactId",
             (c."reconciliationId" IS NOT NULL) AS ticked,
             (EXISTS (SELECT 1 FROM bk_statement_lines s WHERE s."entryLineId" = l.id) OR EXISTS (SELECT 1 FROM bk_statement_matches m WHERE m."entryLineId" = l.id)) AS matched
        FROM bk_entry_lines l
        JOIN bk_entries e ON e.id = l."entryId"
        JOIN bk_documents d ON d.id = e."documentId"
        LEFT JOIN bk_cleared_lines c ON c."entryLineId" = l.id AND c."reconciliationId" = ${rec.id}
       WHERE l."bookId" = ${book.id} AND l."accountId" = ${rec.accountId} AND l.date <= ${rec.statementDate}
         AND NOT EXISTS (SELECT 1 FROM bk_cleared_lines c2 JOIN bk_reconciliations r2 ON r2.id = c2."reconciliationId" AND r2.status = 'done' WHERE c2."entryLineId" = l.id)
       ORDER BY l.date, l.id
       LIMIT 3000`,
  ]);
  const contacts = await prisma.bkContact.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.contactId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const ticked = rows.filter((r) => r.ticked).map((r) => r.amount);
  const f = reconcileFigures(rec.statementBalance, previous, ticked);
  const nat = (v: bigint) => naturalBalance(account.type, v);
  return {
    id: rec.id,
    status: rec.status,
    account: { id: account.id, name: account.name, type: account.type, subtype: account.subtype },
    statementDate,
    statementBalance: nat(rec.statementBalance),
    previous: nat(previous),
    cleared: nat(f.cleared),
    difference: nat(f.difference),
    truncated: rows.length >= 3000,
    lines: rows.map((r) => ({
      id: r.id.toString(),
      date: fromDbDate(r.date)!,
      amount: r.amount,
      documentId: r.documentId,
      number: r.number,
      kind: (DOC_LABELS[r.type as DocType] ?? r.type) + (r.kind === "cancel" ? " (cancellation)" : ""),
      memo: r.memo,
      contactName: r.contactId ? contacts.find((c) => c.id === r.contactId)?.name ?? null : null,
      ticked: r.ticked,
      matched: r.matched,
    })),
  };
}

export async function setCleared(book: BookView, recId: string, entryLineIds: string[], cleared: boolean) {
  const ids = entryLineIds.slice(0, 5000).map((x) => {
    try {
      return BigInt(x);
    } catch {
      throw new BooksError("Line not found");
    }
  });
  await prisma.$transaction(async (tx) => {
    const rec = await tx.bkReconciliation.findFirst({ where: { id: recId, bookId: book.id } });
    if (!rec) throw new BooksError("Reconciliation not found");
    if (rec.status !== "open") throw new BooksError("This reconciliation is finished");
    if (!cleared) {
      await tx.bkClearedLine.deleteMany({ where: { reconciliationId: rec.id, entryLineId: { in: ids } } });
      return;
    }
    await tx.$executeRaw`
      INSERT INTO bk_cleared_lines ("entryLineId", "bookId", "accountId", "reconciliationId", amount)
      SELECT l.id, l."bookId", l."accountId", ${rec.id}, COALESCE(l."fxAmount", l.amount) FROM bk_entry_lines l
       WHERE l.id = ANY(${ids}) AND l."bookId" = ${book.id} AND l."accountId" = ${rec.accountId} AND l.date <= ${rec.statementDate}
      ON CONFLICT DO NOTHING`;
  });
}

export async function finishReconciliation(book: BookView, recId: string, actor: string | null) {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM bk_reconciliations WHERE id = ${recId} AND "bookId" = ${book.id} FOR UPDATE`;
    if (!rows.length) throw new BooksError("Reconciliation not found");
    const rec = await tx.bkReconciliation.findUniqueOrThrow({ where: { id: recId } });
    if (rec.status !== "open") throw new BooksError("This reconciliation is already finished");
    const previous = await clearedBefore(book, rec.accountId, tx);
    const mine = await tx.bkClearedLine.aggregate({ where: { reconciliationId: rec.id }, _sum: { amount: true } });
    const f = reconcileFigures(rec.statementBalance, previous, [mine._sum.amount ?? 0n]);
    if (f.difference !== 0n) throw new BooksError("The books and the statement don't agree yet. Tick the entries the statement shows until the difference is zero.");
    await tx.bkReconciliation.update({ where: { id: rec.id }, data: { status: "done", finishedAt: new Date() } });
    const account = await tx.bkAccount.findUniqueOrThrow({ where: { id: rec.accountId } });
    await audit(book.id, actor, "reconciliation.finished", { accountId: rec.accountId, name: account.name, statementDate: fromDbDate(rec.statementDate), balance: naturalBalance(account.type, rec.statementBalance).toString() }, tx);
  });
}

/** Stop a reconciliation in progress (nothing is lost but the ticks). */
export async function discardReconciliation(book: BookView, recId: string) {
  await prisma.bkReconciliation.deleteMany({ where: { id: recId, bookId: book.id, status: "open" } });
}

/** Reopen the latest finished reconciliation of an account, with a reason for the activity log. */
export async function undoLastReconciliation(book: BookView, accountId: string, reason: string, actor: string | null) {
  const why = reason.trim().slice(0, 500);
  if (!why) throw new BooksError("Say briefly why", "reason");
  await prisma.$transaction(async (tx) => {
    const open = await tx.bkReconciliation.findFirst({ where: { bookId: book.id, accountId, status: "open" } });
    if (open) throw new BooksError("Finish or stop the reconciliation in progress first");
    const last = await tx.bkReconciliation.findFirst({ where: { bookId: book.id, accountId, status: "done" }, orderBy: { statementDate: "desc" } });
    if (!last) throw new BooksError("Nothing reconciled yet");
    await tx.bkReconciliation.update({ where: { id: last.id }, data: { status: "open", finishedAt: null } });
    await audit(book.id, actor, "reconciliation.undone", { accountId, statementDate: fromDbDate(last.statementDate), reason: why }, tx);
  });
}

// ── Matching several at once ─────────────────────────────────────────────────

/**
 * Match statement lines and ledger entries together when their totals agree:
 * one deposit for several entries, one entry paid in several lines, or a pair
 * of lines that cancel each other (no entries at all). All on one account,
 * none matched already.
 */
export async function matchGroup(book: BookView, lineIds: string[], entryLineIds: string[], client?: Prisma.TransactionClient): Promise<string> {
  const lids = [...new Set(lineIds)];
  const eids = [...new Set(entryLineIds)];
  if (lids.length === 0) throw new BooksError("Choose the statement lines");
  if (lids.length + eids.length > 30) throw new BooksError("Match at most 30 lines and entries at once");
  if (![...lids, ...eids].every((x) => /^\d+$/.test(x))) throw new BooksError("Line not found");
  const run = async (tx: Prisma.TransactionClient) => {
    const lines = [];
    for (const id of lids.sort()) lines.push(await lockLine(tx, book, id));
    const accountId = lines[0]!.accountId;
    for (const l of lines) {
      if (l.accountId !== accountId) throw new BooksError("Those lines are on different accounts");
      if (l.status !== "open") throw new BooksError(l.status === "matched" ? "One of the lines is already matched" : "One of the lines is ignored — bring it back first");
    }
    const ledger = await tx.bkEntryLine.findMany({ where: { bookId: book.id, id: { in: eids.map((x) => BigInt(x)) } }, include: { entry: { select: { kind: true, documentId: true } } } });
    if (ledger.length !== eids.length) throw new BooksError("One of those entries isn't there any more");
    const docs = await tx.bkDocument.findMany({ where: { id: { in: [...new Set(ledger.map((l) => l.entry.documentId))] } }, select: { id: true, status: true } });
    for (const l of ledger) {
      if (l.accountId !== accountId) throw new BooksError("One of those entries isn't on this account");
      if (l.entry.kind !== "post") throw new BooksError("A cancellation can't be matched");
      if (docs.find((d) => d.id === l.entry.documentId)?.status !== "posted") throw new BooksError("One of those entries has been cancelled");
    }
    const claimed = (await tx.bkStatementLine.count({ where: { entryLineId: { in: ledger.map((l) => l.id) } } })) + (await tx.bkStatementMatch.count({ where: { entryLineId: { in: ledger.map((l) => l.id) } } }));
    if (claimed) throw new BooksError("One of those entries is already matched to another statement line");
    const sumS = lines.reduce((s, l) => s + l.amount, 0n);
    const sumL = ledger.reduce((s, l) => s + (l.fxAmount ?? l.amount), 0n);
    if (sumS !== sumL) throw new BooksError("The lines and entries don't add up to the same amount");
    if (eids.length === 0 && lines.length < 2) throw new BooksError("Choose the entries this line is");
    const groupId = randomUUID();
    if (ledger.length) await tx.bkStatementMatch.createMany({ data: ledger.map((l) => ({ bookId: book.id, groupId, entryLineId: l.id })) });
    await tx.bkStatementLine.updateMany({ where: { bookId: book.id, id: { in: lines.map((l) => l.id) } }, data: { status: "matched", matchGroup: groupId, documentId: ledger[0]?.entry.documentId ?? null, matchedAt: new Date() } });
    return groupId;
  };
  if (client) return run(client);
  return prisma.$transaction(run).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new BooksError("One of those entries is already matched to another statement line");
    throw e;
  });
}

/** Two lines that cancel each other (a payment and its reversal): matched to each other, nothing to record. */
export async function pairReversal(book: BookView, a: string, b: string) {
  return matchGroup(book, [a, b], []);
}

/**
 * Match a line to an entry that's nearly it, and record the difference —
 * a fee or tax the bank or gateway took, or rounding. The difference goes to
 * the account chosen (bank charges, gateway fees, tax withheld…) as its own
 * entry on the line's date; the line then matches the entry and the
 * difference together.
 */
export async function matchWithDifference(book: BookView, input: { lineId: string; entryLineId: string; accountId: string; contactId?: string | null }, actor: string | null) {
  if (!/^\d+$/.test(input.lineId) || !/^\d+$/.test(input.entryLineId)) throw new BooksError("Line not found");
  const line = await prisma.bkStatementLine.findFirst({ where: { id: BigInt(input.lineId), bookId: book.id } });
  if (!line) throw new BooksError("Line not found");
  if (line.status !== "open") throw new BooksError(line.status === "matched" ? "This line is already matched" : "This line is ignored");
  const account = await prisma.bkAccount.findUniqueOrThrow({ where: { id: line.accountId } });
  if (account.currency) throw new BooksError(`This account is in ${account.currency}: record the difference with the full form, then match both entries`);
  const ledger = await prisma.bkEntryLine.findFirst({ where: { id: BigInt(input.entryLineId), bookId: book.id }, include: { entry: { select: { kind: true, documentId: true } } } });
  if (!ledger || ledger.accountId !== line.accountId || ledger.entry.kind !== "post") throw new BooksError("That entry isn't on this account");
  if ((await prisma.bkStatementLine.count({ where: { entryLineId: ledger.id } })) + (await prisma.bkStatementMatch.count({ where: { entryLineId: ledger.id } }))) throw new BooksError("That entry is already matched to another statement line");
  if (ledger.amount < 0n !== line.amount < 0n) throw new BooksError("The entry goes the other way");
  const diff = line.amount - ledger.amount;
  if (diff === 0n) return { documentId: null, groupId: await matchGroup(book, [input.lineId], [input.entryLineId]) };
  const abs = diff < 0n ? -diff : diff;
  if (abs * 2n > (line.amount < 0n ? -line.amount : line.amount)) throw new BooksError("The difference is more than half the line — that's not the same payment");
  const closed = fromDbDate((await prisma.bkBook.findUniqueOrThrow({ where: { id: book.id }, select: { lockedThrough: true } })).lockedThrough);
  if (closed && fromDbDate(line.date)! <= closed) throw new BooksError(`The books are closed through ${closed}`);
  // Less arrived (or more went out): a cost. More arrived: money in.
  const out = diff < 0n;
  const { doc, error } = await saveAndPost(
    book,
    {
      type: out ? "expense" : "money_in",
      date: fromDbDate(line.date)!,
      contactId: input.contactId || null,
      memo: `Difference on "${line.description.slice(0, 120)}"`,
      data: out ? { paidFrom: line.accountId, lines: [{ accountId: input.accountId, amount: abs.toString(), description: null }] } : { receivedIn: line.accountId, lines: [{ accountId: input.accountId, amount: abs.toString(), description: null }] },
      clientKey: `stmt-diff-${line.id}`,
    },
    actor,
  );
  if (error) throw new BooksError(error.message, error.field?.startsWith("lines.0.accountId") ? "accountId" : error.field);
  const diffLine = await prisma.bkEntryLine.findFirst({ where: { bookId: book.id, accountId: line.accountId, entry: { documentId: doc.id, kind: "post" } } });
  if (!diffLine) throw new BooksError("The difference was saved but couldn't be matched — match it by hand");
  try {
    return { documentId: doc.id, groupId: await matchGroup(book, [input.lineId], [input.entryLineId, diffLine.id.toString()]) };
  } catch (e) {
    if (e instanceof BooksError) throw new BooksError(`The difference was saved as ${doc.number}, but matching failed: ${e.message}`);
    throw e;
  }
}

// ── Settling bills, invoices and payouts from a line ────────────────────────

/** What a line could be paying or collecting: open bills (money out) or open invoices and courier payouts (money in). */
export async function settleChoices(book: BookView, lineId: string) {
  if (!/^\d+$/.test(lineId)) throw new BooksError("Line not found");
  const line = await prisma.bkStatementLine.findFirst({ where: { id: BigInt(lineId), bookId: book.id } });
  if (!line) throw new BooksError("Line not found");
  const out = line.amount < 0n;
  const amount = out ? -line.amount : line.amount;
  const { listBills } = await import("./books.server");
  const open = await listBills(book, { open: true, type: out ? "bill" : "invoice" });
  const near = (v: bigint) => (v > amount ? v - amount : amount - v);
  const docs = open
    .map((b) => ({ id: b.id, number: b.number, date: b.date, dueDate: b.dueDate, contactId: b.contactId, contactName: b.contactName, open: b.open, exact: b.open === amount }))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || (near(a.open) < near(b.open) ? -1 : near(a.open) > near(b.open) ? 1 : 0))
    .slice(0, 50);
  // Growzar's courier-payout connector posts every Courierify payout; a payout's bank line is matched to it, not recorded here.
  const payouts: Array<{ ref: string; courier: string; day: string; parcels: number; net: bigint }> = [];
  return { out, amount, docs, payouts };
}

/**
 * Pay bills (money out) or collect invoices (money in) with a statement line.
 * What's settled = the line + any tax withheld; one supplier or customer at
 * a time. The payment is saved and matched to the line.
 */
export async function settleFromLine(book: BookView, input: { lineId: string; items: Array<{ id: string; amount: string }>; withheld?: { accountId: string; amount: string } | null }, actor: string | null) {
  if (!/^\d+$/.test(input.lineId)) throw new BooksError("Line not found");
  const line = await prisma.bkStatementLine.findFirst({ where: { id: BigInt(input.lineId), bookId: book.id } });
  if (!line) throw new BooksError("Line not found");
  if (line.status !== "open") throw new BooksError(line.status === "matched" ? "This line is already matched" : "This line is ignored");
  const account = await prisma.bkAccount.findUniqueOrThrow({ where: { id: line.accountId } });
  if (account.currency) throw new BooksError(`This account is in ${account.currency}: settle bills from accounts in ${book.currency}`);
  const out = line.amount < 0n;
  const amount = out ? -line.amount : line.amount;
  const items = input.items.filter((i) => i.id && /^\d+$/.test(i.amount) && BigInt(i.amount) > 0n);
  if (items.length === 0) throw new BooksError(`Choose the ${out ? "bills" : "invoices"} this pays`);
  const { listBills } = await import("./books.server");
  const open = await listBills(book, { open: true, type: out ? "bill" : "invoice", ids: items.map((i) => i.id) });
  const docs = await prisma.bkDocument.findMany({ where: { bookId: book.id, id: { in: items.map((i) => i.id) } }, select: { id: true, data: true, contactId: true } });
  const contacts = new Set(docs.map((d) => d.contactId));
  if (contacts.size !== 1 || !docs[0]?.contactId) throw new BooksError(`Choose ${out ? "bills from one supplier" : "invoices for one customer"} at a time`);
  for (const i of items) {
    const b = open.find((x) => x.id === i.id);
    if (!b) throw new BooksError(`One of those ${out ? "bills" : "invoices"} is already paid or cancelled`);
    if (BigInt(i.amount) > b.open) throw new BooksError(`${b.number} only has ${formatAmount(b.open, book.decimals)} left to pay`);
  }
  const settled = items.reduce((s, i) => s + BigInt(i.amount), 0n);
  const withheld = input.withheld && /^\d+$/.test(input.withheld.amount) && BigInt(input.withheld.amount) > 0n ? input.withheld : null;
  if (settled !== amount + (withheld ? BigInt(withheld.amount) : 0n)) throw new BooksError(`What's settled (${formatAmount(settled, book.decimals)}) has to be the line (${formatAmount(amount, book.decimals)})${withheld ? " plus the tax withheld" : ""}`);
  const control = String((docs[0].data as Record<string, unknown>)[out ? "payable" : "receivable"] ?? "");
  const data = out
    ? { payable: control, paidFrom: line.accountId, allocations: items.map((i) => ({ billId: i.id, amount: i.amount })), withheld: withheld ? { accountId: withheld.accountId, amount: withheld.amount } : null }
    : { receivable: control, receivedIn: line.accountId, allocations: items.map((i) => ({ billId: i.id, amount: i.amount })), withheld: withheld ? { accountId: withheld.accountId, amount: withheld.amount } : null };
  const { doc, error } = await saveAndPost(book, { type: out ? "bill_payment" : "customer_payment", date: fromDbDate(line.date)!, contactId: docs[0].contactId, memo: line.description.slice(0, 960) || null, data, clientKey: `stmt-settle-${line.id}` }, actor);
  if (error) throw new BooksError(error.message, error.field);
  const linked = await linkStatementLineToDocument(book, input.lineId, doc.id);
  return { documentId: doc.id, number: doc.number, linked };
}

/** An open statement line a form was opened from (?statementLine=…), to prefill it; null otherwise. */
export async function statementLinePrefill(book: BookView, url: URL) {
  const id = url.searchParams.get("statementLine");
  if (!id || !/^\d+$/.test(id)) return null;
  const l = await prisma.bkStatementLine.findFirst({ where: { id: BigInt(id), bookId: book.id, status: "open" } });
  if (!l) return null;
  const a = await prisma.bkAccount.findUnique({ where: { id: l.accountId }, select: { currency: true, name: true } });
  if (a?.currency) return null; // these forms work in the book's currency
  return { id: l.id.toString(), accountId: l.accountId, accountName: a?.name ?? "", date: fromDbDate(l.date)!, amount: l.amount < 0n ? -l.amount : l.amount, out: l.amount < 0n, description: l.description };
}
