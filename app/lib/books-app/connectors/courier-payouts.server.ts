import type { BkConnector, Prisma } from "@prisma/client";

import { prisma } from "../../db.server";
import { appRequest } from "../../apps/client.server";
import { BooksError, createAccount, discardDraft, listAccounts, postDocument, upsertImported, type BookView } from "../../books/books.server";
import { isMoneySubtype, type AccountType } from "../../books/chart";
import { formatDate, todayIn } from "../../books/dates";
import { isIsoDate } from "../../books/posting";
import { courierName, payoutDay, planPayout, planSums, type PayoutAccounts, type PayoutMapping, type SettlementWire } from "./courier-payouts";
import { postDifference } from "./corrections.server";
import type { RunResult } from "./runs.server";

/**
 * Courier payouts (B3, D-86), read straight from Courierify for each store in
 * the book: `include=lines` pages of 20 (one payout can hold 21,521 parcels),
 * from a cursor per store. The lines are never stored outside the books; the
 * general sync keeps the headers it always had.
 */
const CAPABILITY = "settlements:lines";
const PAGE = 20;
/** Re-read a little before the last run's start: a payout written during it isn't missed. */
const OVERLAP_MS = 10 * 60 * 1000;

export interface CourierPayoutSettings {
  mapping: PayoutMapping;
  /** Courierify's updatedSince per store: the start of the last complete run. */
  cursors?: Record<string, string>;
}

type Page = {
  shopCurrency?: string;
  data?: SettlementWire[];
  deletedSettlements?: Array<{ settlementId: string; settlementRef?: string | null }>;
  pagination?: { hasMore?: boolean; nextCursor?: string | null };
};

export async function payoutDefaults(book: BookView): Promise<PayoutMapping> {
  const accounts = (await listAccounts(book)).filter((a) => !a.archived && !a.currency);
  const code = (c: string) => accounts.find((a) => a.code === c)?.id ?? "";
  const claimable = book.settings.courierTax?.withheld === "claimable";
  return {
    receivable: code("1100"),
    receivedIn: accounts.find((a) => a.subtype === "bank")?.id ?? "",
    delivery: code("5010"),
    returns: code("5020"),
    tax: claimable ? code("1300") : code("6060"),
    other: code("5010"),
  };
}

export async function checkPayoutMapping(book: BookView, m: PayoutMapping): Promise<PayoutMapping> {
  const accounts = await listAccounts(book);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const need = (id: string, field: keyof PayoutMapping, ok: (a: (typeof accounts)[number]) => boolean, what: string) => {
    const a = byId.get(id);
    if (!a || a.archived) throw new BooksError(`Choose an account for ${what}`, `mapping.${field}`);
    if (a.currency) throw new BooksError(`"${a.name}" is in ${a.currency}; payouts come in ${book.currency}. Choose another account.`, `mapping.${field}`);
    if (!ok(a)) throw new BooksError(`"${a.name}" can't be used for ${what}`, `mapping.${field}`);
  };
  const cost = (a: (typeof accounts)[number]) => a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype) && a.subtype !== "receivable");
  need(m.receivable, "receivable", (a) => a.type === "asset" && a.subtype === "receivable", "what couriers owe you");
  need(m.receivedIn, "receivedIn", (a) => isMoneySubtype(a.subtype), "where payouts arrive");
  need(m.delivery, "delivery", cost, "delivery charges");
  need(m.returns, "returns", cost, "return charges");
  need(m.tax, "tax", cost, "tax the courier withheld");
  need(m.other, "other", cost, "other charges");
  return { receivable: m.receivable, receivedIn: m.receivedIn, delivery: m.delivery, returns: m.returns, tax: m.tax, other: m.other };
}

/** An account Books needs for payouts, found by name or made the first time (as Financify does). */
async function ensureAccount(book: BookView, name: string, type: AccountType, subtype: string): Promise<string> {
  const found = (await listAccounts(book, { includeArchived: true })).find((a) => a.name.toLowerCase() === name.toLowerCase() && a.type === type);
  if (found) return found.id;
  return (await createAccount(book, { name, type, subtype }, null)).id;
}

export async function payoutAccounts(book: BookView): Promise<PayoutAccounts> {
  return {
    held: await ensureAccount(book, "Held by courier", "asset", "receivable"),
    unexplained: await ensureAccount(book, "Courier charges not explained", "expense", "cost_of_sales"),
    others: await ensureAccount(book, "Courier money not for your orders", "liability", "other"),
  };
}

/** The book's stores that Courierify serves with settlement lines. */
export async function payoutStores(book: BookView) {
  const stores = await prisma.store.findMany({
    where: { id: { in: book.settings.storeIds ?? [] } },
    select: { id: true, shopDomain: true, displayName: true, connections: { where: { app: "COURIERIFY" }, select: { status: true, capabilities: true } } },
  });
  return stores.map((s) => ({
    id: s.id,
    shopDomain: s.shopDomain,
    name: s.displayName ?? s.shopDomain,
    connected: s.connections.some((c) => c.status === "CONNECTED"),
    lines: s.connections.some((c) => c.status === "CONNECTED" && c.capabilities.includes(CAPABILITY)),
  }));
}

/** Fetch one page of payouts with lines for a store. Throws a BooksError with a plain message on failure. */
export type FetchPage = (shopDomain: string, query: URLSearchParams) => Promise<Page>;

export const fetchPayoutPage: FetchPage = async (shopDomain, query) => {
  const res = await appRequest<Page>("COURIERIFY", { pathWithQuery: `/api/v1/growzar/settlements?${query.toString()}`, shopDomain });
  if (!res.ok) throw new BooksError(`Courierify couldn't be reached (${res.reason}). Books will try again.`);
  return res.data;
};

export async function runCourierPayouts(book: BookView, connector: BkConnector, fetchPage: FetchPage = fetchPayoutPage): Promise<RunResult> {
  const r: RunResult = { status: "ok", created: 0, updated: 0, skipped: 0, notes: [], from: null, to: null };
  const settings = (connector.settings ?? {}) as unknown as CourierPayoutSettings;
  const start = connector.startDate?.toISOString().slice(0, 10);
  if (!start || !settings.mapping) return { ...r, status: "error", notes: ["Finish setting up courier payouts first"] };
  const startedAt = new Date();
  const today = todayIn(book.settings.timeZone);
  const cursors = { ...(settings.cursors ?? {}) };
  let acc: PayoutAccounts | null = null;
  const notMine: string[] = [];
  const flagged: string[] = [];

  for (const store of await payoutStores(book)) {
    if (!store.lines) {
      if (store.connected) {
        r.status = "partial";
        r.notes.push(`${store.name}: Courierify doesn't send payout details for it yet, so its payouts wait`);
      }
      continue;
    }
    let cursor: string | null = null;
    let first = true;
    try {
      do {
        const q = new URLSearchParams({ include: "lines", limit: String(PAGE) });
        if (cursor) q.set("cursor", cursor);
        else if (cursors[store.id]) q.set("updatedSince", new Date(Date.parse(cursors[store.id]!) - OVERLAP_MS).toISOString());
        const page = await fetchPage(store.shopDomain, q);
        if (page.shopCurrency && page.shopCurrency !== book.currency) throw new BooksError(`${store.name}: Courierify reports amounts in ${page.shopCurrency}, but your books are in ${book.currency}`);

        // Removed in Courierify: a draft goes, a saved payout is flagged and never cancelled for you.
        if (first) {
          for (const del of page.deletedSettlements ?? []) {
            const doc = await prisma.bkDocument.findFirst({ where: { bookId: book.id, source: "courierify_payouts", sourceRef: del.settlementId } });
            if (doc?.status === "draft") await discardDraft(book, doc.id, null);
            else if (doc?.status === "posted") {
              r.status = "partial";
              r.notes.push(`Courierify removed payout ${del.settlementRef ?? del.settlementId}, which you saved as ${doc.number}. Cancel it if it's wrong`);
            }
          }
        }
        first = false;

        for (const st of page.data ?? []) {
          const day = payoutDay(st);
          const ref = st.paymentReference ?? st.settlementRef ?? st.id;
          if (!isIsoDate(day) || day < start) continue;
          acc ??= await payoutAccounts(book);
          const plan = planPayout(st, book.decimals, settings.mapping, acc);
          if (plan.kind === "skip") {
            r.skipped++;
            if (plan.reason === "no_lines") notMine.push(ref);
            else {
              r.status = "partial";
              r.notes.push(`Left out payout ${ref}: its figures don't add up on Courierify's side`);
            }
            continue;
          }
          if (plan.flagged) flagged.push(ref);
          const name = courierName(st.courier);
          const memo = `${st.direction === "invoice" ? `${name} invoice` : `${name} payout`} ${ref}${st.shipmentsCount ? ` · ${st.shipmentsCount} parcels` : ""}${plan.mixed ? " · shared with another business" : ""}${plan.flagged ? " · check: charges not explained" : ""}`;
          const base = st.settlementId ?? st.id;
          const res = await upsertImported(book, { source: "courierify_payouts", sourceRef: base, type: "courier_payout", date: day, data: plan.data, memo, contactName: name, contactKind: "courier", storeId: store.id });
          if (res.action === "created") r.created++;
          else if (res.action === "updated") r.updated++;
          else r.skipped++;
          // Courierify changed a payout already saved (a parcel's charges re-split): the difference posts on its own.
          if (res.action === "kept" && res.doc.status === "posted") {
            await postDifference(book, { source: "courierify_payouts", base, day, today, current: planSums(plan), memo: `${name} changed payout ${ref} (${res.doc.number}) after it was saved`, storeId: store.id, contactName: name, mode: connector.mode }, r);
            continue;
          }
          if (connector.mode === "auto" && res.doc.status === "draft") {
            try {
              await postDocument(book, res.doc.id, null);
            } catch (e) {
              r.status = "partial";
              r.notes.push(`${name} payout ${ref} (${formatDate(day)}): kept as a draft — ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        cursor = page.pagination?.hasMore ? page.pagination.nextCursor ?? null : null;
      } while (cursor);
      cursors[store.id] = startedAt.toISOString();
    } catch (e) {
      r.status = "partial";
      r.notes.push(e instanceof BooksError ? e.message : `${store.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (notMine.length) r.notes.push(`Left out ${notMine.length} payout${notMine.length === 1 ? "" : "s"} with none of your parcels in ${notMine.length === 1 ? "it" : "them"} (${notMine.slice(0, 3).join(", ")}${notMine.length > 3 ? "…" : ""}): a courier account shared with another business`);
  if (flagged.length) r.notes.push(`${flagged.length} payout${flagged.length === 1 ? "" : "s"} had charges the courier didn't explain (${flagged.slice(0, 3).join(", ")}${flagged.length > 3 ? "…" : ""}); they're in "Courier charges not explained" for you to check`);
  r.to = today;
  const next: CourierPayoutSettings = { ...settings, cursors };
  await prisma.bkConnector.update({ where: { id: connector.id }, data: { settings: next as unknown as Prisma.InputJsonValue, syncedThrough: new Date(`${today}T00:00:00.000Z`) } });
  return r;
}

/** The settings form, checked. A new first day starts every store's cursor over. */
export async function parsePayoutForm(book: BookView, previous: { startDate: string | null; settings: Record<string, unknown> }, input: { enabled: boolean; mode: string; startDate: string; mapping: PayoutMapping }, today: string) {
  if (!isIsoDate(input.startDate)) throw new BooksError("Choose the first day to bring in", "startDate");
  if (input.startDate > today) throw new BooksError("The first day can't be in the future", "startDate");
  const bookStart = book.settings.startDate;
  if (bookStart && input.startDate < bookStart) throw new BooksError(`Your books start on ${formatDate(bookStart)}; choose that day or later`, "startDate");
  const mapping = await checkPayoutMapping(book, input.mapping);
  const keep = previous.startDate === input.startDate ? ((previous.settings as Partial<CourierPayoutSettings>).cursors ?? {}) : {};
  const settings: CourierPayoutSettings = { mapping, cursors: keep };
  return { enabled: input.enabled, mode: input.mode === "auto" ? ("auto" as const) : ("draft" as const), startDate: input.startDate, settings };
}
