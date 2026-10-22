import type { BkConnector, Prisma } from "@prisma/client";

import { prisma } from "../../db.server";
import { appRequest } from "../../apps/client.server";
import { BooksError, cancelDocument, createAccount, discardDraft, listAccounts, postDocument, upsertImported, type BookView } from "../../books/books.server";
import { formatDate } from "../../books/dates";
import { isIsoDate } from "../../books/posting";
import { planLedgerEntry, planReceipt, type InvAccounts, type InvLedgerEntry, type InvReceipt } from "../../books/connectors/inventorify";
import type { RunResult } from "./runs.server";

/**
 * Goods received and the supplier ledger (B3, D-88), from Inventorify's
 * Growzar feeds (`/api/v1/growzar/receipts`, `/supplier-ledger`, live since
 * 2026-10-22), by Financify's rules (app/lib/books/connectors/inventorify.ts):
 * a receipt is a bill (good units to Stock, damaged ones awaiting the claim);
 * typed bills, credits and adjustments follow; payments aren't posted (Books
 * is where money moves) but are kept to match or record; a reversal cancels
 * or discards what it undoes.
 *
 * Both feeds are append-only and page by creation time, so each store keeps
 * the creation time of the last row read per feed (inclusive next time: a row
 * read twice finds its entry and is left alone).
 */
const CAPABILITIES = ["receipts:read", "supplier-ledger:read"];
const PAGE = 200;
const MAX_PAYMENTS = 300;

export interface InventorifyPayment {
  id: string;
  storeId: string;
  supplierId: string;
  supplierName: string;
  kind: "payment" | "refund";
  date: string;
  amount: string;
  reference: string | null;
}

export interface InventorifySettings {
  accounts?: InvAccounts;
  /** Per store: creation time of the last row read, per feed. */
  since?: Record<string, { receipts: string | null; ledger: string | null }>;
  payments?: InventorifyPayment[];
}

type Page<T> = { data?: T[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } };

export type FetchFeed = <T>(shopDomain: string, feed: "receipts" | "supplier-ledger", query: URLSearchParams) => Promise<Page<T>>;

export const fetchInventorifyFeed: FetchFeed = async (shopDomain, feed, query) => {
  const res = await appRequest<Page<never>>("INVENTORIFY", { pathWithQuery: `/api/v1/growzar/${feed}?${query.toString()}`, shopDomain });
  if (!res.ok) throw new BooksError(`Inventorify couldn't be reached (${res.reason}). Books will try again.`);
  return res.data;
};

/** The accounts it posts to; the two it needs are added the first time (Financify's names). */
export async function inventorifyAccounts(book: BookView): Promise<InvAccounts> {
  const all = await listAccounts(book);
  const sys = (k: string) => all.find((a) => a.systemKey === k && !a.archived)?.id;
  const named = async (name: RegExp, create: { name: string; type: "asset" | "expense"; subtype: string }) =>
    all.find((a) => !a.archived && a.type === create.type && name.test(a.name))?.id ?? (await createAccount(book, create, null)).id;
  const payable = sys("payables");
  const stock = sys("stock");
  if (!payable || !stock) throw new BooksError("These books are missing their Stock or Owed to suppliers account.");
  return {
    payable,
    stock,
    awaitingClaim: await named(/^damaged stock awaiting/i, { name: "Damaged stock awaiting supplier claims", type: "asset", subtype: "other" }),
    purchaseDiffs: await named(/^purchase differences/i, { name: "Purchase differences and charges", type: "expense", subtype: "cost_of_sales" }),
  };
}

export async function inventorifyStores(book: BookView) {
  const stores = await prisma.store.findMany({
    where: { id: { in: book.settings.storeIds ?? [] } },
    select: { id: true, shopDomain: true, displayName: true, connections: { where: { app: "INVENTORIFY" }, select: { status: true, capabilities: true } } },
  });
  return stores.map((s) => {
    const c = s.connections.find((x) => x.status === "CONNECTED");
    return { id: s.id, shopDomain: s.shopDomain, name: s.displayName ?? s.shopDomain, connected: !!c, feeds: !!c && CAPABILITIES.every((k) => c.capabilities.includes(k)) };
  });
}

async function readAll<T extends { createdAt: string }>(fetchFeed: FetchFeed, shopDomain: string, feed: "receipts" | "supplier-ledger", since: string | null): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (cursor) q.set("cursor", cursor);
    else if (since) q.set("updatedSince", since);
    const page: Page<T> = await fetchFeed<T>(shopDomain, feed, q);
    out.push(...(page.data ?? []));
    cursor = page.pagination?.hasMore ? page.pagination.nextCursor ?? null : null;
  } while (cursor);
  return out;
}

export async function runInventorify(book: BookView, connector: BkConnector, fetchFeed: FetchFeed = fetchInventorifyFeed): Promise<RunResult> {
  const r: RunResult = { status: "ok", created: 0, updated: 0, skipped: 0, notes: [], from: null, to: null };
  const settings = (connector.settings ?? {}) as unknown as InventorifySettings;
  const start = connector.startDate?.toISOString().slice(0, 10);
  if (!start) return { ...r, status: "error", notes: ["Finish setting up Inventorify first"] };
  const accounts = settings.accounts ?? (await inventorifyAccounts(book));
  const opts = { currency: book.currency, decimals: book.decimals, startDate: start };
  const since = { ...(settings.since ?? {}) };
  const payments = new Map((settings.payments ?? []).map((p) => [p.id, p]));

  for (const store of await inventorifyStores(book)) {
    if (!store.feeds) {
      if (store.connected) r.notes.push(`${store.name}: Inventorify needs an update to send goods received; record supplier bills by hand until then`);
      continue;
    }
    const mine = { ...(since[store.id] ?? { receipts: null, ledger: null }) };
    try {
      const suppliers = await prisma.rawRecord.findMany({ where: { storeId: store.id, app: "INVENTORIFY", entity: "SUPPLIER" }, select: { externalId: true, payload: true } });
      const supplierName = new Map(suppliers.map((s) => [s.externalId, String((s.payload as { name?: unknown }).name ?? "")]));
      const nameOf = (id: string) => supplierName.get(id) || `Inventorify supplier ${id.slice(-6)}`;
      const ref = (x: string) => `${store.id}:${x}`;

      const record = async (plan: Extract<ReturnType<typeof planReceipt>, { action: "post" }>) => {
        const res = await upsertImported(book, { source: "inventorify", sourceRef: ref(plan.sourceRef), type: plan.type, date: plan.date, data: plan.data, memo: plan.memo, contactName: nameOf(plan.supplierId), contactKind: "supplier", storeId: store.id });
        if (res.action === "created") r.created++;
        else if (res.action === "updated") r.updated++;
        else r.skipped++;
        if (connector.mode === "auto" && res.doc.status === "draft") {
          try {
            await postDocument(book, res.doc.id, null);
          } catch (e) {
            r.status = "partial";
            r.notes.push(`${plan.memo}, ${formatDate(plan.date)}: kept as a draft — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      };

      // Goods received first, so a reversal in the ledger finds the bill its receipt made.
      for (const row of await readAll<InvReceipt>(fetchFeed, store.shopDomain, "receipts", mine.receipts)) {
        const plan = planReceipt(row, accounts, opts);
        if (plan.action === "post") await record(plan);
        else if (plan.action === "skip" && plan.reason !== "before the first day") r.notes.push(`${store.name}: ${plan.reason}`);
        mine.receipts = row.createdAt;
      }
      for (const row of await readAll<InvLedgerEntry>(fetchFeed, store.shopDomain, "supplier-ledger", mine.ledger)) {
        const plan = planLedgerEntry(row, accounts, opts);
        if (plan.action === "post") await record(plan);
        else if (plan.action === "payment") payments.set(plan.entry.id, { ...plan.entry, storeId: store.id, supplierName: nameOf(plan.entry.supplierId) });
        else if (plan.action === "reverse") {
          if (!payments.delete(plan.ledgerId)) {
            const target = await prisma.bkDocument.findFirst({ where: { bookId: book.id, source: "inventorify", storeId: store.id, status: { in: ["draft", "posted"] }, data: { path: ["inventorify", "ledgerId"], equals: plan.ledgerId } } });
            if (target) {
              try {
                if (target.status === "draft") await discardDraft(book, target.id, null);
                else await cancelDocument(book, target.id, plan.memo, null);
                r.updated++;
              } catch (e) {
                r.status = "partial";
                r.notes.push(`${store.name}: couldn't undo ${target.number ?? "an entry"} — ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
        } else if (plan.reason !== "before the first day" && plan.reason !== "posted with its receipt") r.notes.push(`${store.name}: ${plan.reason}`);
        mine.ledger = row.createdAt;
      }
      since[store.id] = mine;
    } catch (e) {
      since[store.id] = mine;
      r.status = "partial";
      r.notes.push(e instanceof BooksError ? `${store.name}: ${e.message}` : `${store.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const next: InventorifySettings = { ...settings, accounts, since, payments: [...payments.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_PAYMENTS) };
  await prisma.bkConnector.update({ where: { id: connector.id }, data: { settings: next as unknown as Prisma.InputJsonValue } });
  return r;
}

/** The settings form: first day and mode; accounts are Books' own (made the first time). */
export async function parseInventorifyForm(book: BookView, previous: { startDate: string | null; settings: Record<string, unknown> }, input: { enabled: boolean; mode: string; startDate: string }, today: string) {
  if (!isIsoDate(input.startDate)) throw new BooksError("Choose the first day to bring in", "startDate");
  if (input.startDate > today) throw new BooksError("The first day can't be in the future", "startDate");
  const bookStart = book.settings.startDate;
  if (bookStart && input.startDate < bookStart) throw new BooksError(`Your books start on ${formatDate(bookStart)}; choose that day or later`, "startDate");
  const prev = previous.settings as InventorifySettings;
  // A new first day reads everything again; entries already made are found, not duplicated.
  const settings: InventorifySettings = { ...prev, accounts: await inventorifyAccounts(book), since: previous.startDate === input.startDate ? prev.since ?? {} : {} };
  return { enabled: input.enabled, mode: input.mode === "auto" ? ("auto" as const) : ("draft" as const), startDate: input.startDate, settings };
}
