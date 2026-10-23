/**
 * The parcel register (see parcels.ts for the rules): kept up to date by the
 * sales connector, filled in from Courierify's parcels and Growzar's order
 * outcomes (Growzar: app/lib/books-app/connectors/parcels.server.ts), and
 * acted on from the Couriers screen — write off lost or short-paid parcels,
 * mark a return as damaged. Every action is a normal entry in the books.
 *
 * Growzar: ported from Financify's Books (0cc8732) without the Shopify reads
 * (the register's details come from Growzar's data), without "record payouts
 * from the order" (the courier-payout connector posts them) and without the
 * month-end returns allowance (out of version 1, D-88). Rows carry the store.
 */

import type { BkParcel, Prisma } from "@prisma/client";
import { prisma } from "~/lib/db.server";
import { BooksError, createAccount, fromDbDate, ledgerSums, listAccounts, saveAndPost, toDbDate, type BookView } from "../books.server";
import { todayIn } from "../dates";
import { DEFAULT_STAGE_RULES, OPEN_STAGES, STAGE_LABELS, courierAccounts, openAmount, owedFigures, parcelStage, settledGross, type ParcelStage, type StageRules } from "./parcels";
import { decimalToMinor, sumLines, type ParcelLines, type SalesMapping, type ShopOrder } from "./shopify-sales";

/** Growzar: a connector's settings and switch, read here so the engine needs no connector code. */
async function connectorRow(bookId: string, key: string) {
  const c = await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId, key } }, select: { enabled: true, settings: true } });
  return { enabled: !!c?.enabled, settings: (c?.settings ?? {}) as { mapping?: SalesMapping } };
}

// ── Kept up to date by the Shopify sales import ──────────────────────────────

/** Add or refresh the register rows for orders the import just read (what's owed by Shopify's rules, as of `asOf`). */
export async function updateRegister(book: BookView, mapping: SalesMapping, orders: ShopOrder[], startDate: string, asOf: string, storeId: string | null = null): Promise<void> {
  const tz = book.settings.timeZone;
  const seen = new Map<string, ShopOrder>();
  for (const o of orders) if (!o.test) seen.set(o.id, o);
  const rows: Array<{ orderId: string; orderName: string; placedDay: string; accountId: string; saleOwed: bigint; owed: bigint; shipped: boolean | null }> = [];
  for (const o of seen.values()) {
    const day = todayIn(tz, new Date(o.createdAt));
    if (day < startDate || day > asOf) continue;
    const f = owedFigures(o, mapping, book.decimals, tz, asOf, []);
    if (!f) continue;
    rows.push({ orderId: o.id, orderName: o.name, placedDay: day, accountId: f.accountId, saleOwed: f.saleOwed, owed: f.owed, shipped: o.shipped ?? null });
  }
  if (rows.length === 0) return;
  const existing = new Map((await prisma.bkParcel.findMany({ where: { bookId: book.id, orderId: { in: rows.map((r) => r.orderId) } }, select: { id: true, orderId: true, saleOwed: true, owed: true, shipped: true, orderName: true, accountId: true } })).map((r) => [r.orderId, r]));
  const fresh = rows.filter((r) => !existing.has(r.orderId));
  if (fresh.length) {
    await prisma.bkParcel.createMany({
      data: fresh.map((r) => ({ bookId: book.id, storeId, orderId: r.orderId, orderName: r.orderName, placedDay: toDbDate(r.placedDay), accountId: r.accountId, saleOwed: r.saleOwed, owed: r.owed, shipped: r.shipped })),
      skipDuplicates: true,
    });
  }
  for (const r of rows) {
    const e = existing.get(r.orderId);
    if (!e) continue;
    if (e.saleOwed === r.saleOwed && e.owed === r.owed && e.orderName === r.orderName && e.accountId === r.accountId && (r.shipped === null || e.shipped === r.shipped)) continue;
    await prisma.bkParcel.update({ where: { id: e.id }, data: { saleOwed: r.saleOwed, owed: r.owed, orderName: r.orderName, accountId: r.accountId, ...(r.shipped === null ? {} : { shipped: r.shipped }) } });
  }
}

// ── Reading the register ─────────────────────────────────────────────────────

export interface ParcelView {
  id: string;
  orderId: string;
  orderName: string;
  placedDay: string;
  courier: string;
  trackingNumber: string | null;
  trackingStatus: string | null;
  shippedOn: string | null;
  deliveredOn: string | null;
  saleOwed: bigint;
  /** Owed after Shopify's changes and Books' parcel entries (returns, write-offs as lost). */
  owed: bigint;
  paid: bigint;
  writtenOff: bigint;
  open: bigint;
  stage: ParcelStage;
  bookedFees: bigint | null;
  settlementRef: string | null;
  settledOn: string | null;
  settledGross: bigint | null;
  settledFees: bigint | null;
  payoutDocId: string | null;
  writeoffDocId: string | null;
  damaged: bigint;
  damagedDocId: string | null;
  /** Held off the books (not a sale yet) and no tracking news for too long: lost on the way? */
  heldStuck: boolean;
  /** Cost Books put back into stock for it (a parcel that came back). */
  costBack: bigint;
}

const UNKNOWN_COURIER = "Courier not known yet";

/** Books' parcel entries per order that still count (their documents not cancelled or discarded). */
export async function parcelSums(bookId: string, orderIds?: string[]): Promise<Map<string, { lines: ParcelLines; lastKind: string }>> {
  const events = await prisma.bkParcelEvent.findMany({
    where: { bookId, kind: { not: "skip" }, documentId: { not: null }, ...(orderIds ? { orderId: { in: orderIds } } : {}) },
    select: { orderId: true, lines: true, kind: true, document: { select: { status: true } } },
    orderBy: [{ day: "asc" }, { createdAt: "asc" }],
  });
  const by = new Map<string, { all: ParcelLines[]; lastKind: string }>();
  for (const e of events) {
    if (!e.document || e.document.status === "cancelled") continue;
    const x = by.get(e.orderId) ?? { all: [], lastKind: e.kind };
    x.all.push(e.lines as ParcelLines);
    x.lastKind = e.kind;
    by.set(e.orderId, x);
  }
  return new Map([...by].map(([k, v]) => [k, { lines: sumLines(v.all), lastKind: v.lastKind }]));
}

function toView(r: BkParcel, sums: Map<string, { lines: ParcelLines }>, stock: string | undefined, live: Set<string>, today: string, rules: StageRules, held?: string): ParcelView {
  const lines = sums.get(r.orderId)?.lines ?? {};
  const owed = r.owed + BigInt(lines[r.accountId] ?? "0");
  // A cancelled payout or write-off no longer counts.
  const paid = r.payoutDocId && live.has(r.payoutDocId) ? r.paid : 0n;
  const writtenOff = r.writeoffDocId && live.has(r.writeoffDocId) ? r.writtenOff : 0n;
  const damaged = r.damagedDocId && live.has(r.damagedDocId) ? r.damaged : 0n;
  const stage = parcelStage(
    { saleOwed: r.saleOwed, owed: owed < 0n ? 0n : owed, paid, writtenOff, shipped: r.shipped, trackingStatus: r.trackingStatus, trackingAt: r.trackingAt, placedDay: fromDbDate(r.placedDay)!, settledAt: r.settledAt, settledNet: r.settledNet, settledFees: r.settledFees },
    today,
    rules,
  );
  const wasLost = sums.get(r.orderId) && (sums.get(r.orderId) as { lastKind?: string }).lastKind === "lost";
  const isHeld = !!held && lines[held] !== undefined;
  return {
    id: r.id,
    orderId: r.orderId,
    orderName: r.orderName,
    placedDay: fromDbDate(r.placedDay)!,
    courier: r.courier || UNKNOWN_COURIER,
    trackingNumber: r.trackingNumber,
    trackingStatus: r.trackingStatus,
    shippedOn: r.trackingAt ? r.trackingAt.toISOString().slice(0, 10) : null,
    deliveredOn: r.deliveredAt ? r.deliveredAt.toISOString().slice(0, 10) : null,
    saleOwed: r.saleOwed,
    owed: owed < 0n ? 0n : owed,
    paid,
    writtenOff,
    open: openAmount({ owed: owed < 0n ? 0n : owed, paid, writtenOff }),
    // Held off the books until dispatched or delivered: not a sale yet, so nothing is owed for it.
    stage: isHeld ? "held" : wasLost && owed <= 0n && stage !== "came_back" ? "written_off" : stage,
    heldStuck: isHeld && parcelStage({ saleOwed: r.saleOwed, owed: r.saleOwed, paid: 0n, writtenOff: 0n, shipped: r.shipped, trackingStatus: r.trackingStatus, trackingAt: r.trackingAt, placedDay: fromDbDate(r.placedDay)!, settledAt: null, settledNet: null, settledFees: null }, today, rules) === "stuck",
    bookedFees: r.bookedFees,
    settlementRef: r.settlementRef,
    settledOn: r.settledAt ? todayIn(null, r.settledAt) : null,
    settledGross: r.settledAt ? settledGross(r.settledNet, r.settledFees) : null,
    settledFees: r.settledFees,
    payoutDocId: paid > 0n ? r.payoutDocId : null,
    writeoffDocId: r.writeoffDocId && live.has(r.writeoffDocId) ? r.writeoffDocId : null,
    damaged,
    damagedDocId: damaged > 0n ? r.damagedDocId : null,
    costBack: stock ? BigInt(lines[stock] ?? "0") : 0n,
  };
}

async function liveDocs(bookId: string, ids: Array<string | null>): Promise<Set<string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Set();
  const docs = await prisma.bkDocument.findMany({ where: { bookId, id: { in: want }, status: "posted" }, select: { id: true } });
  return new Set(docs.map((d) => d.id));
}

export function stageRules(book: BookView): StageRules {
  const s = (book.settings as { parcelRules?: Partial<StageRules> }).parcelRules ?? {};
  const ok = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 3 && v <= 180 ? v : d);
  return { stuckAfterDays: ok(s.stuckAfterDays, DEFAULT_STAGE_RULES.stuckAfterDays), unshippedAfterDays: ok(s.unshippedAfterDays, DEFAULT_STAGE_RULES.unshippedAfterDays) };
}

/** Every parcel with its stage (open ones and ones that changed in the last `recentDays`). */
export async function loadParcels(book: BookView, today: string): Promise<ParcelView[]> {
  const [rows, sums, accounts, sales] = await Promise.all([prisma.bkParcel.findMany({ where: { bookId: book.id }, orderBy: { placedDay: "desc" } }), parcelSums(book.id), listAccounts(book, { includeArchived: true }), connectorRow(book.id, "shopify_sales")]);
  const held = sales.settings.mapping?.held;
  const live = await liveDocs(book.id, rows.flatMap((r) => [r.payoutDocId, r.writeoffDocId, r.damagedDocId]));
  const stock = accounts.find((a) => a.systemKey === "stock")?.id;
  const rules = stageRules(book);
  return rows.map((r) => toView(r, sums, stock, live, today, rules, held));
}

export interface CourierRow {
  courier: string;
  stages: Partial<Record<ParcelStage, { count: number; amount: bigint }>>;
  open: bigint;
}

/** The Couriers screen: balances by courier and stage, and how the register squares with the books. */
export async function courierOverview(book: BookView, today: string) {
  const [parcels, sales, courierify] = await Promise.all([loadParcels(book, today), connectorRow(book.id, "shopify_sales"), connectorRow(book.id, "courierify_payouts")]);
  const mapping = sales.settings.mapping ?? null;
  const owedTo = mapping ? courierAccounts(mapping) : new Set<string>();
  // Growzar (v1.1 V1b): with the sub-accounts a store in another currency is owed through.
  const accounts = (await prisma.bkAccount.findMany({ where: { bookId: book.id }, select: { id: true, parentId: true } })).filter((a) => owedTo.has(a.id) || (a.parentId && owedTo.has(a.parentId))).map((a) => a.id);
  const balances = await ledgerSums(book.id);
  const ledger = accounts.reduce((s, id) => s + (balances.get(id) ?? 0n), 0n);
  const byCourier = new Map<string, CourierRow>();
  for (const p of parcels) {
    const row = byCourier.get(p.courier) ?? { courier: p.courier, stages: {}, open: 0n };
    const st = (row.stages[p.stage] ??= { count: 0, amount: 0n });
    st.count++;
    st.amount += OPEN_STAGES.includes(p.stage) ? p.open : p.stage === "overpaid" ? p.open : p.saleOwed;
    if (OPEN_STAGES.includes(p.stage) || p.stage === "overpaid") row.open += p.open;
    byCourier.set(p.courier, row);
  }
  const registerOpen = parcels.reduce((s, p) => s + (OPEN_STAGES.includes(p.stage) || p.stage === "overpaid" ? p.open : 0n), 0n);
  // Payouts in the books not tied to parcels (typed in by hand, or whole payouts) also reduce the balance.
  const linked = new Set(parcels.map((p) => p.payoutDocId).filter(Boolean) as string[]);
  const payoutDocs = await prisma.bkDocument.findMany({ where: { bookId: book.id, type: "courier_payout", status: "posted" }, select: { id: true, number: true, date: true, total: true } });
  const unlinkedPayouts = payoutDocs.filter((d) => !linked.has(d.id));
  const unrecorded = new Map<string, { ref: string; courier: string; day: string; parcels: number; gross: bigint; fees: bigint; net: bigint }>();
  for (const p of parcels) {
    if (p.stage !== "paid_not_recorded" || !p.settlementRef) continue;
    const u = unrecorded.get(p.settlementRef) ?? { ref: p.settlementRef, courier: p.courier, day: p.settledOn ?? today, parcels: 0, gross: 0n, fees: 0n, net: 0n };
    u.parcels++;
    u.gross += p.settledGross ?? 0n;
    u.fees += p.settledFees ?? 0n;
    u.net += (p.settledGross ?? 0n) - (p.settledFees ?? 0n);
    unrecorded.set(p.settlementRef, u);
  }
  return {
    parcels,
    couriers: [...byCourier.values()].sort((a, b) => (b.open > a.open ? 1 : b.open < a.open ? -1 : a.courier.localeCompare(b.courier))),
    ledger,
    registerOpen,
    difference: ledger - registerOpen,
    unlinkedPayouts: unlinkedPayouts.length,
    unrecorded: [...unrecorded.values()].sort((a, b) => a.day.localeCompare(b.day) || a.ref.localeCompare(b.ref)),
    salesOn: sales.enabled,
    courierifyApiOn: courierify.enabled,
    labels: STAGE_LABELS,
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function salesMapping(book: BookView): Promise<SalesMapping> {
  const m = (await connectorRow(book.id, "shopify_sales")).settings.mapping;
  if (!m) throw new BooksError("Set up sales first — the parcel register comes from it");
  return m;
}

export async function accountByName(book: BookView, name: RegExp, create: { name: string; type: "expense" | "liability"; subtype: string }, actor: string | null): Promise<string> {
  const all = await listAccounts(book);
  const found = all.find((a) => !a.archived && a.type === create.type && name.test(a.name));
  return found ? found.id : (await createAccount(book, { name: create.name, type: create.type, subtype: create.subtype }, actor)).id;
}

/** A key the document de-duplication accepts (letters, digits, - and _; 8–64 long). */
function clientKey(prefix: string, raw: string): string {
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${prefix}-${raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-${h.toString(36)}`.slice(0, 64).padEnd(8, "0");
}

/**
 * Write off parcels the courier will never pay for.
 * Lost: the sale didn't happen — it comes off sales (with its share of tax);
 * the goods are gone, so their cost stays. If the parcel later turns up
 * delivered, the sale comes back; if it comes back, so does the stock.
 * Paid short: the part the courier kept goes to "Courier shortfalls".
 */
export async function writeOffParcels(
  book: BookView,
  /** Growzar: each order's total and tax (from Financify's order rows), for a lost parcel's share of tax. */
  orderTax: Map<string, { total: string; tax: string }>,
  input: { parcelIds: string[]; reason: "lost" | "short_paid"; date: string },
  actor: string | null,
): Promise<{ docId: string; count: number; amount: bigint }> {
  const ids = [...new Set(input.parcelIds)].slice(0, 500);
  if (ids.length === 0) throw new BooksError("Choose the parcels to write off");
  const today = todayIn(book.settings.timeZone);
  if (input.date > today) throw new BooksError("The date can't be in the future", "date");
  const all = await loadParcels(book, today);
  const chosen = all.filter((p) => ids.includes(p.id));
  const allowed: ParcelStage[] = input.reason === "lost" ? ["stuck", "in_transit", "not_shipped", "delivered"] : ["short_paid"];
  const bad = chosen.find((p) => !allowed.includes(p.stage) || p.open <= 0n);
  if (bad) throw new BooksError(`${bad.orderName} is "${STAGE_LABELS[bad.stage].toLowerCase()}" — it can't be written off as ${input.reason === "lost" ? "lost" : "paid short"}`);
  if (chosen.length === 0) throw new BooksError("Those parcels aren't in the register any more");
  const rows = await prisma.bkParcel.findMany({ where: { bookId: book.id, id: { in: chosen.map((p) => p.id) } } });
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  if (accountIds.length > 1) throw new BooksError("These parcels are owed through different accounts — write them off separately");
  // Growzar: an entry belongs to one store (D-65).
  const storeIds = [...new Set(rows.map((r) => r.storeId ?? null))];
  if (storeIds.length > 1) throw new BooksError("These parcels are from different stores — write off one store's at a time");
  const m = await salesMapping(book);
  let taxTotal = 0n;
  const taxBy = new Map<string, bigint>();
  if (input.reason === "lost" && m.tax) {
    // Its share of the order's tax comes off too.
    for (const p of chosen) {
      const o = orderTax.get(p.orderId);
      if (!o) continue;
      const total = decimalToMinor(o.total, book.decimals);
      const tax = decimalToMinor(o.tax, book.decimals);
      const t = total > 0n ? (tax * p.open) / total : 0n;
      if (t > 0n) {
        taxBy.set(p.orderId, t);
        taxTotal += t;
      }
    }
  }
  const account = input.reason === "lost" ? m.returns : await accountByName(book, /^courier shortfalls/i, { name: "Courier shortfalls", type: "expense", subtype: "cost_of_sales" }, actor);
  const items = chosen.map((p) => ({ orderId: p.orderId, orderName: p.orderName, amount: p.open.toString() }));
  const amount = chosen.reduce((s, p) => s + p.open, 0n);
  const r = await saveAndPost(
    book,
    {
      type: "parcel_writeoff",
      date: input.date,
      storeId: storeIds[0] ?? null,
      clientKey: clientKey("pwo", `${input.reason}:${input.date}:${chosen.map((p) => p.orderId).sort().join(",")}`),
      memo: input.reason === "lost" ? `${chosen.length} parcel${chosen.length === 1 ? "" : "s"} lost: ${chosen.slice(0, 5).map((p) => p.orderName).join(", ")}${chosen.length > 5 ? "…" : ""}` : `${chosen.length} parcel${chosen.length === 1 ? "" : "s"} paid short`,
      data: { reason: input.reason, receivable: accountIds[0], account, tax: taxTotal > 0n ? { accountId: m.tax, amount: taxTotal.toString() } : null, parcels: items },
    },
    actor,
  );
  if (r.error) throw r.error;
  if (input.reason === "lost") {
    // The parcel logic sees it as taken off, so a later return only brings the stock back.
    await prisma.bkParcelEvent.createMany({
      data: chosen.map((p) => {
        const t = taxBy.get(p.orderId) ?? 0n;
        const lines: Record<string, string> = { [accountIds[0]!]: (-p.open).toString(), [m.returns]: (p.open - t).toString() };
        if (t > 0n) lines[m.tax] = t.toString();
        return { bookId: book.id, storeId: rows.find((x) => x.id === p.id)?.storeId ?? null, orderId: p.orderId, orderName: p.orderName, day: toDbDate(input.date), kind: "lost", lines, documentId: r.doc.id };
      }),
      skipDuplicates: true,
    });
    await prisma.bkParcel.updateMany({ where: { bookId: book.id, id: { in: chosen.map((p) => p.id) } }, data: { writeoffDocId: r.doc.id } });
  } else {
    for (const p of chosen) await prisma.bkParcel.update({ where: { id: p.id }, data: { writeoffDocId: r.doc.id, writtenOff: p.open } });
  }
  return { docId: r.doc.id, count: chosen.length, amount };
}

/** A returned parcel came back damaged: what Books put back into stock for it comes out again as a loss. */
export async function markDamaged(book: BookView, input: { parcelId: string; amount: string; date: string }, actor: string | null): Promise<{ docId: string }> {
  const today = todayIn(book.settings.timeZone);
  if (input.date > today) throw new BooksError("The date can't be in the future", "date");
  const p = (await loadParcels(book, today)).find((x) => x.id === input.parcelId);
  if (!p) throw new BooksError("That parcel isn't in the register");
  // Came back damaged — or held (not a sale yet) and lost on the way: either way its cost leaves stock.
  if (p.stage !== "came_back" && p.stage !== "held") throw new BooksError(`${p.orderName} hasn't come back`);
  if (p.damagedDocId) throw new BooksError(`${p.orderName} is already marked damaged`);
  let v: bigint;
  try {
    v = decimalToMinor(input.amount, book.decimals);
  } catch {
    throw new BooksError("Enter the cost of what's damaged", "amount");
  }
  if (v <= 0n) throw new BooksError("Enter the cost of what's damaged", "amount");
  const accounts = await listAccounts(book);
  const stock = accounts.find((a) => a.systemKey === "stock" && !a.archived);
  const loss = accounts.find((a) => !a.archived && a.type === "expense" && /^stock lost or damaged/i.test(a.name)) ?? (await createAccount(book, { name: "Stock lost or damaged", type: "expense", subtype: "cost_of_sales" }, actor));
  if (!stock) throw new BooksError("There's no Stock account");
  const r = await saveAndPost(
    book,
    {
      type: "stock_adjustment",
      date: input.date,
      storeId: (await prisma.bkParcel.findUnique({ where: { id: p.id }, select: { storeId: true } }))?.storeId ?? null,
      clientKey: clientKey("dmg", p.orderId),
      memo: p.stage === "held" ? `${p.orderName} lost on the way (not a sale yet)` : `${p.orderName} came back damaged`,
      data: { stock: stock.id, counter: loss.id, amount: (-v).toString(), method: "damaged", orderName: p.orderName },
    },
    actor,
  );
  if (r.error) throw r.error;
  await prisma.bkParcel.update({ where: { id: p.id }, data: { damagedDocId: r.doc.id, damaged: v } });
  return { docId: r.doc.id };
}

/** Save how long before a parcel counts as stuck. */
export async function saveStageRules(book: BookView, rules: StageRules, actor: string | null): Promise<void> {
  for (const [k, v] of Object.entries(rules)) if (!(Number.isInteger(v) && v >= 3 && v <= 180)) throw new BooksError("Use a number of days between 3 and 180", k);
  const row = await prisma.bkBook.findUniqueOrThrow({ where: { id: book.id }, select: { settings: true } });
  await prisma.bkBook.update({ where: { id: book.id }, data: { settings: { ...((row.settings ?? {}) as object), parcelRules: rules } as unknown as Prisma.InputJsonValue } });
  await prisma.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "settings.parcel_rules", detail: rules as unknown as Prisma.InputJsonValue } });
}
