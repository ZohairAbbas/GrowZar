import type { BkConnector, Prisma } from "@prisma/client";

import { prisma } from "../../db.server";
import { BooksError, createAccount, listAccounts, postDocument, toDbDate, upsertImported, type BookView } from "../../books/books.server";
import { isMoneySubtype, type AccountType } from "../../books/chart";
import { formatDate, todayIn } from "../../books/dates";
import { addDays, isIsoDate } from "../../books/posting";
import {
  isReturnedStatus,
  legacyOrderId,
  parcelChanges,
  routeManualPayment,
  sumLines,
  summariseDays,
  type DaySummary,
  type ParcelEvent,
  type ParcelLines,
  type SalesMapping,
  type ShopOrder,
} from "../../books/connectors/shopify-sales";
import { toPosting, toSums } from "./ad-spend";
import { parseFxRate, toBookAmount } from "../../books/fx";
import { updateRegister } from "../../books/connectors/parcels.server";
import { linkLoadsheets } from "../../books/courier-sheets.server";
import { refreshRegister } from "./parcels.server";
import { convertMoneyTree } from "../fx";
import { FX_HISTORY_FROM } from "../../metrics/fx-history";
import { bookRates } from "../fx.server";
import { ensureOwed, foreignDay, foreignStore, shadowEvents, type ForeignStore } from "./sales-foreign.server";
import { postDifference } from "./corrections.server";
import { factsAvailable, manualEvidence, releaseDays, statusFromOutcome, toShopOrder, type FeedOrder } from "./sales";
import type { RunResult } from "./runs.server";

/**
 * Sales (B3): one sales summary per store per day from Financify's orders, by
 * Financify's sales rules, with cash-on-delivery sales held until delivered
 * (or paid, dispatched) and returned parcels taken back off (porting guide
 * §4.3–§4.6, D-69, D-83). Stores without Financify enter sales by hand (D-90).
 *
 * New days come in 7 at a time, at most 31 per run. Growzar receives
 * Financify's orders up to an hour late (more if a webhook is missed), so each
 * run also re-checks the last 3 days it brought in: a draft day is refreshed;
 * a saved day gets a correction for what changed (pack rule 3), counting the
 * parcel events it was saved with, so nothing is taken off twice.
 */
const MAX_DAYS_PER_RUN = 31;
const DAYS_PER_CHUNK = 7;
const RECHECK_DAYS = 3;

export interface SalesSettings {
  mapping: SalesMapping;
  /** Last day brought in, per store. */
  progress?: Record<string, string>;
}

const SOURCE = "shopify_sales";

async function ensureAccount(book: BookView, name: string, type: AccountType, subtype: string, code?: string): Promise<string> {
  const all = await listAccounts(book, { includeArchived: true });
  const found = all.find((a) => a.name.toLowerCase() === name.toLowerCase() && a.type === type) ?? (code ? all.find((a) => a.code === code && a.type === type) : undefined);
  if (found) return found.id;
  return (await createAccount(book, { name, type, subtype }, null)).id;
}

export async function salesDefaults(book: BookView): Promise<SalesMapping> {
  const accounts = (await listAccounts(book)).filter((a) => !a.archived && !a.currency);
  const code = (c: string) => accounts.find((a) => a.code === c)?.id ?? "";
  return {
    sales: code("4000"),
    shipping: code("4010"),
    discounts: code("4020"),
    returns: code("4030"),
    tax: code("2100"),
    cod: code("1100"),
    prepaid: code("1110"),
    gateways: {},
    giftCards: accounts.find((a) => a.type === "liability" && /gift card/i.test(a.name))?.id ?? "",
    cogs: accounts.find((a) => a.systemKey === "cogs")?.id ?? "",
    stock: accounts.find((a) => a.systemKey === "stock")?.id ?? "",
    costFallbackPercent: null,
    parcelReturns: true,
    costSource: "at_sale",
    manualPayments: "detect",
    manualUnknown: "as_mapped",
    selfDelivery: accounts.find((a) => a.subtype === "cash")?.id ?? "",
    codBasis: book.settings.codBasis ?? "delivery",
    held: accounts.find((a) => a.type === "income" && /^cod sales held back/i.test(a.name))?.id ?? "",
  };
}

/** Check the mapping; make "COD sales held back" and "Gift cards not yet used" the first time they're needed. */
export async function checkSalesMapping(book: BookView, m: SalesMapping): Promise<SalesMapping> {
  const accounts = await listAccounts(book);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const need = (id: string | undefined, field: string, ok: (a: (typeof accounts)[number]) => boolean, what: string) => {
    const a = id ? byId.get(id) : undefined;
    if (!a || a.archived) throw new BooksError(`Choose an account for ${what}`, `mapping.${field}`);
    if (a.currency) throw new BooksError(`"${a.name}" is in ${a.currency}; sales come in ${book.currency}. Choose another account.`, `mapping.${field}`);
    if (!ok(a)) throw new BooksError(`"${a.name}" can't be used for ${what}`, `mapping.${field}`);
  };
  const income = (a: (typeof accounts)[number]) => a.type === "income";
  const owed = (a: (typeof accounts)[number]) => (a.type === "asset" && (a.subtype === "receivable" || isMoneySubtype(a.subtype))) || (a.type === "liability" && /gift card/i.test(a.name));
  need(m.sales, "sales", income, "sales");
  need(m.shipping, "shipping", income, "shipping charged");
  need(m.discounts, "discounts", income, "discounts");
  need(m.returns, "returns", income, "returns");
  need(m.tax, "tax", (a) => a.type === "liability" && a.subtype === "tax", "sales tax");
  need(m.cod, "cod", owed, "what couriers owe for cash on delivery");
  need(m.prepaid, "prepaid", owed, "what payment gateways owe");
  for (const [g, id] of Object.entries(m.gateways ?? {})) if (id) need(id, `gateways.${g}`, owed, `"${g}" payments`);
  if (m.cogs || m.stock) {
    need(m.cogs, "cogs", (a) => a.type === "expense", "cost of what you sold");
    need(m.stock, "stock", (a) => a.type === "asset" && a.subtype === "stock", "stock");
  }
  if (m.costFallbackPercent != null && !(m.costFallbackPercent >= 0 && m.costFallbackPercent <= 100)) throw new BooksError("A percentage must be between 0 and 100", "mapping.costFallbackPercent");
  const giftCards = m.giftCards || (await ensureAccount(book, "Gift cards not yet used", "liability", "other"));
  const held = m.held || (await ensureAccount(book, "COD sales held back", "income", "sales"));
  const codBasis = book.settings.codBasis ?? "delivery";
  return { ...m, giftCards, held, codBasis, manualPayments: m.manualPayments === "as_mapped" ? "as_mapped" : "detect", manualUnknown: "as_mapped", costSource: "at_sale" };
}

/** The book's stores and whether Financify serves their orders. */
export async function salesStores(book: BookView) {
  const stores = await prisma.store.findMany({
    where: { id: { in: book.settings.storeIds ?? [] } },
    select: { id: true, shopDomain: true, displayName: true, currency: true, connections: { where: { app: "FINANCIFY" }, select: { status: true } } },
  });
  return stores.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain, currency: s.currency, financify: s.connections.some((c) => c.status === "CONNECTED") }));
}

/** Payment gateways seen on a store's orders in the last 120 days, for the mapping screen. */
export async function recentGateways(book: BookView): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ g: string }>>`
    SELECT DISTINCT jsonb_array_elements_text(payload->'payment'->'gateways') AS g FROM raw_records
     WHERE "storeId" = ANY(${book.settings.storeIds ?? []}) AND app = 'FINANCIFY' AND entity = 'ORDER' AND "deletedAt" IS NULL
       AND (payload->>'createdAt')::timestamptz > now() - interval '120 days'`;
  return rows.map((r) => r.g).filter(Boolean).sort();
}

// ── Reading Growzar's data ──────────────────────────────────────────────────

/** Inventorify's unit cost per variant, the fallback when Financify has no cost at sale (D-78). */
async function inventorifyCosts(storeId: string): Promise<Map<string, string>> {
  const rows = await prisma.rawRecord.findMany({ where: { storeId, app: "INVENTORIFY", entity: "INVENTORY_VARIANT", deletedAt: null }, select: { payload: true } });
  const out = new Map<string, string>();
  for (const r of rows) {
    const p = r.payload as { variantId?: unknown; unitCost?: { amount?: unknown } | null };
    const v = p.unitCost?.amount;
    if (p.variantId != null && v != null && Number(v) > 0) out.set(String(p.variantId), String(v));
  }
  return out;
}

/** Orders placed on, or refunded or cancelled on, the days [from, to] (a day either side for time zones). */
async function loadOrders(storeId: string, from: string, to: string): Promise<FeedOrder[]> {
  const lo = addDays(from, -1);
  const hi = addDays(to, 1);
  const rows = await prisma.$queryRaw<Array<{ payload: FeedOrder }>>`
    SELECT payload FROM raw_records
     WHERE "storeId" = ${storeId} AND app = 'FINANCIFY' AND entity = 'ORDER' AND "deletedAt" IS NULL
       AND ((payload->>'localDay') BETWEEN ${lo} AND ${hi}
         OR substring(payload->>'cancelledAt', 1, 10) BETWEEN ${lo} AND ${hi}
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'refunds') = 'array' THEN payload->'refunds' ELSE '[]'::jsonb END) r
                     WHERE substring(r->>'createdAt', 1, 10) BETWEEN ${lo} AND ${hi}))`;
  return rows.map((r) => r.payload);
}

async function loadOrdersById(storeId: string, ids: string[]): Promise<FeedOrder[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.rawRecord.findMany({ where: { storeId, app: "FINANCIFY", entity: "ORDER", deletedAt: null, externalId: { in: ids } }, select: { payload: true } });
  return rows.map((r) => r.payload as unknown as FeedOrder);
}

/** Courierify's parcels for a store: which orders a courier carried, and when each was delivered, returned or paid. */
async function parcelFacts(storeId: string, dayOf: (iso: string) => string) {
  const rows = await prisma.rawRecord.findMany({ where: { storeId, app: "COURIERIFY", entity: "PARCEL", deletedAt: null }, select: { payload: true } });
  return rows
    .map((r) => r.payload as { orderId?: unknown; deliveredAt?: string | null; returnedAt?: string | null; settlement?: { settled?: boolean; settledAt?: string | null } | null })
    .filter((p) => p.orderId != null)
    .map((p) => ({
      orderId: String(p.orderId),
      deliveredDay: p.deliveredAt ? dayOf(p.deliveredAt) : null,
      returnedDay: p.returnedAt ? dayOf(p.returnedAt) : null,
      settledDay: p.settlement?.settled && p.settlement.settledAt ? dayOf(p.settlement.settledAt) : null,
    }));
}

// ── The run ──────────────────────────────────────────────────────────────────

type StoreCtx = {
  book: BookView;
  storeId: string;
  storeName: string;
  start: string;
  mapping: SalesMapping;
  dayOf: (iso: string) => string;
  costs: Map<string, string>;
  parcels: Awaited<ReturnType<typeof parcelFacts>>;
  grain: Array<{ orderId: string; outcome: string; day: string | null }>;
  /** A store in another currency than the book's: what it's owed is kept in its own (v1.1 V1b). */
  foreign: ForeignStore | null;
};

/**
 * Orders ready to sum, orders still waiting for Financify's details, and
 * orders in another currency than the book's. Those are converted at their
 * own day's rate (v1.1 V1, D-98): every amount on the order, refunds
 * included, so the order nets the same in the book's currency. With no rate
 * within a week before their day, they're left out with their cost and said
 * in the run's notes (D-95). Every caller converts the same way, so a
 * re-check never mistakes a converted order for a missing one.
 */
async function prepare(ctx: StoreCtx, rows: FeedOrder[]): Promise<{ orders: ShopOrder[]; waiting: FeedOrder[]; rateWaiting: FeedOrder[]; foreign: FeedOrder[]; converted: Converted[]; shadow: ShopOrder[] }> {
  const carried = new Set(ctx.parcels.map((p) => p.orderId));
  const book = ctx.book.currency;
  const orderCurrency = (r: FeedOrder) => r.currency?.code ?? book;
  const rateOf = await bookRates(ctx.book, rows.filter((r) => orderCurrency(r) !== book).map((r) => ({ currency: orderCurrency(r), day: ctx.dayOf(r.createdAt) })));
  const orders: ShopOrder[] = [];
  const waiting: FeedOrder[] = [];
  const foreign: FeedOrder[] = [];
  const converted: Converted[] = [];
  // v1.1 V1b: for a store in another currency, the same orders in the store's own currency.
  const shadow: ShopOrder[] = [];
  // Orders whose day's rate hasn't been filled in yet (D-98): their day waits, like one waiting for Financify's details.
  const rateWaiting: FeedOrder[] = [];
  for (const raw of rows) {
    if (!factsAvailable(raw)) {
      waiting.push(raw);
      continue;
    }
    let r = raw;
    const cur = orderCurrency(raw);
    if (cur !== book) {
      const rate = rateOf(cur, ctx.dayOf(raw.createdAt));
      const c = rate ? convertMoneyTree(raw, cur, book, rate.rate) : null;
      if (!rate || !c) {
        // A day Growzar fills rates for waits for its rate; only days before then are left out (D-95).
        (ctx.dayOf(raw.createdAt) >= FX_HISTORY_FROM ? rateWaiting : foreign).push(raw);
        continue;
      }
      r = { ...c, currency: { ...(c.currency ?? {}), code: book } };
      converted.push({ currency: cur, day: ctx.dayOf(raw.createdAt), source: rate.source, placed: raw.money?.placed?.amount ?? "0" });
    }
    let o = toShopOrder(r, ctx.costs);
    if (o.currency && o.currency !== book) {
      foreign.push(raw);
      continue;
    }
    if (ctx.foreign) {
      const own = inStoreCurrency(raw, cur, book, ctx.foreign, rateOf, ctx.dayOf(raw.createdAt));
      if (!own) {
        // No rate for the store's currency that day: the order can't be kept in both, so it waits like one with no rate.
        (ctx.dayOf(raw.createdAt) >= FX_HISTORY_FROM ? rateWaiting : foreign).push(raw);
        continue;
      }
      let so = toShopOrder(own, ctx.costs);
      if (ctx.mapping.manualPayments !== "as_mapped") so = routeManualPayment(so, manualEvidence(carried.has(so.id)));
      shadow.push(so);
    }
    if (ctx.mapping.manualPayments !== "as_mapped") o = routeManualPayment(o, manualEvidence(carried.has(o.id)));
    orders.push(o);
  }
  return { orders, waiting, rateWaiting, foreign, converted, shadow };
}

/** The given days summed in a foreign store's own currency, from the same orders and parcel events; null when a rate is missing. */
async function ownSummaries(ctx: StoreCtx, f: ForeignStore, dayList: string[], shadow: ShopOrder[], events: ParcelEvent[]) {
  const dayOfOrder = new Map(shadow.map((o) => [o.id, ctx.dayOf(o.createdAt)]));
  const missing = [...new Set(events.map((e) => e.orderId).filter((id) => !dayOfOrder.has(id)))];
  if (missing.length) for (const o of await loadOrdersById(ctx.storeId, missing)) dayOfOrder.set(o.orderId, ctx.dayOf(o.createdAt));
  const ownEvents = shadowEvents(events, ctx.book.decimals, f, (id) => dayOfOrder.get(id) ?? null);
  if (!ownEvents) return null;
  const placed = shadow.filter((o) => dayList.includes(ctx.dayOf(o.createdAt)));
  return summariseDays({ days: dayList, timeZone: ctx.book.settings.timeZone, startDate: ctx.start, decimals: f.decimals, mapping: ctx.mapping, placed, changed: shadow, parcels: ownEvents });
}

/** A foreign store's day as a sales summary's data: "owed" on its own-currency sub-accounts, with their amounts (v1.1 V1b). */
async function dayData(book: BookView, f: ForeignStore, s: DaySummary, own: DaySummary | null) {
  await ensureOwed(book, f, [...s.debits, ...s.credits].map((l) => l.accountId));
  const fd = foreignDay(book, f, s.day, s, own);
  return { ...toPosting(fd.sums), ...(Object.keys(fd.fx).length ? { fx: fd.fx } : {}) };
}

function toBookValue(book: BookView, f: ForeignStore, foreignMinor: bigint, rate: string): bigint {
  const [w, fr = ""] = rate.split(".");
  const scaled = parseFxRate(fr ? `${w}.${fr.slice(0, 8)}` : w!);
  return scaled === null ? 0n : toBookAmount(foreignMinor, f.currency, book.decimals, scaled);
}

/** An order in the store's own currency (v1.1 V1b): as it is, or converted through the book's rates for both currencies. */
function inStoreCurrency(raw: FeedOrder, cur: string, bookCurrency: string, f: ForeignStore, rateOf: (currency: string, day: string) => { rate: string } | null, day: string): FeedOrder | null {
  if (cur === f.currency) return raw;
  const store = f.rateOf(day);
  const bookPerOrder = cur === bookCurrency ? 1 : Number(rateOf(cur, day)?.rate ?? NaN);
  // Units of the store's currency per one of the order's.
  const cross = store ? bookPerOrder / Number(store.rate) : NaN;
  if (!Number.isFinite(cross) || cross <= 0) return null;
  const c = convertMoneyTree(raw, cur, f.currency, cross.toFixed(12).replace(/0+$/, "").replace(/\.$/, ""));
  return c ? { ...c, currency: { ...(c.currency ?? {}), code: f.currency } } : null;
}

type Converted = { currency: string; day: string; source: string; placed: string };

/** "12 orders in AED (2,140.50) converted into PKR at each day's rate (fawazahmed0 currency-api)", per currency. */
export function convertedNotes(storeName: string, bookCurrency: string, converted: readonly Converted[], from: string, to: string): string[] {
  const by = new Map<string, { n: number; total: number; sources: Set<string> }>();
  for (const c of converted) {
    if (c.day < from || c.day > to) continue;
    const e = by.get(c.currency) ?? { n: 0, total: 0, sources: new Set<string>() };
    e.n++;
    e.total += Number(c.placed);
    e.sources.add(c.source);
    by.set(c.currency, e);
  }
  return [...by].map(([cur, e]) => `${storeName}: ${e.n} order${e.n === 1 ? "" : "s"} in ${cur} (${e.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) converted into ${bookCurrency} at each day's rate (${[...e.sources].join(", ")})`);
}

/** D-95: "3 orders in AED (612.40) left out…", per currency, for orders placed in [from, to] with no rate to convert them. */
export function foreignNotes(storeName: string, bookCurrency: string, foreign: readonly FeedOrder[], dayOf: (iso: string) => string, from: string, to: string): string[] {
  const by = new Map<string, { n: number; total: number }>();
  for (const o of foreign) {
    const day = dayOf(o.createdAt);
    if (day < from || day > to) continue;
    const cur = o.currency?.code ?? "another currency";
    const e = by.get(cur) ?? { n: 0, total: 0 };
    e.n++;
    e.total += Number(o.money?.placed?.amount ?? 0);
    by.set(cur, e);
  }
  return [...by].map(
    ([cur, e]) =>
      `${storeName}: ${e.n} order${e.n === 1 ? "" : "s"} in ${cur} (${e.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) left out, from ${formatDate(from)} to ${formatDate(to)}: your books are in ${bookCurrency}. Enter ${e.n === 1 ? "it" : "them"} by hand in ${bookCurrency} if you know what ${e.n === 1 ? "it" : "they"} came to`,
  );
}

/** Parcel events for days [from, to] of one store: returns, holds and releases (Financify's parcelEventsFor, on Growzar's data). */
async function parcelEventsFor(ctx: StoreCtx, from: string, to: string, known: ShopOrder[]): Promise<ParcelEvent[]> {
  const { book, mapping: m } = ctx;
  const [prior, skipRows] = await Promise.all([
    prisma.bkParcelEvent.findMany({
      where: { bookId: book.id, storeId: ctx.storeId, kind: { not: "skip" }, OR: [{ day: { lt: toDbDate(from) } }, { kind: "lost" }] },
      select: { orderId: true, orderName: true, kind: true, lines: true, document: { select: { status: true } } },
      orderBy: [{ day: "asc" }, { createdAt: "asc" }],
    }),
    prisma.bkParcelEvent.findMany({ where: { bookId: book.id, storeId: ctx.storeId, kind: "skip" }, select: { orderId: true } }),
  ]);
  const parts = new Map<string, { lines: ParcelLines[]; orderName: string; lastKind: string }>();
  for (const e of prior) {
    if (!e.document || e.document.status === "cancelled") continue;
    const p = parts.get(e.orderId) ?? { lines: [], orderName: e.orderName, lastKind: e.kind };
    p.lines.push(e.lines as ParcelLines);
    p.lastKind = e.kind;
    parts.set(e.orderId, p);
  }
  const active = new Map<string, { lines: ParcelLines; orderName: string; recheck?: boolean }>();
  for (const [id, p] of parts) {
    const lines = sumLines(p.lines);
    if (Object.keys(lines).length) active.set(id, { lines, orderName: p.orderName, recheck: p.lastKind === "lost" });
  }
  const skipped = new Set(skipRows.map((r) => r.orderId));
  const statusOf = new Map(ctx.grain.map((g) => [g.orderId, statusFromOutcome(g.outcome)]));
  // The register's own evidence (B5b): a settlement file's paid and returned parcels, a loadsheet's dispatch date.
  const register = await prisma.bkParcel.findMany({ where: { bookId: book.id, storeId: ctx.storeId }, select: { orderId: true, settledStatus: true, settledAt: true, payoutDocId: true, dispatchedOn: true } });
  for (const p of register) if (p.settledStatus === "returned") statusOf.set(p.orderId, "RETURNED");
  const registerFacts = register.map((p) => ({
    orderId: p.orderId,
    deliveredDay: null,
    returnedDay: null,
    settledDay: (p.settledStatus === "delivered" || p.payoutDocId) && p.settledAt ? p.settledAt.toISOString().slice(0, 10) : null,
  }));
  const dispatched = register.filter((p) => p.dispatchedOn).map((p) => ({ orderId: p.orderId, outcome: "in_transit", day: p.dispatchedOn!.toISOString().slice(0, 10) }));
  const basis = m.codBasis ?? "order";
  let hold: Parameters<typeof parcelChanges>[0]["hold"] = undefined;
  if (m.held && (basis === "delivery" || basis === "dispatch" || basis === "money")) {
    // Growzar knows the day each order was delivered (or paid), so a sale is let in on that day, never
    // just because tracking says delivered now (Financify's rule, made for tracking without dates).
    hold = { account: m.held, onDay: releaseDays(basis, { grain: [...ctx.grain, ...dispatched], parcels: [...ctx.parcels, ...registerFacts] }), deliveredReleases: false };
  } else if (m.held && [...active.values()].some((a) => a.lines[m.held!] !== undefined)) {
    // Switched back to "when ordered": everything still held is let in now.
    hold = { account: m.held, onDay: new Map(), allOut: true };
  }
  const knownById = new Map(known.map((o) => [legacyOrderId(o.id), o]));
  const heldActive = new Set(hold ? [...active].filter(([, a]) => a.lines[hold!.account] !== undefined).map(([id]) => id) : []);
  const activePlain = new Set([...active].filter(([, a]) => !a.recheck).map(([id]) => id));
  const want = ctx.grain
    .filter((g) => isReturnedStatus(statusOf.get(g.orderId)) && (!activePlain.has(g.orderId) || heldActive.has(g.orderId)) && !skipped.has(g.orderId))
    .map((g) => g.orderId);
  const orders: ShopOrder[] = [];
  const missing: string[] = [];
  for (const id of want) {
    const k = knownById.get(id);
    if (k) orders.push(k);
    else missing.push(id);
  }
  orders.push(...(await prepare(ctx, await loadOrdersById(ctx.storeId, missing))).orders);
  for (const x of known) if (active.has(x.id)) orders.push(x);
  if (hold && !hold.allOut) for (const x of known) if (!active.has(x.id) && ctx.dayOf(x.createdAt) >= from) orders.push(x);
  return parcelChanges({ orders, statusOf, active, from, to, startDate: ctx.start, timeZone: book.settings.timeZone, decimals: book.decimals, mapping: m, hold });
}

async function saveParcelEvents(ctx: StoreCtx, day: string, events: ParcelEvent[], documentId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.bkParcelEvent.deleteMany({ where: { bookId: ctx.book.id, storeId: ctx.storeId, day: toDbDate(day), kind: { in: ["returned", "reinstated", "adjusted", "held", "released"] } } });
    if (events.length) {
      await tx.bkParcelEvent.createMany({
        data: events.map((p) => ({ bookId: ctx.book.id, storeId: ctx.storeId, orderId: p.orderId, orderName: p.orderName, day: toDbDate(p.day), kind: p.kind, lines: p.lines as Prisma.InputJsonValue, documentId })),
      });
    }
  });
}

const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/**
 * Books v1.1 V4 (Financify's stock check): what the sales connector would
 * move on Stock for a store's days it hasn't brought in yet (up to today),
 * and what its saved drafts would, by its own rules: cost taken off with each
 * sale it counts, put back for returns. Negative: stock still to come off.
 * Null when sales aren't set up with cost tracking for the store.
 */
export async function stockNotYetIn(book: BookView, storeId: string): Promise<{ notYetIn: bigint; drafts: bigint; from: string } | null> {
  const connector = await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId: book.id, key: SOURCE } } });
  const settings = (connector?.settings ?? {}) as unknown as SalesSettings;
  const start = connector?.startDate?.toISOString().slice(0, 10);
  if (!connector?.enabled || !start || !settings.mapping?.cogs || !settings.mapping.stock) return null;
  const store = (await salesStores(book)).find((s) => s.id === storeId);
  if (!store?.financify) return null;
  const tz = book.settings.timeZone;
  const today = todayIn(tz);
  const dayOf = (iso: string) => todayIn(tz, new Date(iso));
  const mapping: SalesMapping = { ...settings.mapping, codBasis: book.settings.codBasis ?? settings.mapping.codBasis ?? "delivery" };
  const stockId = mapping.stock!;
  const net = (p: { debits?: Array<{ accountId: string; amount: string }>; credits?: Array<{ accountId: string; amount: string }> } | null) =>
    (p?.debits ?? []).filter((l) => l.accountId === stockId).reduce((t, l) => t + BigInt(l.amount), 0n) - (p?.credits ?? []).filter((l) => l.accountId === stockId).reduce((t, l) => t + BigInt(l.amount), 0n);
  const drafts = (await prisma.bkDocument.findMany({ where: { bookId: book.id, source: SOURCE, storeId, status: "draft" }, select: { data: true } })).reduce((t, d) => t + net(d.data as never), 0n);
  const done = settings.progress?.[storeId] ?? null;
  const from = done ? addDays(done, 1) : start;
  if (from > today) return { notYetIn: 0n, drafts, from };
  const [costs, parcels, grainRows] = await Promise.all([
    inventorifyCosts(store.id),
    parcelFacts(store.id, dayOf),
    prisma.orderGrain.findMany({ where: { storeId: store.id, localDay: { gte: addDays(start, -1) } }, select: { orderId: true, outcome: true, outcomeAt: true } }),
  ]);
  const ctx: StoreCtx = { book, storeId: store.id, storeName: store.name, start, mapping, dayOf, costs: store.currency && store.currency !== book.currency ? new Map() : costs, parcels, grain: grainRows.map((g) => ({ orderId: g.orderId, outcome: g.outcome, day: g.outcomeAt ? dayOf(g.outcomeAt.toISOString()) : null })), foreign: await foreignStore(book, store.currency, mapping, start, today) };
  const { orders } = await prepare(ctx, await loadOrders(store.id, from, today));
  const placed = orders.filter((o) => ctx.dayOf(o.createdAt) >= from && ctx.dayOf(o.createdAt) <= today);
  const events = mapping.parcelReturns === false ? [] : await parcelEventsFor(ctx, from, today, orders);
  const summaries = summariseDays({ days: days(from, today), timeZone: tz, startDate: start, decimals: book.decimals, mapping, placed, changed: orders, parcels: events });
  return { notYetIn: summaries.reduce((t, s) => t + net(s), 0n), drafts, from };
}

export async function runSales(book: BookView, connector: BkConnector): Promise<RunResult> {
  const r: RunResult = { status: "ok", created: 0, updated: 0, skipped: 0, notes: [], from: null, to: null };
  const settings = (connector.settings ?? {}) as unknown as SalesSettings;
  const start = connector.startDate?.toISOString().slice(0, 10);
  if (!start || !settings.mapping) return { ...r, status: "error", notes: ["Finish setting up sales first"] };
  const tz = book.settings.timeZone;
  const today = todayIn(tz);
  const yesterday = addDays(today, -1);
  const dayOf = (iso: string) => todayIn(tz, new Date(iso));
  // The book's own choice of when COD sales count (D-69, D-83) wins over what the mapping last saved.
  const mapping: SalesMapping = { ...settings.mapping, codBasis: book.settings.codBasis ?? settings.mapping.codBasis ?? "delivery" };
  const progress = { ...(settings.progress ?? {}) };

  for (const store of await salesStores(book)) {
    if (!store.financify) {
      r.notes.push(`${store.name}: Financify isn't connected, so its sales are entered by hand`);
      continue;
    }
    try {
      const [costs, parcels, grainRows] = await Promise.all([
        inventorifyCosts(store.id),
        parcelFacts(store.id, dayOf),
        prisma.orderGrain.findMany({ where: { storeId: store.id, localDay: { gte: addDays(start, -1) } }, select: { orderId: true, outcome: true, outcomeAt: true } }),
      ]);
      // Inventorify's costs are in the store's currency: of no use to a book in another (orders carry Financify's cost, converted).
      const ctx: StoreCtx = { book, storeId: store.id, storeName: store.name, start, mapping, dayOf, costs: store.currency && store.currency !== book.currency ? new Map() : costs, parcels, grain: grainRows.map((g) => ({ orderId: g.orderId, outcome: g.outcome, day: g.outcomeAt ? dayOf(g.outcomeAt.toISOString()) : null })), foreign: await foreignStore(book, store.currency, mapping, start, today) };
      const done = progress[store.id] ?? null;

      // 1. The last days already brought in, re-checked for data that arrived late.
      if (done) {
        const lo = addDays(done, -(RECHECK_DAYS - 1)) < start ? start : addDays(done, -(RECHECK_DAYS - 1));
        await recheck(ctx, lo, done, today, connector.mode, r);
      }

      // Items with no cost, summed over the run: one note per store, not one per day (each day's entry names its own).
      const noCost = { items: 0, days: 0, first: "", last: "", estimated: false };
      let waited = false;

      // 2. New days.
      let from = done ? addDays(done, 1) : start;
      const to = addDays(from, MAX_DAYS_PER_RUN - 1) < yesterday ? addDays(from, MAX_DAYS_PER_RUN - 1) : yesterday;
      for (let chunkFrom = from; chunkFrom <= to; chunkFrom = addDays(chunkFrom, DAYS_PER_CHUNK)) {
        let chunkTo = addDays(chunkFrom, DAYS_PER_CHUNK - 1) < to ? addDays(chunkFrom, DAYS_PER_CHUNK - 1) : to;
        const { orders, waiting, rateWaiting, foreign, converted, shadow } = await prepare(ctx, await loadOrders(store.id, chunkFrom, chunkTo));
        // A day isn't summed while one of its orders still waits for Financify's details, or for its day's rate.
        const firstOf = (list: FeedOrder[]) => list.map((w) => dayOf(w.createdAt)).filter((d) => d >= chunkFrom && d <= chunkTo).sort()[0];
        const [forDetails, forRate] = [firstOf(waiting), firstOf(rateWaiting)];
        const firstWaiting = [forDetails, forRate].filter((d): d is string => !!d).sort()[0];
        if (firstWaiting) {
          chunkTo = addDays(firstWaiting, -1);
          r.status = "partial";
          if (forDetails) r.notes.push(`${store.name}: ${waiting.length} order${waiting.length === 1 ? "" : "s"} from ${formatDate(forDetails)} still wait${waiting.length === 1 ? "s" : ""} for Financify's details; those days come in on a later run`);
          if (forRate) r.notes.push(`${store.name}: ${rateWaiting.length} order${rateWaiting.length === 1 ? "" : "s"} from ${formatDate(forRate)} in another currency wait${rateWaiting.length === 1 ? "s" : ""} for the day's exchange rate; those days come in once it's filled in`);
          waited = true;
          if (chunkTo < chunkFrom) break;
        }
        r.notes.push(...convertedNotes(store.name, book.currency, converted, chunkFrom, chunkTo));
        r.notes.push(...foreignNotes(store.name, book.currency, foreign, ctx.dayOf, chunkFrom, chunkTo));
        const placed = orders.filter((o) => ctx.dayOf(o.createdAt) >= chunkFrom && ctx.dayOf(o.createdAt) <= chunkTo);
        const changed = orders;
        const parcelEvents = mapping.parcelReturns === false ? [] : await parcelEventsFor(ctx, chunkFrom, chunkTo, orders);
        const summaries = summariseDays({ days: days(chunkFrom, chunkTo), timeZone: tz, startDate: start, decimals: book.decimals, mapping, placed, changed, parcels: parcelEvents });
        // A store in another currency: the same days summed in its own currency, for what it's owed (v1.1 V1b).
        const own = ctx.foreign ? await ownSummaries(ctx, ctx.foreign, days(chunkFrom, chunkTo), shadow, parcelEvents) : null;
        if (ctx.foreign && !own) {
          r.status = "partial";
          r.notes.push(`${store.name}: no ${ctx.foreign.currency} rate for some days from ${formatDate(chunkFrom)}; those days come in on a later run`);
          break;
        }
        for (const s of summaries) {
          const data = ctx.foreign ? await dayData(book, ctx.foreign, s, own!.find((x) => x.day === s.day) ?? null) : { debits: s.debits, credits: s.credits };
          const res = await upsertImported(book, { source: SOURCE, sourceRef: `${store.id}:${s.day}`, type: "sales_summary", date: s.day, data, memo: `${store.name} — ${s.memo.replace(/^Shopify: /, "")}`, storeId: store.id });
          if (res.action === "created") r.created++;
          else if (res.action === "updated") r.updated++;
          else r.skipped++;
          // A day already saved keeps the parcels it was saved with.
          if (res.action !== "kept") await saveParcelEvents(ctx, s.day, parcelEvents.filter((p) => p.day === s.day && p.kind !== "skip" && p.kind !== "lost"), res.doc.id);
          if (connector.mode === "auto" && res.doc.status === "draft") {
            try {
              await postDocument(book, res.doc.id, null);
            } catch (e) {
              r.status = "partial";
              r.notes.push(`${store.name}, ${formatDate(s.day)}: kept as a draft — ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (s.missingCost) {
            noCost.items += s.missingCost;
            noCost.days++;
            noCost.first ||= s.day;
            noCost.last = s.day;
            noCost.estimated ||= !!s.estimatedCost;
          }
        }
        // The parcel register: what each cash-on-delivery order owes, by the same rules (B5b).
        await updateRegister(book, mapping, orders, ctx.start, chunkTo, store.id);
        await linkLoadsheets(book);
        const skips = parcelEvents.filter((p) => p.kind === "skip");
        if (skips.length) await prisma.bkParcelEvent.createMany({ data: skips.map((p) => ({ bookId: book.id, storeId: store.id, orderId: p.orderId, orderName: p.orderName, day: toDbDate(p.day), kind: "skip", lines: {} })), skipDuplicates: true });
        progress[store.id] = chunkTo;
        r.from ??= chunkFrom;
        r.to = chunkTo;
        if (firstWaiting) break;
      }
      await refreshRegister(book, store.id);
      if (to < yesterday && !waited) {
        r.status = "partial";
        r.notes.push(`${store.name}: brought in up to ${formatDate(progress[store.id] ?? to)}; the next run carries on`);
      }
      if (noCost.items) {
        r.notes.push(
          `${store.name}: ${noCost.items} item${noCost.items === 1 ? "" : "s"} with no cost in Shopify on ${noCost.days} day${noCost.days === 1 ? "" : "s"} (${formatDate(noCost.first)} – ${formatDate(noCost.last)}), ${noCost.estimated ? "estimated" : "left out of cost of sales; add their cost in Shopify, or set an estimate under sales"}`,
        );
      }
    } catch (e) {
      r.status = "partial";
      r.notes.push(e instanceof BooksError ? e.message : `${store.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const all = Object.values(progress).sort();
  await prisma.bkConnector.update({ where: { id: connector.id }, data: { settings: { ...settings, progress } as unknown as Prisma.InputJsonValue, ...(all[0] ? { syncedThrough: toDbDate(all[0]) } : {}) } });
  return r;
}

/**
 * Days [from, to] already brought in, against what Growzar holds now: the
 * day's orders, refunds and cancellations, with the parcel events the day was
 * saved with. A draft is refreshed; a saved day gets a correction.
 */
async function recheck(ctx: StoreCtx, from: string, to: string, today: string, mode: string, r: RunResult) {
  const { book } = ctx;
  const { orders, waiting, rateWaiting, shadow } = await prepare(ctx, await loadOrders(ctx.storeId, from, to));
  const waitingDays = new Set([...waiting, ...rateWaiting].map((w) => ctx.dayOf(w.createdAt)));
  for (const day of days(from, to)) {
    if (waitingDays.has(day)) continue;
    const saved = await prisma.bkParcelEvent.findMany({ where: { bookId: book.id, storeId: ctx.storeId, day: toDbDate(day), kind: { in: ["returned", "reinstated", "adjusted", "held", "released"] } } });
    const parcels: ParcelEvent[] = saved.map((e) => ({ orderId: e.orderId, orderName: e.orderName, day, kind: e.kind as ParcelEvent["kind"], lines: e.lines as ParcelLines }));
    const placed = orders.filter((o) => ctx.dayOf(o.createdAt) === day);
    const [s] = summariseDays({ days: [day], timeZone: book.settings.timeZone, startDate: ctx.start, decimals: book.decimals, mapping: ctx.mapping, placed, changed: orders, parcels });
    const own = ctx.foreign ? await ownSummaries(ctx, ctx.foreign, [day], shadow, parcels) : null;
    if (ctx.foreign && !own) continue; // no rate yet: looked at again next run
    const ownDay = own?.[0] ?? null;
    const base = `${ctx.storeId}:${day}`;
    const doc = await prisma.bkDocument.findFirst({ where: { bookId: book.id, source: SOURCE, sourceRef: base } });
    if (!doc || doc.status === "draft") {
      if (!s) continue;
      const data = ctx.foreign ? await dayData(book, ctx.foreign, s, ownDay) : { debits: s.debits, credits: s.credits };
      const res = await upsertImported(book, { source: SOURCE, sourceRef: base, type: "sales_summary", date: day, data, memo: `${ctx.storeName} — ${s.memo.replace(/^Shopify: /, "")}`, storeId: ctx.storeId });
      if (res.action === "created") r.created++;
      else if (res.action === "updated") r.updated++;
      if (mode === "auto" && res.doc.status === "draft") await postDocument(book, res.doc.id, null).catch(() => undefined);
      continue;
    }
    if (doc.status !== "posted") continue;
    const memo = `${ctx.storeName}: sales for ${formatDate(day)} changed after they were saved (${doc.number})`;
    if (ctx.foreign) {
      const f = ctx.foreign;
      if (s) await ensureOwed(book, f, [...s.debits, ...s.credits].map((l) => l.accountId));
      const fd = foreignDay(book, f, day, s ?? null, ownDay);
      const rate = f.rateOf(day);
      await postDifference(book, { source: SOURCE, base, day, today, current: fd.sums, memo, storeId: ctx.storeId, mode, foreign: { current: fd.fxSigned, toBook: (v) => (rate ? toBookValue(book, f, v, rate.rate) : 0n), gains: f.gains } }, r);
      continue;
    }
    await postDifference(book, { source: SOURCE, base, day, today, current: toSums(s ? { debits: s.debits, credits: s.credits } : null), memo, storeId: ctx.storeId, mode }, r);
  }
}

/** The settings form, checked. A new first day starts every store over. */
export async function parseSalesForm(book: BookView, previous: { startDate: string | null; settings: Record<string, unknown> }, input: { enabled: boolean; mode: string; startDate: string; mapping: SalesMapping }, today: string) {
  if (!isIsoDate(input.startDate)) throw new BooksError("Choose the first day to bring in", "startDate");
  if (input.startDate >= today) throw new BooksError("Sales come in up to yesterday; choose an earlier day", "startDate");
  const bookStart = book.settings.startDate;
  if (bookStart && input.startDate < bookStart) throw new BooksError(`Your books start on ${formatDate(bookStart)}; choose that day or later`, "startDate");
  const mapping = await checkSalesMapping(book, input.mapping);
  const keep = previous.startDate === input.startDate ? ((previous.settings as Partial<SalesSettings>).progress ?? {}) : {};
  const settings: SalesSettings = { mapping, progress: keep };
  return { enabled: input.enabled, mode: input.mode === "auto" ? ("auto" as const) : ("draft" as const), startDate: input.startDate, settings };
}
