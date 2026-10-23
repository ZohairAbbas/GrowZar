/**
 * Books service layer: the only code that writes Books tables.
 *
 * Every write that touches the ledger runs in one transaction: lock the
 * document, build lines with the pure engine (posting.ts), take the next
 * number, insert the entry, mark the document, record the audit event. The
 * database re-checks at commit that each entry sums to zero and refuses any
 * UPDATE or DELETE of posted history (migration 20261008000000_books_m1).
 *
 * Books never imports dashboard, cashflow or ledger code, and nothing there
 * imports Books.
 *
 * Growzar: one book per organization (D-65). A document may name the store it
 * belongs to; its entry lines carry that store, so every report can be per
 * store or combined. Organization-level items (rent) have no store.
 */

import { Prisma, type BkAccount, type BkBook, type BkDocument } from "@prisma/client";
import { prisma } from "~/lib/db.server";
import { CHART_TEMPLATE, MONEY_KINDS, isMoneySubtype, nextCode, CODE_BASE_FOR_TYPE, SUBTYPES_FOR_TYPE, type AccountType, type SystemKey } from "./chart";
import { CONTACT_KINDS, type ContactKind } from "./contacts";
import { MAX_APPROVE } from "./limits";
import { currencyDecimals } from "./money";
import {
  BooksError,
  DOC_PREFIX,
  addDays,
  buildPosting,
  cancelDateFor,
  fiscalYearStart,
  isDocType,
  isIsoDate,
  isOpenDate,
  mirrorLines,
  realiseExchange,
  type AccountInfo,
  type DocType,
  type Posting,
  type PostingContext,
  type PostingLine,
} from "./posting";
import type { ReportAccount } from "./reports";

type Tx = Prisma.TransactionClient;

/** JSON with object keys sorted at every level, for equality checks. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(norm) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(norm(v));
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export { BooksError, MAX_APPROVE };
export { CONTACT_KINDS, CONTACT_KIND_LABELS, type ContactKind } from "./contacts";

// ── Dates ────────────────────────────────────────────────────────────────────

export function toDbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function fromDbDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

// ── Book ─────────────────────────────────────────────────────────────────────

export interface BookView {
  id: string;
  organizationId: string;
  currency: string;
  decimals: number;
  fiscalYearStartMonth: number;
  lockedThrough: string | null;
  settings: BookSettings;
}

export interface BookSettings {
  /** The merchant's time zone (from their browser at setup); decides "today". */
  timeZone?: string;
  /** Last money account used to pay an expense; offered first next time. */
  lastPaidFrom?: string;
  lastReceivedIn?: string;
  /** Accountant view per staff user ("_" when the session has no user). */
  accountantView?: Record<string, boolean>;
  /** Product tours each staff user has seen or skipped (by tour id). */
  toursSeen?: Record<string, string[]>;
  /** Staff users who hid the getting-started list on Home. */
  gettingStartedHidden?: Record<string, boolean>;
  /** How tax a courier keeps from a settlement is booked: a cost (default) or claimable. */
  courierTax?: { withheld?: "expense" | "claimable"; salesTax?: "expense" | "claimable" };
  /** Growzar (D-75): the day the books start; connectors bring things in from it. */
  startDate?: string;
  /** Growzar (D-65, D-89): the organization's stores these books cover. */
  storeIds?: string[];
  /** Growzar (D-69, D-83): when a cash-on-delivery sale counts. */
  codBasis?: "delivery" | "money" | "order" | "dispatch";
  /** Growzar (D-70): a close an accountant prepared, waiting for an owner or admin to confirm. */
  preparedClose?: { through: string; by: string | null; at: string; note?: string };
  /** Growzar (B5): each bank account's statement columns, as last chosen, offered for its next file. */
  statementMappings?: Record<string, import("./statement-csv").StatementMapping>;
}

function view(b: BkBook): BookView {
  return {
    id: b.id,
    organizationId: b.organizationId,
    currency: b.currency,
    decimals: b.currencyDecimals,
    fiscalYearStartMonth: b.fiscalYearStartMonth,
    lockedThrough: fromDbDate(b.lockedThrough),
    settings: (b.settings ?? {}) as BookSettings,
  };
}

export async function getBook(organizationId: string): Promise<BookView | null> {
  const b = await prisma.bkBook.findUnique({ where: { organizationId } });
  return b ? view(b) : null;
}

export interface SetupInput {
  currency: string;
  timeZone?: string | null;
  fiscalYearStartMonth: number;
  /** The day opening balances are as of (usually today). */
  startDate: string;
  moneyAccounts: Array<{ subtype: string; name: string; opening: bigint }>;
  /** Growzar: settings saved with the book in the same transaction (start date, stores, COD basis). */
  settings?: Pick<BookSettings, "startDate" | "storeIds" | "codBasis">;
}

/**
 * Create the book, the template chart, the merchant's money accounts and (if
 * any balance was given) a posted Opening balances document.
 */
export async function setupBook(organizationId: string, input: SetupInput, actor: string | null): Promise<BookView> {
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new BooksError("Choose a currency", "currency");
  if (!(input.fiscalYearStartMonth >= 1 && input.fiscalYearStartMonth <= 12)) throw new BooksError("Choose a month", "fiscalYearStartMonth");
  if (!isIsoDate(input.startDate)) throw new BooksError("Choose a date", "startDate");
  const money = input.moneyAccounts.filter((m) => m.name.trim());
  if (money.length === 0) throw new BooksError("Add at least one place where you keep money", "moneyAccounts");
  for (const m of money) {
    if (!MONEY_KINDS.some((k) => k.subtype === m.subtype)) throw new BooksError("Choose what kind of account this is", "moneyAccounts");
  }
  const names = money.map((m) => m.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) throw new BooksError("Two accounts have the same name", "moneyAccounts");
  if (money.some((m) => m.name.trim().length > 120)) throw new BooksError("One of the names is too long", "moneyAccounts");
  const clash = money.find((m) => CHART_TEMPLATE.some((t) => t.name.toLowerCase() === m.name.trim().toLowerCase()));
  if (clash) throw new BooksError(`"${clash.name.trim()}" is already one of Books' accounts. Choose another name.`, "moneyAccounts");

  try {
    return await setupInTx(organizationId, input, currency, money, actor);
  } catch (e) {
    // Two setups at once (double click, two tabs): the loser returns the winner's book.
    if (isUniqueViolation(e)) {
      const existing = await getBook(organizationId);
      if (existing) return existing;
    }
    throw e;
  }
}

async function setupInTx(organizationId: string, input: SetupInput, currency: string, money: SetupInput["moneyAccounts"], actor: string | null): Promise<BookView> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.bkBook.findUnique({ where: { organizationId } });
    if (existing) return view(existing);

    const book = await tx.bkBook.create({
      data: {
        organizationId,
        currency,
        currencyDecimals: currencyDecimals(currency),
        fiscalYearStartMonth: input.fiscalYearStartMonth,
        settings: { ...(input.timeZone ? { timeZone: input.timeZone } : {}), ...(input.settings ?? {}) } as Prisma.InputJsonValue,
      },
    });
    await tx.bkAccount.createMany({
      data: CHART_TEMPLATE.map((t) => ({ bookId: book.id, code: t.code, name: t.name, type: t.type, subtype: t.subtype, systemKey: t.systemKey ?? null })),
    });

    const used = new Set(CHART_TEMPLATE.map((t) => t.code));
    const openingLines: Array<{ accountId: string; amount: string }> = [];
    for (const m of money) {
      const kind = MONEY_KINDS.find((k) => k.subtype === m.subtype)!;
      const code = nextCode(used, kind.codeBase, 9);
      used.add(code);
      const acc = await tx.bkAccount.create({
        data: { bookId: book.id, code, name: m.name.trim(), type: kind.type, subtype: kind.subtype },
      });
      if (m.opening !== 0n) openingLines.push({ accountId: acc.id, amount: m.opening.toString() });
    }

    await audit(tx, book.id, actor, "book.created", null, { currency, fiscalYearStartMonth: input.fiscalYearStartMonth, moneyAccounts: money.length });

    if (openingLines.length > 0) {
      const doc = await tx.bkDocument.create({
        data: { bookId: book.id, type: "opening", date: toDbDate(input.startDate), data: { lines: openingLines }, memo: "Balances when you started using Books", createdBy: actor },
      });
      await postInTx(tx, view(book), doc.id, actor);
    }
    return view(book);
  });
}

/** Merge into settings, reading the stored value first so concurrent saves don't drop each other's keys. */
export async function updateBookSettings(book: BookView, patch: Partial<BookSettings> | ((current: BookSettings) => Partial<BookSettings>)): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bk_books WHERE id = ${book.id} FOR UPDATE`;
    const cur = await tx.bkBook.findUniqueOrThrow({ where: { id: book.id }, select: { settings: true } });
    const current = (cur.settings ?? {}) as BookSettings;
    // A function patch is worked out from the stored settings, under the lock (per-staff maps).
    const merged = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
    await tx.bkBook.update({ where: { id: book.id }, data: { settings: merged as Prisma.InputJsonValue } });
  });
}

export async function updateFiscalYear(book: BookView, month: number, actor: string | null): Promise<void> {
  if (!(month >= 1 && month <= 12)) throw new BooksError("Choose a month", "fiscalYearStartMonth");
  await prisma.$transaction(async (tx) => {
    await tx.bkBook.update({ where: { id: book.id }, data: { fiscalYearStartMonth: month } });
    await audit(tx, book.id, actor, "book.fiscal_year_changed", null, { from: book.fiscalYearStartMonth, to: month });
  });
}

// ── Closing the books ────────────────────────────────────────────────────────

/** What would be left behind by closing the books through a date. */
export interface CloseCheck {
  /** Drafts dated on or before the date: they can't be saved once it's closed. */
  drafts: number;
  /** Switched-on connectors that haven't brought everything in up to the date. */
  behind: Array<{ key: string; syncedThrough: string | null }>;
}

export async function closeCheck(book: BookView, through: string): Promise<CloseCheck> {
  if (!isIsoDate(through)) throw new BooksError("Choose a date", "through");
  const [drafts, connectors] = await Promise.all([
    prisma.bkDocument.count({ where: { bookId: book.id, status: "draft", date: { lte: toDbDate(through) } } }),
    prisma.bkConnector.findMany({ where: { bookId: book.id, enabled: true, key: { in: ["shopify_sales", "courierify_payouts", "ad_spend", "inventorify"] } }, select: { key: true, syncedThrough: true, startDate: true } }),
  ]);
  const behind = connectors
    // A connector that starts after the date has nothing to bring in for it.
    .filter((c) => !(c.startDate && fromDbDate(c.startDate)! > through))
    .filter((c) => !c.syncedThrough || fromDbDate(c.syncedThrough)! < through)
    .map((c) => ({ key: c.key, syncedThrough: fromDbDate(c.syncedThrough) }));
  return { drafts, behind };
}

/**
 * Close the books through a date (nothing can be saved or cancelled on or
 * before it), move the date, or reopen (`through` null). Moving it back
 * reopens days and needs a reason, which goes in the activity log.
 */
export async function setClosedThrough(book: BookView, through: string | null, today: string, actor: string | null, reason?: string | null): Promise<string | null> {
  if (through !== null && !isIsoDate(through)) throw new BooksError("Choose a date", "through");
  if (through !== null && through > today) throw new BooksError("You can only close days that have already happened.", "through");
  const why = (reason ?? "").trim().slice(0, 500);
  return prisma.$transaction(async (tx) => {
    // Waits for any posting in progress (they hold a share lock on this row).
    const rows = await tx.$queryRaw<Array<{ l: Date | null }>>`SELECT "lockedThrough" AS l FROM bk_books WHERE id = ${book.id} FOR NO KEY UPDATE`;
    if (rows.length === 0) throw new BooksError("Books not found");
    const current = fromDbDate(rows[0]!.l);
    if (through === current) throw new BooksError(through ? `The books are already closed through ${through}.` : "The books are already open.", "through");
    const reopening = current !== null && (through === null || through < current);
    if (reopening && !why) throw new BooksError("Say briefly why you're reopening — it's kept in the activity log.", "reason");
    // Growzar (D-70): a close prepared for these days is done once they're closed.
    const settings = ((await tx.bkBook.findUniqueOrThrow({ where: { id: book.id }, select: { settings: true } })).settings ?? {}) as BookSettings;
    const { preparedClose: done, ...rest } = settings;
    const prepared = done && through && done.through <= through ? { settings: rest as Prisma.InputJsonValue } : {};
    await tx.bkBook.update({ where: { id: book.id }, data: { lockedThrough: through ? toDbDate(through) : null, ...prepared } });
    await audit(tx, book.id, actor, reopening ? "book.reopened" : "book.closed", null, { from: current, to: through, ...(why ? { reason: why } : {}) });
    return through;
  });
}

/**
 * Growzar (D-70): an accountant prepares a close; an owner or admin confirms
 * it (setClosedThrough). Preparing changes nothing in the books: it leaves
 * the date, who prepared it and a note for the owner, and the activity log
 * keeps it. `through` null withdraws a prepared close.
 */
export async function prepareClose(book: BookView, through: string | null, today: string, actor: string | null, note?: string | null): Promise<void> {
  if (through !== null) {
    if (!isIsoDate(through)) throw new BooksError("Choose a date", "through");
    if (through > today) throw new BooksError("You can only close days that have already happened.", "through");
    if (book.lockedThrough && through <= book.lockedThrough) throw new BooksError(`The books are already closed through ${book.lockedThrough}.`, "through");
  }
  const memo = (note ?? "").trim().slice(0, 500);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bk_books WHERE id = ${book.id} FOR UPDATE`;
    const cur = ((await tx.bkBook.findUniqueOrThrow({ where: { id: book.id }, select: { settings: true } })).settings ?? {}) as BookSettings;
    const { preparedClose: _old, ...rest } = cur;
    const next: BookSettings = through ? { ...rest, preparedClose: { through, by: actor, at: new Date().toISOString(), ...(memo ? { note: memo } : {}) } } : rest;
    await tx.bkBook.update({ where: { id: book.id }, data: { settings: next as Prisma.InputJsonValue } });
    await audit(tx, book.id, actor, through ? "book.close_prepared" : "book.close_withdrawn", null, { to: through, from: cur.preparedClose?.through ?? null, ...(memo ? { note: memo } : {}) });
  });
}

// ── Audit ────────────────────────────────────────────────────────────────────

async function audit(tx: Tx, bookId: string, actor: string | null, action: string, documentId: string | null, detail: Record<string, unknown>) {
  await tx.bkAuditEvent.create({ data: { bookId, actor, action, documentId, detail: detail as Prisma.InputJsonValue } });
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export interface AccountView extends ReportAccount {
  balance: bigint;
  /** Foreign-currency accounts: the balance in their own currency (ledger sign). */
  fxBalance: bigint | null;
}

function accountInfo(a: BkAccount): AccountInfo {
  return { id: a.id, name: a.name, type: a.type as AccountType, subtype: a.subtype, systemKey: a.systemKey, archived: !!a.archivedAt, currency: a.currency };
}

function reportAccount(a: BkAccount): ReportAccount {
  return { id: a.id, code: a.code, name: a.name, type: a.type as AccountType, subtype: a.subtype, systemKey: a.systemKey, archived: !!a.archivedAt, parentId: a.parentId, currency: a.currency };
}

async function postingContext(tx: Tx, bookId: string): Promise<PostingContext> {
  const rows = await tx.bkAccount.findMany({ where: { bookId } });
  const accounts = new Map(rows.map((a) => [a.id, accountInfo(a)]));
  return {
    accounts,
    system(key: SystemKey) {
      const a = rows.find((r) => r.systemKey === key);
      if (!a) throw new Error(`Books: book ${bookId} has no ${key} account`);
      return a.id;
    },
  };
}

/** Ledger balance per account (+debit/−credit), optionally between two dates inclusive. */
export async function ledgerSums(bookId: string, opts: { from?: string; to?: string; tag?: string | null; storeId?: string | null } = {}): Promise<Map<string, bigint>> {
  // By store (D-65): only that store's lines; undefined = the whole organization.
  const store = opts.storeId === undefined ? Prisma.empty : opts.storeId === null ? Prisma.sql`AND l."storeId" IS NULL` : Prisma.sql`AND l."storeId" = ${opts.storeId}`;
  // By tag: only lines of entries carrying it ("" = entries with no tag).
  if (opts.tag !== undefined && opts.tag !== null) {
    const rows = await prisma.$queryRaw<Array<{ accountId: string; s: bigint }>>`
      SELECT l."accountId", SUM(l.amount)::bigint AS s
        FROM bk_entry_lines l
        JOIN bk_entries e ON e.id = l."entryId"
        JOIN bk_documents d ON d.id = e."documentId"
       WHERE l."bookId" = ${bookId}
         ${opts.from ? Prisma.sql`AND l.date >= ${toDbDate(opts.from)}` : Prisma.empty}
         ${opts.to ? Prisma.sql`AND l.date <= ${toDbDate(opts.to)}` : Prisma.empty}
         ${store}
         ${opts.tag === "" ? Prisma.sql`AND cardinality(d.tags) = 0` : Prisma.sql`AND d.tags @> ARRAY[${opts.tag}]::text[]`}
       GROUP BY l."accountId"`;
    return new Map(rows.map((r) => [r.accountId, r.s]));
  }
  const where: Prisma.BkEntryLineWhereInput = { bookId, ...(opts.storeId !== undefined ? { storeId: opts.storeId } : {}) };
  if (opts.from || opts.to) {
    where.date = {};
    if (opts.from) where.date.gte = toDbDate(opts.from);
    if (opts.to) where.date.lte = toDbDate(opts.to);
  }
  const rows = await prisma.bkEntryLine.groupBy({ by: ["accountId"], where, _sum: { amount: true } });
  return new Map(rows.map((r) => [r.accountId, r._sum.amount ?? 0n]));
}

export async function listAccounts(book: BookView, opts: { includeArchived?: boolean; asOf?: string } = {}): Promise<AccountView[]> {
  const [rows, sums] = await Promise.all([
    prisma.bkAccount.findMany({ where: { bookId: book.id, ...(opts.includeArchived ? {} : { archivedAt: null }) } }),
    ledgerSums(book.id, { to: opts.asOf }),
  ]);
  const foreign = rows.filter((a) => a.currency).map((a) => a.id);
  const fx = foreign.length ? await foreignBalances(book.id, foreign, opts.asOf) : new Map<string, bigint>();
  return rows
    .map((a) => ({ ...reportAccount(a), balance: sums.get(a.id) ?? 0n, fxBalance: a.currency ? fx.get(a.id) ?? 0n : null }))
    .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
}

/** Foreign-currency balances (in each account's own currency, ledger sign). */
export async function foreignBalances(bookId: string, accountIds: string[], asOf?: string): Promise<Map<string, bigint>> {
  if (accountIds.length === 0) return new Map();
  const rows = await prisma.bkEntryLine.groupBy({ by: ["accountId"], where: { bookId, accountId: { in: accountIds }, ...(asOf ? { date: { lte: toDbDate(asOf) } } : {}) }, _sum: { fxAmount: true } });
  return new Map(rows.map((r) => [r.accountId, r._sum.fxAmount ?? 0n]));
}

export async function getAccount(book: BookView, id: string): Promise<BkAccount | null> {
  return prisma.bkAccount.findFirst({ where: { id, bookId: book.id } });
}

export async function createAccount(
  book: BookView,
  input: { name: string; type: AccountType; subtype: string; parentId?: string | null },
  actor: string | null,
): Promise<BkAccount> {
  const name = input.name.trim();
  if (!name) throw new BooksError("Give the account a name", "name");
  if (name.length > 120) throw new BooksError("That name is too long", "name");
  if (!SUBTYPES_FOR_TYPE[input.type]) throw new BooksError("Choose a type", "type");
  if (!SUBTYPES_FOR_TYPE[input.type].includes(input.subtype)) throw new BooksError("Choose a kind", "subtype");

  const attempt = () => prisma.$transaction(async (tx) => {
    const existing = await tx.bkAccount.findMany({ where: { bookId: book.id }, select: { code: true, name: true, archivedAt: true } });
    if (existing.some((a) => !a.archivedAt && a.name.toLowerCase() === name.toLowerCase())) {
      throw new BooksError("An account with that name already exists", "name");
    }
    let parentId: string | null = null;
    if (input.parentId) {
      const parent = await tx.bkAccount.findFirst({ where: { id: input.parentId, bookId: book.id, archivedAt: null } });
      if (!parent) throw new BooksError("Choose an account to put it under", "parentId");
      if (parent.type !== input.type) throw new BooksError("A sub-account must be the same type as its parent", "parentId");
      if (parent.parentId) throw new BooksError(`"${parent.name}" is itself a sub-account; choose a top-level account`, "parentId");
      parentId = parent.id;
    }
    const money = MONEY_KINDS.find((k) => k.subtype === input.subtype);
    const code = nextCode(existing.map((a) => a.code), money ? money.codeBase : CODE_BASE_FOR_TYPE[input.type]);
    const acc = await tx.bkAccount.create({ data: { bookId: book.id, code, name, type: input.type, subtype: input.subtype, parentId } });
    await audit(tx, book.id, actor, "account.created", null, { accountId: acc.id, code, name, type: input.type, subtype: input.subtype });
    return acc;
  });
  try {
    return await attempt();
  } catch (e) {
    // Another account took the same code at the same moment: pick the next one.
    if (isUniqueViolation(e)) return attempt();
    throw e;
  }
}

/**
 * Add a bank account, cash box, wallet or card after setup, with what's in it
 * today. Account and opening balance are created in one transaction, so a
 * refused balance (closed month, bad amount) leaves no half-made account.
 */
export async function createMoneyAccount(
  book: BookView,
  input: { subtype: string; name: string; opening: bigint; date: string; currency?: string | null; fxOpening?: bigint | null },
  actor: string | null,
): Promise<{ account: BkAccount; openingId: string | null }> {
  // Only a currency other than the book's makes a foreign account.
  const currency = input.currency && input.currency.toUpperCase() !== book.currency ? input.currency.toUpperCase() : null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new BooksError("Choose a currency", "currency");
  if (currency && (input.opening !== 0n) !== ((input.fxOpening ?? 0n) !== 0n)) throw new BooksError(`Enter the starting balance in ${currency} and what it's worth in ${book.currency}, or leave both empty`, "opening");
  const kind = MONEY_KINDS.find((k) => k.subtype === input.subtype);
  if (!kind) throw new BooksError("Choose what kind of account this is", "subtype");
  const name = input.name.trim();
  if (!name) throw new BooksError("Give the account a name", "name");
  if (name.length > 120) throw new BooksError("That name is too long", "name");
  if (!isIsoDate(input.date)) throw new BooksError("Choose a date", "date");

  const attempt = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.bkAccount.findMany({ where: { bookId: book.id }, select: { code: true, name: true, archivedAt: true } });
      if (existing.some((a) => !a.archivedAt && a.name.toLowerCase() === name.toLowerCase())) throw new BooksError("An account with that name already exists", "name");
      const code = nextCode(existing.map((a) => a.code), kind.codeBase);
      const account = await tx.bkAccount.create({ data: { bookId: book.id, code, name, type: kind.type, subtype: kind.subtype, currency } });
      await audit(tx, book.id, actor, "account.created", null, { accountId: account.id, code, name, type: kind.type, subtype: kind.subtype, currency });
      let openingId: string | null = null;
      if (input.opening !== 0n) {
        const doc = await tx.bkDocument.create({
          data: {
            bookId: book.id,
            type: "opening",
            date: toDbDate(input.date),
            data: {
              lines: [{ accountId: account.id, amount: input.opening.toString() }],
              // A foreign account's starting balance in its own currency (always positive; the line's sign applies).
              ...(currency ? { fx: { [account.id]: { amount: ((input.fxOpening ?? 0n) < 0n ? -(input.fxOpening ?? 0n) : input.fxOpening ?? 0n).toString() } } } : {}),
            },
            memo: `Starting balance of ${name}`,
            createdBy: actor,
          },
        });
        await audit(tx, book.id, actor, "document.draft_created", doc.id, { type: "opening" });
        await postInTx(tx, book, doc.id, actor);
        openingId = doc.id;
      }
      return { account, openingId };
    });
  try {
    return await attempt();
  } catch (e) {
    if (isUniqueViolation(e)) return attempt();
    if (e instanceof BooksError && /^lines\./.test(e.field ?? "")) throw new BooksError(e.message, "opening");
    throw e;
  }
}

export async function renameAccount(book: BookView, id: string, name: string, actor: string | null): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new BooksError("Give the account a name", "name");
  if (clean.length > 120) throw new BooksError("That name is too long", "name");
  await prisma.$transaction(async (tx) => {
    const acc = await tx.bkAccount.findFirst({ where: { id, bookId: book.id } });
    if (!acc) throw new BooksError("That account doesn't exist");
    const clash = await tx.bkAccount.findFirst({ where: { bookId: book.id, archivedAt: null, id: { not: id }, name: { equals: clean, mode: "insensitive" } } });
    if (clash) throw new BooksError("An account with that name already exists", "name");
    await tx.bkAccount.update({ where: { id }, data: { name: clean } });
    await audit(tx, book.id, actor, "account.renamed", null, { accountId: id, from: acc.name, to: clean });
  });
}

/**
 * Change an account's name, kind and parent. The kind stays within its type
 * (an expense stays an expense). Books' own accounts keep their kind. A used
 * account can't switch between money and non-money (statements and
 * reconciliations depend on it), and a tax rate's account must stay a tax
 * account. Sub-accounts are one level deep and share their parent's type.
 */
export async function updateAccount(book: BookView, id: string, input: { name: string; subtype: string; parentId: string | null }, actor: string | null): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new BooksError("Give the account a name", "name");
  if (name.length > 120) throw new BooksError("That name is too long", "name");
  await prisma.$transaction(async (tx) => {
    const acc = await tx.bkAccount.findFirst({ where: { id, bookId: book.id } });
    if (!acc) throw new BooksError("That account doesn't exist");
    const clash = await tx.bkAccount.findFirst({ where: { bookId: book.id, archivedAt: null, id: { not: id }, name: { equals: name, mode: "insensitive" } } });
    if (clash) throw new BooksError("An account with that name already exists", "name");
    if (input.subtype !== acc.subtype) {
      if (acc.systemKey) throw new BooksError("Books uses this account, so its kind can't change", "subtype");
      if (!SUBTYPES_FOR_TYPE[acc.type as AccountType]?.includes(input.subtype)) throw new BooksError("Choose a kind", "subtype");
      if (isMoneySubtype(acc.subtype) !== isMoneySubtype(input.subtype)) {
        const used = await tx.bkEntryLine.count({ where: { bookId: book.id, accountId: id } });
        if (used > 0) throw new BooksError(isMoneySubtype(acc.subtype) ? "This money account has entries, so it can't become another kind" : "This account has entries, so it can't become a money account", "subtype");
      }
      if (input.subtype !== "tax" && (await tx.bkTaxRate.count({ where: { bookId: book.id, accountId: id } })) > 0) throw new BooksError("A tax rate uses this account, so it must stay a tax account", "subtype");
    }
    const parentId = input.parentId || null;
    if (parentId !== acc.parentId && parentId) {
      if (parentId === id) throw new BooksError("An account can't be part of itself", "parentId");
      const parent = await tx.bkAccount.findFirst({ where: { id: parentId, bookId: book.id } });
      if (!parent || parent.archivedAt) throw new BooksError("Choose an account to put it under", "parentId");
      if (parent.type !== acc.type) throw new BooksError("A sub-account must be the same type as its parent", "parentId");
      if (parent.parentId) throw new BooksError(`"${parent.name}" is itself a sub-account; choose a top-level account`, "parentId");
      if ((await tx.bkAccount.count({ where: { bookId: book.id, parentId: id } })) > 0) throw new BooksError("This account has sub-accounts of its own, so it can't go under another", "parentId");
    }
    await tx.bkAccount.update({ where: { id }, data: { name, subtype: input.subtype, parentId } });
    await audit(tx, book.id, actor, "account.updated", null, { accountId: id, before: { name: acc.name, subtype: acc.subtype, parentId: acc.parentId }, after: { name, subtype: input.subtype, parentId } });
  });
}

export async function setAccountArchived(book: BookView, id: string, archived: boolean, actor: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const acc = await tx.bkAccount.findFirst({ where: { id, bookId: book.id } });
    if (!acc) throw new BooksError("That account doesn't exist");
    if (archived) {
      if (acc.systemKey) throw new BooksError("Books needs this account, so it can't be archived. You can rename it.");
      const sum = await tx.bkEntryLine.aggregate({ where: { bookId: book.id, accountId: id }, _sum: { amount: true } });
      if ((sum._sum.amount ?? 0n) !== 0n) throw new BooksError("This account still has a balance. Move it to another account first.");
      const drafts = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM bk_documents
         WHERE "bookId" = ${book.id} AND status = 'draft' AND data::text LIKE ${"%" + JSON.stringify(id) + "%"}`;
      if ((drafts[0]?.n ?? 0n) > 0n) throw new BooksError("A draft still uses this account. Finish or discard it first.");
      if ((await tx.bkAccount.count({ where: { bookId: book.id, parentId: id, archivedAt: null } })) > 0) throw new BooksError("This account has sub-accounts. Move or archive them first.");
    } else {
      const clash = await tx.bkAccount.findFirst({ where: { bookId: book.id, archivedAt: null, id: { not: id }, name: { equals: acc.name, mode: "insensitive" } } });
      if (clash) throw new BooksError(`Another account is already called "${acc.name}". Rename one of them first.`);
    }
    await tx.bkAccount.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
    await audit(tx, book.id, actor, archived ? "account.archived" : "account.restored", null, { accountId: id, name: acc.name });
  });
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export interface ContactInput {
  name: string;
  kinds: string[];
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

function cleanContact(input: ContactInput) {
  const name = input.name.trim();
  if (!name) throw new BooksError("Give the contact a name", "name");
  if (name.length > 160) throw new BooksError("That name is too long", "name");
  const kinds = [...new Set(input.kinds.filter((k): k is ContactKind => (CONTACT_KINDS as readonly string[]).includes(k)))];
  const email = input.email?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BooksError("That email doesn't look right", "email");
  return { name, kinds: kinds.length ? kinds : ["other"], email, phone: input.phone?.trim() || null, notes: input.notes?.trim()?.slice(0, 2000) || null };
}

export async function createContact(book: BookView, input: ContactInput, actor: string | null, tx?: Tx) {
  const run = async (t: Tx) => {
    const data = cleanContact(input);
    const clash = await t.bkContact.findFirst({ where: { bookId: book.id, archivedAt: null, name: { equals: data.name, mode: "insensitive" } } });
    if (clash) throw new BooksError("A contact with that name already exists", "name");
    const c = await t.bkContact.create({ data: { bookId: book.id, ...data } });
    await audit(t, book.id, actor, "contact.created", null, { contactId: c.id, name: c.name });
    return c;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

export async function updateContact(book: BookView, id: string, input: ContactInput, actor: string | null) {
  await prisma.$transaction(async (tx) => {
    const c = await tx.bkContact.findFirst({ where: { id, bookId: book.id } });
    if (!c) throw new BooksError("That contact doesn't exist");
    const data = cleanContact(input);
    const clash = await tx.bkContact.findFirst({ where: { bookId: book.id, archivedAt: null, id: { not: id }, name: { equals: data.name, mode: "insensitive" } } });
    if (clash) throw new BooksError("A contact with that name already exists", "name");
    await tx.bkContact.update({ where: { id }, data });
    await audit(tx, book.id, actor, "contact.updated", null, { contactId: id, before: { name: c.name, kinds: c.kinds }, after: { name: data.name, kinds: data.kinds } });
  });
}

export async function setContactArchived(book: BookView, id: string, archived: boolean, actor: string | null) {
  await prisma.$transaction(async (tx) => {
    const c = await tx.bkContact.findFirst({ where: { id, bookId: book.id } });
    if (!c) throw new BooksError("That contact doesn't exist");
    if (!archived) {
      const clash = await tx.bkContact.findFirst({ where: { bookId: book.id, archivedAt: null, id: { not: id }, name: { equals: c.name, mode: "insensitive" } } });
      if (clash) throw new BooksError(`Another contact is already called "${c.name}". Rename one of them first.`);
    }
    await tx.bkContact.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
    await audit(tx, book.id, actor, archived ? "contact.archived" : "contact.restored", null, { contactId: id, name: c.name });
  });
}

export async function listContacts(book: BookView, opts: { includeArchived?: boolean } = {}) {
  const [contacts, owed, activity] = await Promise.all([
    prisma.bkContact.findMany({ where: { bookId: book.id, ...(opts.includeArchived ? {} : { archivedAt: null }) }, orderBy: { name: "asc" } }),
    contactBalances(book),
    prisma.bkDocument.groupBy({ by: ["contactId"], where: { bookId: book.id, status: "posted", contactId: { not: null } }, _sum: { total: true }, _max: { date: true }, _count: true }),
  ]);
  const act = new Map(activity.map((a) => [a.contactId!, a]));
  return contacts.map((c) => ({
    ...c,
    owedToYou: owed.get(c.id)?.owedToYou ?? 0n,
    youOwe: owed.get(c.id)?.youOwe ?? 0n,
    documents: act.get(c.id)?._count ?? 0,
    lastDate: fromDbDate(act.get(c.id)?._max.date ?? null),
  }));
}

/** Per contact: what they owe you (receivables) and what you owe them (payables, cards, loans). */
async function contactBalances(book: BookView) {
  const rows = await prisma.$queryRaw<Array<{ contactId: string; type: string; subtype: string; amount: bigint }>>`
    SELECT l."contactId", a.type, a.subtype, SUM(l.amount)::bigint AS amount
      FROM bk_entry_lines l JOIN bk_accounts a ON a.id = l."accountId"
     WHERE l."bookId" = ${book.id} AND l."contactId" IS NOT NULL
       AND (a.subtype = 'receivable' OR a.subtype = 'payable')
     GROUP BY l."contactId", a.type, a.subtype`;
  const out = new Map<string, { owedToYou: bigint; youOwe: bigint }>();
  for (const r of rows) {
    const cur = out.get(r.contactId) ?? { owedToYou: 0n, youOwe: 0n };
    if (r.type === "asset") cur.owedToYou += r.amount;
    else cur.youOwe += -r.amount;
    out.set(r.contactId, cur);
  }
  return out;
}

export async function getContact(book: BookView, id: string) {
  return prisma.bkContact.findFirst({ where: { id, bookId: book.id } });
}

// ── Documents ────────────────────────────────────────────────────────────────

export interface DraftInput {
  id?: string | null;
  type: DocType;
  date: string;
  contactId?: string | null;
  /** A new contact typed in the form; created (as a supplier/customer) on save. */
  newContactName?: string | null;
  newContactKind?: ContactKind;
  memo?: string | null;
  data: unknown;
  /**
   * One key per form the person opened. A second submit of the same form (a
   * double click, a retry after a slow network) finds the first document
   * instead of recording the same expense twice.
   */
  clientKey?: string | null;
  /** Tags to start with (a production batch's number). */
  tags?: string[] | null;
  /** The store it belongs to (D-65); null or absent for organization-level items. The caller checks the store is the organization's. */
  storeId?: string | null;
}

const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Save (create or update) a draft. Drafts may be incomplete; posting validates.
 * If the same form was already submitted, returns that document unchanged
 * when it's no longer a draft.
 */
export async function saveDraft(book: BookView, input: DraftInput, actor: string | null): Promise<BkDocument> {
  if (!isDocType(input.type)) throw new BooksError("Unknown kind of entry");
  if (!isIsoDate(input.date)) throw new BooksError("Choose a date", "date");
  const key = input.clientKey && CLIENT_KEY.test(input.clientKey) ? input.clientKey : null;
  try {
    return await saveDraftInTx(book, input, key, actor);
  } catch (e) {
    // Two submits of the same form raced; the other one created it.
    if (key && isUniqueViolation(e)) return saveDraftInTx(book, input, key, actor);
    throw e;
  }
}

async function saveDraftInTx(book: BookView, input: DraftInput, key: string | null, actor: string | null): Promise<BkDocument> {
  const memo = input.memo?.trim().slice(0, 1000) || null;
  return prisma.$transaction(async (tx) => {
    let fromKey = false;
    if (!input.id && key) {
      const seen = await tx.bkDocument.findFirst({ where: { bookId: book.id, source: "manual", sourceRef: key } });
      if (seen && seen.status !== "draft") return seen;
      if (seen) {
        input = { ...input, id: seen.id };
        fromKey = true;
      }
    }

    let contactId = input.contactId || null;
    if (contactId) {
      const c = await tx.bkContact.findFirst({ where: { id: contactId, bookId: book.id } });
      if (!c) throw new BooksError("That contact doesn't exist", "contactId");
    } else if (input.newContactName?.trim()) {
      const name = input.newContactName.trim();
      const found = await tx.bkContact.findFirst({ where: { bookId: book.id, archivedAt: null, name: { equals: name, mode: "insensitive" } } });
      contactId = found ? found.id : (await createContact(book, { name, kinds: [input.newContactKind ?? "supplier"] }, actor, tx)).id;
    }

    const data = (input.data ?? {}) as Prisma.InputJsonValue;
    if (input.id) {
      const doc = await lockDocument(tx, book.id, input.id);
      // The same form's other submit saved it while we waited for the lock.
      if (doc.status !== "draft" && fromKey) return doc;
      if (doc.status !== "draft") throw new BooksError("This entry is already posted. Cancel it and record it again to change it.");
      if (doc.type !== input.type) throw new BooksError("This draft is a different kind of entry");
      const updated = await tx.bkDocument.update({ where: { id: doc.id }, data: { date: toDbDate(input.date), contactId, memo, data, storeId: input.storeId ?? null } });
      await audit(tx, book.id, actor, "document.draft_saved", doc.id, {});
      return updated;
    }
    const doc = await tx.bkDocument.create({
      data: { bookId: book.id, type: input.type, date: toDbDate(input.date), contactId, memo, data, createdBy: actor, sourceRef: key, storeId: input.storeId ?? null, ...(input.tags?.length ? { tags: cleanTags(input.tags) } : {}) },
    });
    await audit(tx, book.id, actor, "document.draft_created", doc.id, { type: input.type });
    return doc;
  });
}

async function lockDocument(tx: Tx, bookId: string, id: string): Promise<BkDocument> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM bk_documents WHERE id = ${id} AND "bookId" = ${bookId} FOR UPDATE`;
  if (locked.length === 0) throw new BooksError("That entry doesn't exist");
  return tx.bkDocument.findUniqueOrThrow({ where: { id } });
}

/** The next number in a book's own sequence (B-0001 for batches). */
export async function nextSequence(book: BookView, prefix: string): Promise<string> {
  return prisma.$transaction((tx) => nextNumber(tx, book.id, prefix));
}

async function nextNumber(tx: Tx, bookId: string, prefix: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ n: number }>>`
    INSERT INTO bk_sequences ("bookId", prefix, next) VALUES (${bookId}, ${prefix}, 2)
    ON CONFLICT ("bookId", prefix) DO UPDATE SET next = bk_sequences.next + 1
    RETURNING next - 1 AS n`;
  return `${prefix}-${String(rows[0]!.n).padStart(4, "0")}`;
}

/**
 * The date the books are closed through, read with a share lock: closing the
 * books waits for postings in progress, and postings wait for a close.
 */
async function lockedThroughForWrite(tx: Tx, bookId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ l: Date | null }>>`SELECT "lockedThrough" AS l FROM bk_books WHERE id = ${bookId} FOR SHARE`;
  return fromDbDate(rows[0]?.l ?? null);
}

async function insertEntry(tx: Tx, bookId: string, documentId: string, storeId: string | null, kind: "post" | "cancel", date: string, lines: PostingLine[]) {
  const locked = await lockedThroughForWrite(tx, bookId);
  if (!isOpenDate(date, locked)) throw new BooksError(`The books are closed through ${locked}. Use ${addDays(locked!, 1)} or later.`, "date");
  const entry = await tx.bkEntry.create({ data: { bookId, documentId, kind, date: toDbDate(date) } });
  await tx.bkEntryLine.createMany({
    data: lines.map((l) => ({
      entryId: entry.id,
      bookId,
      accountId: l.accountId,
      contactId: l.contactId,
      storeId,
      amount: l.amount,
      fxAmount: l.fxAmount ?? null,
      date: toDbDate(date),
      description: l.description,
    })),
  });
  // Run the database's balance check now rather than at COMMIT: Prisma logs a
  // failed commit but resolves the transaction, so a commit-time rejection
  // would look like success to the caller. Checked here, it throws.
  await tx.$executeRawUnsafe(`SET CONSTRAINTS bk_entry_lines_balanced IMMEDIATE`);
  return entry;
}

// ── Bills ────────────────────────────────────────────────────────────────────

/**
 * Which documents a payment settles: bill payments settle bills; customer
 * payments and credit notes settle invoices. (BkAllocation.billId holds
 * either.)
 */
const SETTLES: Partial<Record<string, "bill" | "invoice">> = { bill_payment: "bill", customer_payment: "invoice", credit_note: "invoice", supplier_credit: "bill" };

/** Credits that may stand on their own and be set against invoices or bills later. */
const CREDITS = new Set(["credit_note", "supplier_credit"]);

/** A bill's (or invoice's) own checks: due date not before its date; for bills, no repeat of a supplier's reference. */
async function checkBill(tx: Tx, book: BookView, doc: BkDocument) {
  const d = (doc.data ?? {}) as { dueDate?: string | null; reference?: string | null; opening?: boolean | null; billDate?: string | null };
  // An opening bill is entered on the day you started, but was raised (and fell due) before it.
  const billDate = d.opening ? (d.billDate && isIsoDate(d.billDate) ? d.billDate : "0000-01-01") : fromDbDate(doc.date)!;
  if (d.dueDate && isIsoDate(d.dueDate) && d.dueDate < billDate) throw new BooksError(`The due date can't be before the ${doc.type === "invoice" ? "invoice" : "bill"} date`, "dueDate");
  const ref = d.reference?.trim();
  if (ref && doc.contactId && doc.type === "bill") {
    const dup = await tx.$queryRaw<Array<{ number: string | null }>>`
      SELECT number FROM bk_documents
       WHERE "bookId" = ${book.id} AND type = 'bill' AND status = 'posted' AND "contactId" = ${doc.contactId}
         AND id <> ${doc.id} AND lower(trim(data->>'reference')) = lower(${ref}) LIMIT 1`;
    if (dup.length) throw new BooksError(`You already recorded bill "${ref}" from this supplier (${dup[0]!.number}). Change the reference if it's a different bill.`, "reference");
  }
}

/** Paid so far per bill (live allocations only). */
export async function billPaidAmounts(bookId: string, billIds: string[], tx: Tx = prisma): Promise<Map<string, bigint>> {
  if (billIds.length === 0) return new Map();
  const rows = await tx.bkAllocation.groupBy({ by: ["billId"], where: { bookId, billId: { in: billIds }, voidedAt: null }, _sum: { amount: true } });
  return new Map(rows.map((r) => [r.billId, r._sum.amount ?? 0n]));
}

/**
 * A payment's bills: each must be a saved bill of the same supplier with that
 * much still open. The bills are locked so two payments can't overpay one bill.
 */
async function checkAllocations(tx: Tx, book: BookView, doc: BkDocument): Promise<Array<{ billId: string; amount: bigint }>> {
  const target = SETTLES[doc.type] ?? "bill";
  const word = target === "invoice" ? "Invoice" : "Bill";
  const d = (doc.data ?? {}) as { allocations?: Array<{ billId?: unknown; amount?: unknown }> };
  const list = Array.isArray(d.allocations) ? d.allocations : [];
  const ids = [...new Set(list.map((a) => String(a.billId ?? "")))].filter(Boolean).sort();
  // A credit note may stand on its own (set against invoices later, or kept as credit).
  if (ids.length === 0) {
    if (CREDITS.has(doc.type)) return [];
    throw new BooksError(`Choose at least one ${target} to ${target === "invoice" ? "settle" : "pay"}`, "allocations");
  }
  // Lock in a fixed order so two payments touching the same bills can't deadlock.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM bk_documents WHERE "bookId" = ${book.id} AND id = ANY(${ids}) ORDER BY id FOR UPDATE`;
  if (locked.length !== ids.length) throw new BooksError(`One of the ${target}s no longer exists`, "allocations");
  const bills = await tx.bkDocument.findMany({ where: { id: { in: ids } } });
  const paid = await billPaidAmounts(book.id, ids, tx);
  const out: Array<{ billId: string; amount: bigint }> = [];
  list.forEach((a, i) => {
    const bill = bills.find((b) => b.id === a.billId);
    if (!bill || bill.type !== target) throw new BooksError(`That isn't ${target === "invoice" ? "an invoice" : "a bill"}`, `allocations.${i}.billId`);
    if (bill.status !== "posted") throw new BooksError(`${word} ${bill.number ?? ""} isn't saved to the books (or was cancelled)`, `allocations.${i}.billId`);
    if (bill.contactId !== doc.contactId) throw new BooksError(`${word} ${bill.number} is ${target === "invoice" ? "for a different customer" : "from a different supplier"}`, `allocations.${i}.billId`);
    const amt = typeof a.amount === "string" && /^\d+$/.test(a.amount) ? BigInt(a.amount) : -1n;
    if (amt <= 0n) throw new BooksError("Enter an amount", `allocations.${i}.amount`);
    const open = bill.total - (paid.get(bill.id) ?? 0n);
    if (amt > open) throw new BooksError(`That's more than is still owed on ${bill.number}`, `allocations.${i}.amount`);
    out.push({ billId: bill.id, amount: amt });
  });
  return out;
}

/**
 * Set unused credit (a credit note or a supplier credit) against open
 * invoices or bills later. Nothing moves in the ledger — both sides are
 * already in the same "owed" account — only what each document still owes.
 */
export async function applyCredit(book: BookView, creditId: string, items: Array<{ billId: string; amount: string }>, actor: string | null) {
  return prisma.$transaction(async (tx) => {
    const credit = await lockDocument(tx, book.id, creditId);
    if (!CREDITS.has(credit.type)) throw new BooksError("Only a credit note or supplier credit can be set against other entries");
    if (credit.status !== "posted") throw new BooksError("Save the credit to the books first");
    const target = SETTLES[credit.type]!;
    const used = (await tx.bkAllocation.aggregate({ where: { bookId: book.id, paymentId: credit.id, voidedAt: null }, _sum: { amount: true } }))._sum.amount ?? 0n;
    const ids = [...new Set(items.map((i) => i.billId))].sort();
    if (ids.length === 0 || ids.length !== items.length) throw new BooksError(`Choose each ${target} once`, "allocations");
    await tx.$queryRaw`SELECT id FROM bk_documents WHERE "bookId" = ${book.id} AND id = ANY(${ids}) ORDER BY id FOR UPDATE`;
    const docs = await tx.bkDocument.findMany({ where: { bookId: book.id, id: { in: ids } } });
    const paid = await billPaidAmounts(book.id, ids, tx);
    let sum = 0n;
    const rows = items.map((it, i) => {
      const d = docs.find((x) => x.id === it.billId);
      if (!d || d.type !== target || d.status !== "posted") throw new BooksError(`That isn't a saved ${target}`, `allocations.${i}.billId`);
      if (d.contactId !== credit.contactId) throw new BooksError(`${d.number} is for someone else`, `allocations.${i}.billId`);
      const amt = /^\d+$/.test(it.amount) ? BigInt(it.amount) : 0n;
      if (amt <= 0n) throw new BooksError("Enter an amount", `allocations.${i}.amount`);
      if (amt > d.total - (paid.get(d.id) ?? 0n)) throw new BooksError(`That's more than is still open on ${d.number}`, `allocations.${i}.amount`);
      sum += amt;
      return { bookId: book.id, paymentId: credit.id, billId: d.id, amount: amt };
    });
    if (sum > credit.total - used) throw new BooksError(`Only ${credit.total - used} of this credit is left to use`, "allocations");
    await tx.bkAllocation.createMany({ data: rows });
    await audit(tx, book.id, actor, "document.credit_applied", credit.id, { to: rows.map((r) => ({ id: r.billId, amount: r.amount.toString() })) });
    return { used: used + sum, left: credit.total - used - sum };
  });
}

/** What's left of a credit to set against invoices or bills. */
export async function creditLeft(book: BookView, creditId: string): Promise<bigint> {
  const c = await prisma.bkDocument.findFirst({ where: { id: creditId, bookId: book.id } });
  if (!c || !CREDITS.has(c.type) || c.status !== "posted") return 0n;
  const used = (await prisma.bkAllocation.aggregate({ where: { bookId: book.id, paymentId: c.id, voidedAt: null }, _sum: { amount: true } }))._sum.amount ?? 0n;
  return c.total - used;
}

export interface BillRow {
  id: string;
  number: string | null;
  status: string;
  date: string;
  dueDate: string | null;
  reference: string | null;
  contactId: string | null;
  contactName: string | null;
  total: bigint;
  paid: bigint;
  open: bigint;
  memo: string | null;
}

/** Bills with what's paid and open. `open` = only saved bills with money still owed. */
export async function listBills(book: BookView, f: { contactId?: string; open?: boolean; status?: "draft" | "posted" | "cancelled"; ids?: string[]; type?: "bill" | "invoice" } = {}): Promise<BillRow[]> {
  const where: Prisma.BkDocumentWhereInput = { bookId: book.id, type: f.type ?? "bill" };
  if (f.contactId) where.contactId = f.contactId;
  if (f.status) where.status = f.status;
  if (f.open) where.status = "posted";
  if (f.ids) where.id = { in: f.ids };
  const docs = await prisma.bkDocument.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 500 });
  const paid = await billPaidAmounts(book.id, docs.map((d) => d.id));
  const contactIds = [...new Set(docs.map((d) => d.contactId).filter(Boolean))] as string[];
  const contacts = contactIds.length ? await prisma.bkContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(contacts.map((c) => [c.id, c.name]));
  const rows = docs.map((d) => {
    const data = (d.data ?? {}) as { dueDate?: string | null; reference?: string | null };
    const p = paid.get(d.id) ?? 0n;
    return {
      id: d.id,
      number: d.number,
      status: d.status,
      date: fromDbDate(d.date)!,
      dueDate: data.dueDate ?? null,
      reference: data.reference ?? null,
      contactId: d.contactId,
      contactName: d.contactId ? names.get(d.contactId) ?? null : null,
      total: d.total,
      paid: p,
      open: d.status === "posted" ? d.total - p : 0n,
      memo: d.memo,
    };
  });
  return f.open ? rows.filter((r) => r.open > 0n) : rows;
}

/** Payments against a bill, or bills paid by a payment (live and voided). */
export async function allocationsFor(book: BookView, by: { billId?: string; paymentId?: string }) {
  const rows = await prisma.bkAllocation.findMany({ where: { bookId: book.id, ...(by.billId ? { billId: by.billId } : {}), ...(by.paymentId ? { paymentId: by.paymentId } : {}) }, orderBy: { createdAt: "asc" } });
  const otherIds = rows.map((r) => (by.billId ? r.paymentId : r.billId));
  const docs = otherIds.length ? await prisma.bkDocument.findMany({ where: { id: { in: otherIds } }, select: { id: true, number: true, date: true, status: true } }) : [];
  const map = new Map(docs.map((d) => [d.id, d]));
  return rows.map((r) => {
    const other = map.get(by.billId ? r.paymentId : r.billId);
    return { id: r.id, docId: other?.id ?? null, number: other?.number ?? null, date: fromDbDate(other?.date ?? null), amount: r.amount, voided: !!r.voidedAt };
  });
}

const GAINS_NAME = "Exchange gains and losses";

/** Growzar (v1.1, ported from Financify's fx.server.ts): the account exchange differences go to, made the first time it's needed. */
export async function fxGainsAccount(book: Pick<BookView, "id">, client: Tx | typeof prisma = prisma): Promise<string> {
  const find = () => client.bkAccount.findFirst({ where: { bookId: book.id, archivedAt: null, name: { equals: GAINS_NAME, mode: "insensitive" } }, select: { id: true } });
  const found = await find();
  if (found) return found.id;
  const used = await client.bkAccount.findMany({ where: { bookId: book.id }, select: { code: true } });
  return (await client.bkAccount.create({ data: { bookId: book.id, code: nextCode(used.map((u) => u.code), 4910), name: GAINS_NAME, type: "income", subtype: "other" } })).id;
}

/**
 * Growzar (v1.1 V1b, D-99): the realised exchange difference on lines that
 * pay down a foreign balance, worked out from the account's value and foreign
 * balance up to the entry's date (realiseExchange in posting.ts).
 */
async function withRealisedExchange(tx: Tx, book: BookView, type: DocType, date: string, posting: Posting, ctx: PostingContext): Promise<Posting> {
  if (type === "fx_revaluation" || type === "opening") return posting;
  const foreign = [...new Set(posting.lines.filter((l) => l.fxAmount && ctx.accounts.get(l.accountId)?.currency).map((l) => l.accountId))];
  if (!foreign.length) return posting;
  const rows = await tx.$queryRaw<Array<{ accountId: string; book: bigint; foreign: bigint }>>`
    SELECT "accountId", COALESCE(SUM(amount), 0)::bigint AS book, COALESCE(SUM("fxAmount"), 0)::bigint AS foreign
      FROM bk_entry_lines WHERE "bookId" = ${book.id} AND "accountId" IN (${Prisma.join(foreign)}) AND date <= ${toDbDate(date)}
     GROUP BY "accountId"`;
  const balances = new Map(rows.map((r) => [r.accountId, { book: BigInt(r.book), foreign: BigInt(r.foreign) }]));
  if (![...balances.values()].some((b) => b.foreign !== 0n)) return posting;
  const lines = realiseExchange(posting.lines, balances, await fxGainsAccount(book, tx));
  if (lines.length === posting.lines.length && lines.every((l, i) => l.amount === posting.lines[i]!.amount)) return posting;
  return { ...posting, lines, total: lines.reduce((t, l) => t + (l.amount > 0n ? l.amount : 0n), 0n) };
}

async function postInTx(tx: Tx, book: BookView, id: string, actor: string | null, expectedUpdatedAt?: string): Promise<BkDocument> {
  const doc = await lockDocument(tx, book.id, id);
  if (doc.status !== "draft") throw new BooksError("This entry is already posted");
  // Approving from a list: refuse figures that changed after the person looked at them.
  if (expectedUpdatedAt && doc.updatedAt.toISOString() !== expectedUpdatedAt) {
    throw new BooksError("It changed since you looked at it (a connector refreshed it). Check it again.");
  }
  const date = fromDbDate(doc.date)!;
  const locked = await lockedThroughForWrite(tx, book.id);
  if (!isOpenDate(date, locked)) {
    throw new BooksError(`The books are closed through ${locked}. Use ${addDays(locked!, 1)} or later.`, "date");
  }
  if (doc.type === "bill" || doc.type === "invoice") await checkBill(tx, book, doc);
  const allocations = SETTLES[doc.type] ? await checkAllocations(tx, book, doc) : [];
  const ctx = await postingContext(tx, book.id);
  const posting = await withRealisedExchange(tx, book, doc.type as DocType, date, buildPosting(doc.type as DocType, doc.data, ctx, doc.contactId), ctx);
  const lineContacts = [...new Set(posting.lines.map((l) => l.contactId).filter((c): c is string => !!c))];
  if (lineContacts.length) {
    const found = await tx.bkContact.count({ where: { bookId: book.id, id: { in: lineContacts } } });
    if (found !== lineContacts.length) throw new BooksError("One of the lines names a contact that doesn't exist", "lines");
  }
  const number = await nextNumber(tx, book.id, DOC_PREFIX[doc.type as DocType]);
  await insertEntry(tx, book.id, doc.id, doc.storeId, "post", date, posting.lines);
  if (allocations.length) await tx.bkAllocation.createMany({ data: allocations.map((a) => ({ bookId: book.id, paymentId: doc.id, billId: a.billId, amount: a.amount })) });
  const updated = await tx.bkDocument.update({ where: { id: doc.id }, data: { status: "posted", number, total: posting.total, postedAt: new Date() } });
  await audit(tx, book.id, actor, "document.posted", doc.id, { number, total: posting.total.toString() });

  // Remember choices so the next form opens on them.
  if (doc.contactId) {
    // Only cost or income accounts are worth remembering ("What for" next time), never the payable or money side.
    const main = posting.lines.find((l) => {
      const a = ctx.accounts.get(l.accountId);
      return !!a && (a.type === "expense" || a.type === "income" || (a.type === "asset" && !isMoneySubtype(a.subtype) && a.subtype !== "receivable"));
    });
    if (main) await tx.bkContact.update({ where: { id: doc.contactId }, data: { lastAccountId: main.accountId } });
  }
  return updated;
}

/** Check an entry's contents would post (accounts, amounts, contact), without saving anything. Returns its total. */
export async function checkPosting(book: BookView, type: DocType, data: unknown, contactId: string | null): Promise<bigint> {
  const ctx = await postingContext(prisma, book.id);
  if (contactId && !(await prisma.bkContact.findFirst({ where: { id: contactId, bookId: book.id }, select: { id: true } }))) throw new BooksError("That contact doesn't exist", "contactId");
  return buildPosting(type, data, ctx, contactId).total;
}

/**
 * What drafts come to (a draft's stored total is only set when it's saved):
 * worked out by the posting engine, or — for a draft that isn't complete
 * yet — the sum of what's been typed so far.
 */
export async function draftTotals(book: BookView, drafts: Array<Pick<BkDocument, "id" | "type" | "data" | "contactId">>): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (drafts.length === 0) return out;
  const ctx = await postingContext(prisma, book.id);
  for (const d of drafts) {
    try {
      out.set(d.id, buildPosting(d.type as DocType, d.data, ctx, d.contactId ?? "draft-contact").total);
    } catch {
      out.set(d.id, roughDraftTotal(d.data));
    }
  }
  return out;
}

function roughDraftTotal(data: unknown): bigint {
  const d = (data ?? {}) as Record<string, any>;
  const n = (v: unknown) => (typeof v === "string" && /^-?\d+$/.test(v) ? (BigInt(v) < 0n ? -BigInt(v) : BigInt(v)) : 0n);
  const sum = (ls: unknown, key = "amount") => (Array.isArray(ls) ? ls.reduce((s: bigint, l: any) => s + n(l?.[key]) + (key === "amount" ? n(l?.tax?.amount) : 0n), 0n) : 0n);
  if (Array.isArray(d.debits)) return sum(d.debits);
  if (Array.isArray(d.lines) && d.lines.some((l: any) => l && "debit" in l)) return sum(d.lines, "debit");
  if (Array.isArray(d.lines)) return sum(d.lines);
  if (Array.isArray(d.allocations)) return sum(d.allocations);
  if (d.received !== undefined) return n(d.received) + sum(d.deductions);
  return n(d.amount ?? d.adjustment);
}

/** Post a draft. Returns the posted document. */
export async function postDocument(book: BookView, id: string, actor: string | null, expectedUpdatedAt?: string): Promise<BkDocument> {
  const doc = await prisma.$transaction((tx) => postInTx(tx, book, id, actor, expectedUpdatedAt));
  const data = doc.data as Record<string, unknown>;
  if (doc.type === "expense" && typeof data.paidFrom === "string") await updateBookSettings(book, { lastPaidFrom: data.paidFrom });
  if (doc.type === "money_in" && typeof data.receivedIn === "string") await updateBookSettings(book, { lastReceivedIn: data.receivedIn });
  return doc;
}

export interface ApprovalResult {
  id: string;
  ok: boolean;
  number?: string | null;
  message?: string;
}


/**
 * Save several drafts to the books, oldest first. Each one stands alone: one
 * refusal (closed month, archived account, changed since it was looked at)
 * doesn't stop the rest, and every outcome is reported.
 */
export async function approveDocuments(book: BookView, items: Array<{ id: string; updatedAt: string }>, actor: string | null): Promise<ApprovalResult[]> {
  const unique = [...new Map(items.filter((i) => typeof i.id === "string" && i.id).map((i) => [i.id, i])).values()];
  if (unique.length === 0) throw new BooksError("Choose what to save");
  if (unique.length > MAX_APPROVE) throw new BooksError(`Save up to ${MAX_APPROVE} at a time`);
  const docs = await prisma.bkDocument.findMany({ where: { bookId: book.id, id: { in: unique.map((i) => i.id) } }, select: { id: true, date: true, createdAt: true, status: true, number: true } });
  const order = docs.sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
  const results: ApprovalResult[] = [];
  for (const i of unique) if (!docs.some((d) => d.id === i.id)) results.push({ id: i.id, ok: false, message: "It no longer exists" });
  for (const d of order) {
    if (d.status !== "draft") {
      results.push({ id: d.id, ok: false, number: d.number, message: d.status === "posted" ? "Already saved" : "It was cancelled" });
      continue;
    }
    const expected = unique.find((i) => i.id === d.id)!.updatedAt;
    try {
      const posted = await postDocument(book, d.id, actor, expected);
      results.push({ id: d.id, ok: true, number: posted.number });
    } catch (e) {
      if (e instanceof BooksError) results.push({ id: d.id, ok: false, message: e.message });
      else {
        console.error("[books] approving a draft failed", { bookId: book.id, documentId: d.id, error: e instanceof Error ? e.message : String(e) });
        results.push({ id: d.id, ok: false, message: "Something went wrong saving this one. Try it again on its own." });
      }
    }
  }
  return results;
}

/** Save then post in one step (the usual "Save" button). On a posting error the draft is kept. */
export async function saveAndPost(book: BookView, input: DraftInput, actor: string | null): Promise<{ doc: BkDocument; error?: BooksError }> {
  const draft = await saveDraft(book, input, actor);
  if (draft.status !== "draft") return { doc: draft }; // already saved by an earlier submit
  try {
    return { doc: await postDocument(book, draft.id, actor) };
  } catch (e) {
    if (e instanceof BooksError) {
      // Another submit of the same form posted it first: that's success, not an error.
      const now = await prisma.bkDocument.findUnique({ where: { id: draft.id } });
      if (now && now.status !== "draft" && input.clientKey && now.sourceRef === input.clientKey) return { doc: now };
      return { doc: now ?? draft, error: e };
    }
    throw e;
  }
}

/** Cancel a posted document with a mirror entry. Nothing is deleted. */
export async function cancelDocument(book: BookView, id: string, reason: string, actor: string | null): Promise<BkDocument> {
  const why = reason.trim().slice(0, 500);
  if (!why) throw new BooksError("Say briefly why this is being cancelled", "reason");
  return prisma.$transaction(async (tx) => {
    const doc = await lockDocument(tx, book.id, id);
    if (doc.status !== "posted") throw new BooksError(doc.status === "cancelled" ? "This entry is already cancelled" : "Only posted entries can be cancelled");
    if (doc.type === "bill" || doc.type === "invoice") {
      const live = await tx.bkAllocation.count({ where: { bookId: book.id, billId: doc.id, voidedAt: null } });
      if (live > 0) throw new BooksError(doc.type === "bill" ? "This bill has payments against it. Cancel those payments first." : "This invoice has payments or credit notes against it. Cancel those first.");
    }
    if (SETTLES[doc.type]) {
      await tx.bkAllocation.updateMany({ where: { bookId: book.id, paymentId: doc.id, voidedAt: null }, data: { voidedAt: new Date() } });
    }
    const date = cancelDateFor(fromDbDate(doc.date)!, await lockedThroughForWrite(tx, book.id));
    const original = await tx.bkEntryLine.findMany({ where: { entry: { documentId: doc.id, kind: "post" } } });
    await insertEntry(tx, book.id, doc.id, doc.storeId, "cancel", date, mirrorLines(original));
    const updated = await tx.bkDocument.update({ where: { id: doc.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: why } });
    await audit(tx, book.id, actor, "document.cancelled", doc.id, { reason: why, date });
    return updated;
  });
}

/**
 * A connector's document for one source item (a Shopify day, a payout…).
 * Creates the draft, or refreshes it while it's still a draft. Once the
 * merchant has saved or cancelled it, the connector leaves it alone.
 */
export async function upsertImported(
  book: BookView,
  input: { source: string; sourceRef: string; type: DocType; date: string; data: unknown; memo: string | null; contactName?: string | null; contactKind?: ContactKind; contactId?: string | null; storeId?: string | null },
): Promise<{ doc: BkDocument; action: "created" | "updated" | "unchanged" | "kept" }> {
  if (!/^[a-z_]{2,40}$/.test(input.source) || input.source === "manual") throw new Error(`Books: bad connector source ${input.source}`);
  const run = () =>
    prisma.$transaction(async (tx) => {
      const found = await tx.bkDocument.findFirst({ where: { bookId: book.id, source: input.source, sourceRef: input.sourceRef } });
      const data = input.data as Prisma.InputJsonValue;
      // The source names who it's with (a courier): find that contact, or add it.
      let contactId: string | null = found?.contactId ?? null;
      if (!contactId && input.contactId) {
        const c = await tx.bkContact.findFirst({ where: { id: input.contactId, bookId: book.id }, select: { id: true } });
        contactId = c?.id ?? null;
      }
      const cname = input.contactName?.trim();
      if (cname && !contactId) {
        const c = await tx.bkContact.findFirst({ where: { bookId: book.id, archivedAt: null, name: { equals: cname, mode: "insensitive" } } });
        contactId = c ? c.id : (await createContact(book, { name: cname, kinds: [input.contactKind ?? "other"] }, null, tx)).id;
      }
      if (found) {
        if (found.status !== "draft") return { doc: found, action: "kept" as const };
        // Postgres reorders JSON keys, so compare in a key-order-independent form.
        const same = canonicalJson(found.data) === canonicalJson(input.data) && found.memo === input.memo && fromDbDate(found.date) === input.date;
        if (same) return { doc: found, action: "unchanged" as const };
        const doc = await tx.bkDocument.update({ where: { id: found.id }, data: { data, memo: input.memo, date: toDbDate(input.date), contactId } });
        await audit(tx, book.id, null, "document.draft_saved", doc.id, { source: input.source });
        return { doc, action: "updated" as const };
      }
      const doc = await tx.bkDocument.create({
        data: { bookId: book.id, type: input.type, date: toDbDate(input.date), data, memo: input.memo, source: input.source, sourceRef: input.sourceRef, contactId, storeId: input.storeId ?? null },
      });
      await audit(tx, book.id, null, "document.draft_created", doc.id, { type: input.type, source: input.source });
      return { doc, action: "created" as const };
    });
  try {
    return await run();
  } catch (e) {
    if (isUniqueViolation(e)) return run(); // a parallel run created it first
    throw e;
  }
}

/** Throw away a draft. Drafts were never in the books, so this is a real delete. */
export async function discardDraft(book: BookView, id: string, actor: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const doc = await lockDocument(tx, book.id, id);
    if (doc.status !== "draft") throw new BooksError("Posted entries can't be deleted. Cancel it instead.");
    await tx.bkDocument.delete({ where: { id: doc.id } });
    await audit(tx, book.id, actor, "document.draft_discarded", null, { documentId: doc.id, type: doc.type });
  });
}

export async function getDocument(book: BookView, id: string) {
  const doc = await prisma.bkDocument.findFirst({ where: { id, bookId: book.id }, include: { entries: { include: { lines: true }, orderBy: { createdAt: "asc" } } } });
  if (!doc) return null;
  const [contact, events] = await Promise.all([
    doc.contactId ? prisma.bkContact.findUnique({ where: { id: doc.contactId } }) : null,
    prisma.bkAuditEvent.findMany({ where: { bookId: book.id, documentId: id }, orderBy: { createdAt: "asc" } }),
  ]);
  return { doc, contact, events };
}

export interface DocumentFilter {
  types?: DocType[];
  status?: "draft" | "posted" | "cancelled";
  contactId?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listDocuments(book: BookView, f: DocumentFilter = {}) {
  const pageSize = Math.min(f.pageSize ?? 25, 100);
  const page = Math.max(1, f.page ?? 1);
  const where: Prisma.BkDocumentWhereInput = { bookId: book.id };
  if (f.types?.length) where.type = { in: f.types };
  if (f.status) where.status = f.status;
  if (f.contactId) where.contactId = f.contactId;
  if (f.from || f.to) where.date = { ...(f.from ? { gte: toDbDate(f.from) } : {}), ...(f.to ? { lte: toDbDate(f.to) } : {}) };
  if (f.search?.trim()) {
    const q = f.search.trim();
    where.OR = [{ number: { contains: q, mode: "insensitive" } }, { memo: { contains: q, mode: "insensitive" } }];
  }
  const [rows, count] = await Promise.all([
    prisma.bkDocument.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.bkDocument.count({ where }),
  ]);
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))] as string[];
  const contacts = contactIds.length ? await prisma.bkContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(contacts.map((c) => [c.id, c.name]));
  return { rows: rows.map((r) => ({ ...r, contactName: r.contactId ? names.get(r.contactId) ?? null : null })), count, page, pageSize };
}

// ── Tags ─────────────────────────────────────────────────────────────────────

export const MAX_TAGS = 10;

/** Tidy tags: trimmed, single spaces, up to 40 characters, no repeats (ignoring case). */
export function cleanTags(tags: unknown): string[] {
  const out: string[] = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const v = String(t ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > MAX_TAGS) throw new BooksError(`Up to ${MAX_TAGS} tags on an entry`, "tags");
  return out;
}

/** Set an entry's tags. Tags are labels for reports, not part of the ledger, so saved entries can be tagged too. */
export async function setDocumentTags(book: BookView, id: string, tags: unknown, actor: string | null): Promise<string[]> {
  const clean = cleanTags(tags);
  return prisma.$transaction(async (tx) => {
    const doc = await tx.bkDocument.findFirst({ where: { id, bookId: book.id } });
    if (!doc) throw new BooksError("That entry doesn't exist");
    // Reuse an existing tag's spelling so "Website" and "website" stay one tag.
    const known = await listTags(book, tx);
    const spelled = clean.map((t) => known.find((k) => k.tag.toLowerCase() === t.toLowerCase())?.tag ?? t);
    await tx.bkDocument.update({ where: { id }, data: { tags: spelled } });
    await audit(tx, book.id, actor, "document.tagged", id, { before: doc.tags, after: spelled });
    return spelled;
  });
}

/** Every tag in use, most used first. */
export async function listTags(book: BookView, tx: Tx = prisma): Promise<Array<{ tag: string; count: number }>> {
  const rows = await tx.$queryRaw<Array<{ tag: string; n: bigint }>>`
    SELECT t AS tag, COUNT(*)::bigint AS n FROM bk_documents, unnest(tags) AS t
     WHERE "bookId" = ${book.id} GROUP BY t ORDER BY n DESC, t ASC LIMIT 200`;
  return rows.map((r) => ({ tag: r.tag, count: Number(r.n) }));
}

export async function countDrafts(book: BookView): Promise<number> {
  return prisma.bkDocument.count({ where: { bookId: book.id, status: "draft" } });
}

/** An account's movements in a period, with the balance carried in and a running balance. */
export async function accountRegister(book: BookView, accountId: string, opts: { from?: string; to?: string; page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(opts.pageSize ?? 50, 200);
  const page = Math.max(1, opts.page ?? 1);
  const where: Prisma.BkEntryLineWhereInput = { bookId: book.id, accountId };
  if (opts.from || opts.to) where.date = { ...(opts.from ? { gte: toDbDate(opts.from) } : {}), ...(opts.to ? { lte: toDbDate(opts.to) } : {}) };

  const openingAgg = opts.from ? await prisma.bkEntryLine.aggregate({ where: { bookId: book.id, accountId, date: { lt: toDbDate(opts.from) } }, _sum: { amount: true, fxAmount: true } }) : null;
  const opening = openingAgg?._sum.amount ?? 0n;
  const openingFx = openingAgg?._sum.fxAmount ?? 0n;
  const [count, closingAgg] = await Promise.all([
    prisma.bkEntryLine.count({ where }),
    prisma.bkEntryLine.aggregate({ where, _sum: { amount: true, fxAmount: true } }),
  ]);
  // Oldest first so the running balance reads down the page.
  const lines = await prisma.bkEntryLine.findMany({
    where,
    orderBy: [{ date: "asc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: { entry: { select: { kind: true, documentId: true } } },
  });
  const beforeRow = page > 1
    ? (await prisma.$queryRaw<Array<{ s: bigint | null; f: bigint | null }>>`
        SELECT SUM(amount)::bigint AS s, SUM("fxAmount")::bigint AS f FROM (
          SELECT amount, "fxAmount" FROM bk_entry_lines
           WHERE "bookId" = ${book.id} AND "accountId" = ${accountId}
             ${opts.from ? Prisma.sql`AND date >= ${toDbDate(opts.from)}` : Prisma.empty}
             ${opts.to ? Prisma.sql`AND date <= ${toDbDate(opts.to)}` : Prisma.empty}
           ORDER BY date ASC, id ASC LIMIT ${(page - 1) * pageSize}) t`)[0]
    : null;
  const before = beforeRow?.s ?? 0n;
  const beforeFx = beforeRow?.f ?? 0n;

  const docIds = [...new Set(lines.map((l) => l.entry.documentId))];
  const docs = docIds.length ? await prisma.bkDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, number: true, type: true, memo: true, contactId: true, status: true } }) : [];
  const contactIds = [...new Set(docs.map((d) => d.contactId).filter(Boolean))] as string[];
  const contacts = contactIds.length ? await prisma.bkContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }) : [];
  const docMap = new Map(docs.map((d) => [d.id, d]));
  const contactMap = new Map(contacts.map((c) => [c.id, c.name]));

  let running = opening + before;
  let runningFx = openingFx + beforeFx;
  const rows = lines.map((l) => {
    running += l.amount;
    runningFx += l.fxAmount ?? 0n;
    const d = docMap.get(l.entry.documentId);
    return {
      id: l.id.toString(),
      date: fromDbDate(l.date)!,
      amount: l.amount,
      running,
      fxAmount: l.fxAmount,
      runningFx,
      description: l.description,
      cancel: l.entry.kind === "cancel",
      documentId: l.entry.documentId,
      number: d?.number ?? null,
      type: d?.type ?? null,
      memo: d?.memo ?? null,
      contactName: d?.contactId ? contactMap.get(d.contactId) ?? null : null,
    };
  });
  return { opening, closing: opening + (closingAgg._sum.amount ?? 0n), openingFx, closingFx: openingFx + (closingAgg._sum.fxAmount ?? 0n), rows, count, page, pageSize };
}

// ── Reports ──────────────────────────────────────────────────────────────────

export async function reportAccounts(book: BookView): Promise<ReportAccount[]> {
  const rows = await prisma.bkAccount.findMany({ where: { bookId: book.id } });
  return rows.map(reportAccount);
}

export async function balanceSheetInputs(book: BookView, asOf: string) {
  const fyStart = fiscalYearStart(asOf, book.fiscalYearStartMonth);
  const [accounts, balances, before] = await Promise.all([
    reportAccounts(book),
    ledgerSums(book.id, { to: asOf }),
    ledgerSums(book.id, { to: addDays(fyStart, -1) }),
  ]);
  return { accounts, balances, pnlBeforeYear: before, fyStart };
}

// ── Purge ────────────────────────────────────────────────────────────────────

/**
 * Delete every Books row for an organization, only when it asks, after an
 * export is offered (D-71). The only path allowed past the permanence triggers.
 */
export async function purgeBooks(organizationId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const book = await tx.bkBook.findUnique({ where: { organizationId } });
    if (!book) return 0;
    await tx.$executeRawUnsafe(`SET LOCAL books.allow_purge = 'on'`);
    await tx.bkEntryLine.deleteMany({ where: { bookId: book.id } });
    await tx.bkEntry.deleteMany({ where: { bookId: book.id } });
    await tx.bkAuditEvent.deleteMany({ where: { bookId: book.id } });
    await tx.bkSequence.deleteMany({ where: { bookId: book.id } });
    await tx.bkAllocation.deleteMany({ where: { bookId: book.id } });
    await tx.bkDocument.deleteMany({ where: { bookId: book.id } });
    await tx.bkBook.delete({ where: { id: book.id } }); // cascades accounts + contacts
    return 1;
  });
}
