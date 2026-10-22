import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { BooksError, createAccount, listAccounts, listBills, listContacts, saveAndPost, saveDraft, type BookView, type ContactKind } from "../books/books.server";
import { isMoneySubtype } from "../books/chart";
import { formatAmount } from "../books/money";
import type { DocType } from "../books/posting";
import { listTaxRates, taxBalances } from "../books/taxes.server";
import { RecordError, toDocData, toMinor, type RecordType } from "./record";

/** Everything the Record forms offer, for one book. */
export async function recordOptions(book: BookView, today: string) {
  const [accounts, contacts, rates, bills, stores, tax] = await Promise.all([
    listAccounts(book),
    listContacts(book),
    listTaxRates(book),
    listBills(book, { open: true }),
    prisma.store.findMany({ where: { id: { in: book.settings.storeIds ?? [] } }, select: { id: true, shopDomain: true, displayName: true } }),
    taxBalances(book, today),
  ]);
  const live = accounts.filter((a) => !a.archived && !a.currency);
  const fmt = (v: bigint) => formatAmount(v, book.decimals, { trimZeroFraction: false });
  return {
    currency: book.currency,
    accounts: live.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, systemKey: a.systemKey, money: isMoneySubtype(a.subtype) })),
    contacts: contacts.filter((c) => !c.archivedAt).map((c) => ({ id: c.id, name: c.name, kinds: c.kinds })),
    rates: rates.filter((r) => !r.archived).map((r) => ({ id: r.id, name: r.name, kind: r.kind, rateBp: r.rateBp })),
    bills: bills.map((b) => ({ id: b.id, contactId: b.contactId, number: b.number, reference: b.reference, date: b.date, open: fmt(b.open) })),
    stores: stores.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain })),
    taxOwed: tax.filter((t) => t.balance !== 0n).map((t) => ({ accountId: t.accountId, amount: fmt(t.balance < 0n ? -t.balance : t.balance) })),
    defaults: {
      lastPaidFrom: book.settings.lastPaidFrom ?? null,
      lastReceivedIn: book.settings.lastReceivedIn ?? null,
      owedByCouriers: live.find((a) => a.code === "1100")?.id ?? null,
      payables: live.find((a) => a.systemKey === "payables")?.id ?? null,
      returns: live.find((a) => a.code === "4030")?.id ?? null,
      shortfall: live.find((a) => /^courier shortfalls/i.test(a.name))?.id ?? null,
      salesTax: live.find((a) => a.code === "2100")?.id ?? null,
    },
  };
}

export interface RecordInput {
  type: RecordType;
  date: string;
  memo?: string | null;
  storeId?: string | null;
  contactId?: string | null;
  newContactName?: string | null;
  clientKey?: string | null;
  data: Record<string, unknown>;
  /** Keep as a draft instead of saving to the books. */
  asDraft?: boolean;
}

const CONTACT_KIND: Partial<Record<RecordType, ContactKind>> = {
  expense: "supplier",
  bill: "supplier",
  bill_payment: "supplier",
  supplier_credit: "supplier",
  courier_payout: "courier",
  parcel_writeoff: "courier",
  money_in: "customer",
};

/**
 * Save a hand-recorded entry: amounts and tax worked out, the store checked
 * to be one of the book's, then saved and posted (or kept as a draft). A form
 * sent twice records once (its client key).
 */
export async function saveRecord(book: BookView, input: RecordInput, actor: string) {
  if (input.storeId && !(book.settings.storeIds ?? []).includes(input.storeId)) throw new BooksError("Choose one of these books' stores", "storeId");
  const rates = await listTaxRates(book);
  const data = toDocData(input.type, input.data as never, book.decimals, rates) as Record<string, unknown>;

  if (input.type === "parcel_writeoff") {
    // Without the parcel register, each parcel is named by its order number.
    data.parcels = ((data.parcels as Array<{ orderName?: string; amount?: string }>) ?? []).map((p) => ({ orderId: String(p.orderName ?? "").trim(), orderName: String(p.orderName ?? "").trim(), amount: p.amount }));
    const taxMinor = toMinor((input.data as { taxAmount?: unknown }).taxAmount, book.decimals, "taxAmount");
    delete data.taxAmount;
    const salesTax = (await listAccounts(book)).find((a) => a.code === "2100" && !a.archived);
    data.tax = data.reason === "lost" && taxMinor && taxMinor !== "0" && salesTax ? { accountId: salesTax.id, amount: taxMinor } : null;
    // "Courier shortfalls", made the first time a parcel is paid short.
    if (data.reason === "short_paid" && !data.account) {
      const found = (await listAccounts(book)).find((a) => /^courier shortfalls/i.test(a.name) && a.type === "expense");
      data.account = found?.id ?? (await createAccount(book, { name: "Courier shortfalls", type: "expense", subtype: "cost_of_sales" }, actor)).id;
    }
  }

  const draft = {
    type: input.type as DocType,
    date: input.date,
    memo: input.memo ?? null,
    storeId: input.storeId || null,
    contactId: input.contactId || null,
    newContactName: input.newContactName || null,
    newContactKind: CONTACT_KIND[input.type],
    clientKey: input.clientKey ?? null,
    data: data as Prisma.InputJsonValue,
  };
  if (input.asDraft) return { doc: await saveDraft(book, draft, actor), error: undefined };
  return saveAndPost(book, draft, actor);
}

export { RecordError };
