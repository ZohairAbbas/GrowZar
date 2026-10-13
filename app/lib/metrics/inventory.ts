import { MIN_DECIDED_TO_RATE } from "./compare";
import { addMoney, readMoney, timesQuantity, zero, type Money } from "./money";

/**
 * The Inventory section (Phase 5, G-GZR5-3), from Inventorify's feeds.
 *
 * Inventorify owns stock, units sold (rule #28) and purchase orders (rule #18);
 * Growzar only arranges them. Its own forecast (`avgDailySales`) is not used:
 * the rate here is plain units sold over the last 30 full days, so the
 * arithmetic on screen is the arithmetic behind it.
 */

export type InventoryVariant = {
  variantId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  stock: number;
  leadTimeDays: number | null;
  unitCost: Money | null;
  archived: boolean;
  supplierId: string | null;
};

/** Inventorify's supplier, for its measured lead time (sent → received). */
export type Supplier = { id: string; avgActualLeadTime: number | null; totalPosReceived: number };

export type DailySales = { variantId: string; date: string; units: number };
export type StockSnapshot = { variantId: string; date: string; stock: number };
export type PurchaseOrder = {
  id: string;
  poNumber: string;
  status: string;
  supplierName: string | null;
  expectedDeliveryDate: string | null;
  /** The day it was received, when it was. */
  receivedOn: string | null;
  items: Array<{ variantId: string; onOrder: number }>;
};

/** Days the rate is measured over, ending yesterday: today is still being sold. */
export const RATE_DAYS = 30;
/** A variant that sold in this many days counts as selling; an empty shelf for one of these is a stock-out. */
export const SELLING_DAYS = 90;
/**
 * Sale days in the rate window on which the shelf opened empty or negative,
 * beyond which the stock count is not taken as the real shelf: the store
 * sells past zero (Shopify "continue selling") or does not keep the count up.
 * One or two can be a restock during the day; older ones predate a restock.
 */
export const UNTRACKED_SALE_DAYS = 3;
/** Received purchase orders before a supplier's measured lead time replaces the setting (Inventorify's own rule). */
export const MEASURED_LEAD_MIN_POS = 3;
/**
 * Purchase orders received in the last PO_USE_DAYS before a store counts as
 * reordering through Inventorify. Only then can "nothing on order" be read
 * as nothing on the way, and only then does I3 forecast a stock-out.
 */
export const PO_USE_MIN = 3;
export const PO_USE_DAYS = 90;
/** Rows on screen; the rest is counted. */
export const ROWS_SHOWN = 50;
/** Days a reorder should last once it arrives; the suggested quantity covers the lead time plus these. */
export const COVER_AFTER_ARRIVAL = 30;
/** Share of the period's positive profit the top variants make between them. */
export const TOP_PROFIT_SHARE = 0.8;


/** Statuses that never put stock on the way. Everything else with units still due does. */
const NOT_ON_THE_WAY = new Set(["draft", "cancelled", "canceled", "received", "closed"]);

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** Shopify titles reach Inventorify HTML-escaped ("Charging &amp; Travel Kit"); React escapes again. */
const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#039;": "'", "&lt;": "<", "&gt;": ">" };
const text = (v: unknown) => str(v)?.replace(/&(amp|quot|#0?39|lt|gt);/g, (m) => ENTITIES[m] ?? m) ?? null;
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export function parseVariant(p: unknown): InventoryVariant | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const variantId = str(r.variantId) ?? str(r.id);
  const stock = int(r.stock);
  if (!variantId || stock === null) return null;
  return {
    variantId,
    title: text(r.title) ?? variantId,
    variantTitle: text(r.variantTitle),
    sku: str(r.sku),
    stock,
    leadTimeDays: int(r.leadTimeDays),
    unitCost: readMoney(r.unitCost),
    archived: r.archived === true,
    supplierId: str(r.supplierId),
  };
}

export function parseSupplier(p: unknown): Supplier | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const avg = typeof r.avgActualLeadTime === "number" && Number.isFinite(r.avgActualLeadTime) && r.avgActualLeadTime > 0 ? r.avgActualLeadTime : null;
  return { id, avgActualLeadTime: avg, totalPosReceived: int(r.totalPosReceived) ?? 0 };
}

export function parseDailySales(p: unknown): DailySales | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const variantId = str(r.variantId);
  const date = day(r.date);
  const units = int(r.units);
  return variantId && date && units !== null ? { variantId, date, units } : null;
}

export function parseSnapshot(p: unknown): StockSnapshot | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const variantId = str(r.variantId);
  const date = day(r.date);
  const stock = int(r.stock);
  return variantId && date && stock !== null ? { variantId, date, stock } : null;
}

export function parsePurchaseOrder(p: unknown): PurchaseOrder | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    id,
    poNumber: str(r.poNumber) ?? id,
    status: (str(r.status) ?? "unknown").toLowerCase(),
    supplierName: str(r.supplierName),
    expectedDeliveryDate: day(r.expectedDeliveryDate),
    receivedOn: typeof r.actualDeliveryDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.actualDeliveryDate) ? r.actualDeliveryDate.slice(0, 10) : null,
    items: items.flatMap((i) => {
      const o = (i ?? {}) as Record<string, unknown>;
      const variantId = str(o.variantId);
      const onOrder = int(o.onOrder);
      return variantId && onOrder !== null && onOrder > 0 ? [{ variantId, onOrder }] : [];
    }),
  };
}

export function isOnTheWay(po: PurchaseOrder): boolean {
  return !NOT_ON_THE_WAY.has(po.status) && po.items.length > 0;
}

/** `YYYY-MM-DD` plus or minus whole days, on the calendar (no timezone involved). */
export function shiftDay(d: string, by: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
}

export type StockState = "out" | "reorder" | "on_order" | "ok" | "slow" | "untracked" | "not_selling";

/** Every state, in the order the table lists them. */
export const STOCK_STATES: readonly StockState[] = ["out", "reorder", "on_order", "ok", "slow", "untracked", "not_selling"];

/** The state picked from the table's chips (`?stock=`), or null for all. */
export function parseStockState(params: URLSearchParams): StockState | null {
  const asked = params.get("stock");
  return (STOCK_STATES as readonly string[]).includes(asked ?? "") ? (asked as StockState) : null;
}

export type InventoryRow = {
  variantId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  stock: number;
  soldInPeriod: number;
  /** Units a day over the last RATE_DAYS full days. */
  perDay: number;
  /** Whole days the stock lasts at that rate; null when nothing sold. */
  daysOfCover: number | null;
  leadTimeDays: number | null;
  /** "measured": the supplier's average sent → received; "setting": the variant's lead time in Inventorify. */
  leadSource: "measured" | "setting" | null;
  onOrder: number;
  /** Days in the period that opened with no stock, of the days with a snapshot. */
  daysOut: number;
  daysSnapshotted: number;
  /** Days in the rate window it sold on, though the day opened with no stock. */
  soldAtZeroDays: number;
  state: StockState;
  /**
   * Delivered ÷ (delivered + returned) for orders with this variant in the
   * settled history: its own past MIN_DECIDED_TO_RATE decided orders, else
   * the store's. Null without outcomes.
   */
  deliveryRate: number | null;
  rateSource: "variant" | "store" | null;
  /** Units a day the shelf loses once returned parcels are back on it: perDay × deliveryRate. */
  netPerDay: number | null;
  netDaysOfCover: number | null;
  /**
   * Units to order now so stock lasts the lead time plus COVER_AFTER_ARRIVAL
   * days, less what is on hand and on order, at the net rate (else the
   * placed rate). Only for a variant that is out, or runs out within its lead time.
   */
  reorderUnits: number | null;
  /** Profit in the period, as Finance's product tab has it; null without one. */
  profit: Money | null;
  /** Among the variants that make TOP_PROFIT_SHARE of the period's positive profit. */
  topProfit: boolean;
};

/** Delivered and returned orders, to rate one variant or the whole store. */
export type Decided = { delivered: number; returned: number };

export type InventoryView = {
  currency: string | null;
  rateWindow: { from: string; to: string };
  variants: number;
  selling: number;
  outNow: number;
  reorderNow: number;
  /** Selling variants whose count is not the real shelf (UNTRACKED_SALE_DAYS). */
  untracked: number;
  /** Stock on hand at Inventorify's unit cost; variants without a cost are counted, not guessed. */
  stockValue: Money | null;
  uncosted: number;
  /** Stock at cost of variants with no sale in 30 days or none in 90 ("slow", "not_selling"). */
  stuck: { value: Money | null; variants: number; uncosted: number };
  /** Whether rows carry a delivery rate, and whether they carry profit. */
  hasOutcomes: boolean;
  hasProfit: boolean;
  /** Rows in the picked state, or every row; then cut to the limit. */
  rows: InventoryRow[];
  hiddenRows: number;
  /** The state the rows are filtered to, if any. */
  state: StockState | null;
  /** Variants in each state, for the chips; states with none are left out. */
  byState: Array<{ state: StockState; count: number }>;
  /** Purchase orders received in the last PO_USE_DAYS. */
  receivedOrders: number;
  /** Whether the store reorders through Inventorify (PO_USE_MIN), so "nothing on order" means nothing coming. */
  reordersInInventorify: boolean;
  openOrders: Array<{
    id: string;
    poNumber: string;
    status: string;
    supplierName: string | null;
    expected: string | null;
    /** Whole days past the expected date, still not received; null when not late or no date. */
    daysLate: number | null;
    units: number;
    variants: number;
  }>;
};

const STATE_ORDER: Record<StockState, number> = { out: 0, reorder: 1, on_order: 2, ok: 3, slow: 4, untracked: 5, not_selling: 6 };

export function inventoryView(input: {
  variants: InventoryVariant[];
  sales: DailySales[];
  snapshots: StockSnapshot[];
  purchaseOrders: PurchaseOrder[];
  suppliers?: Supplier[];
  period: { from: string; to: string };
  today: string;
  currency: string | null;
  /** Rows kept; the screen shows ROWS_SHOWN, a detector wants them all. */
  limit?: number;
  /** Only rows in this state; the counts above the table stay store-wide. */
  state?: StockState | null;
  /** Decided orders by variant over the settled history, and the store's, for the delivery rate. */
  outcomes?: { byVariant: ReadonlyMap<string, Decided>; store: Decided } | null;
  /** The period's profit by variant (Finance's product tab), in the store's currency. */
  profit?: ReadonlyMap<string, Money> | null;
}): InventoryView {
  const limit = input.limit ?? ROWS_SHOWN;
  const { period, today, currency } = input;
  const rateTo = shiftDay(today, -1);
  const rateFrom = shiftDay(today, -RATE_DAYS);
  const sellingFrom = shiftDay(today, -SELLING_DAYS);

  const sold = new Map<string, { period: number; rate: number; selling: boolean }>();
  for (const s of input.sales) {
    const v = sold.get(s.variantId) ?? { period: 0, rate: 0, selling: false };
    if (s.date >= period.from && s.date <= period.to) v.period += s.units;
    if (s.date >= rateFrom && s.date <= rateTo) v.rate += s.units;
    if (s.date >= sellingFrom && s.date < today && s.units > 0) v.selling = true;
    sold.set(s.variantId, v);
  }

  // Opening stock by variant and day, to catch sales off an empty shelf in
  // the rate window: the same days the rate and days of cover come from.
  const opening = new Map<string, number>();
  for (const s of input.snapshots) opening.set(`${s.variantId}|${s.date}`, s.stock);
  const soldAtZero = new Map<string, number>();
  for (const s of input.sales) {
    if (s.units <= 0 || s.date < rateFrom || s.date > rateTo) continue;
    const stock = opening.get(`${s.variantId}|${s.date}`);
    if (stock !== undefined && stock <= 0) soldAtZero.set(s.variantId, (soldAtZero.get(s.variantId) ?? 0) + 1);
  }

  const out = new Map<string, { days: number; out: number }>();
  for (const s of input.snapshots) {
    if (s.date < period.from || s.date > period.to) continue;
    const v = out.get(s.variantId) ?? { days: 0, out: 0 };
    v.days += 1;
    if (s.stock <= 0) v.out += 1;
    out.set(s.variantId, v);
  }

  const open = input.purchaseOrders.filter(isOnTheWay);
  const onOrder = new Map<string, number>();
  for (const po of open) for (const i of po.items) onOrder.set(i.variantId, (onOrder.get(i.variantId) ?? 0) + i.onOrder);

  const measured = new Map(
    (input.suppliers ?? [])
      .filter((s) => s.totalPosReceived >= MEASURED_LEAD_MIN_POS && s.avgActualLeadTime !== null)
      .map((s) => [s.id, Math.ceil(s.avgActualLeadTime!)]),
  );
  const receivedFrom = shiftDay(today, -PO_USE_DAYS);
  const receivedOrders = input.purchaseOrders.filter((po) => po.receivedOn !== null && po.receivedOn >= receivedFrom && po.receivedOn <= today).length;

  let stockValue: Money | null = currency ? zero(currency) : null;
  let uncosted = 0;
  let stuckValue: Money | null = currency ? zero(currency) : null;
  let stuckVariants = 0;
  let stuckUncosted = 0;

  const rateOf = (d: Decided | undefined) => (d && d.delivered + d.returned ? d.delivered / (d.delivered + d.returned) : null);
  const storeRate = input.outcomes ? rateOf(input.outcomes.store) : null;

  // The top variants by profit: largest first, until they make TOP_PROFIT_SHARE of all positive profit.
  const top = new Set<string>();
  if (input.profit) {
    const positive = [...input.profit].map(([k, m]) => [k, Number(m.amount)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const total = positive.reduce((a, [, n]) => a + n, 0);
    let sum = 0;
    for (const [k, n] of positive) {
      if (sum >= TOP_PROFIT_SHARE * total) break;
      top.add(k);
      sum += n;
    }
  }
  const rows: InventoryRow[] = [];

  for (const v of input.variants) {
    if (v.archived) continue;
    const s = sold.get(v.variantId) ?? { period: 0, rate: 0, selling: false };
    const perDay = s.rate / RATE_DAYS;
    const atZero = soldAtZero.get(v.variantId) ?? 0;
    const untracked = atZero >= UNTRACKED_SALE_DAYS;
    const daysOfCover = untracked ? null : v.stock <= 0 ? 0 : perDay > 0 ? Math.floor(v.stock / perDay) : null;
    const due = onOrder.get(v.variantId) ?? 0;
    const measuredLead = v.supplierId ? measured.get(v.supplierId) : undefined;
    const lead = measuredLead ?? v.leadTimeDays;
    const leadSource = measuredLead !== undefined ? "measured" : v.leadTimeDays !== null ? "setting" : null;
    const state: StockState = !s.selling
      ? "not_selling"
      : untracked
        ? "untracked"
        : v.stock <= 0
        ? "out"
        : daysOfCover !== null && lead !== null && daysOfCover <= lead
          ? due > 0
            ? "on_order"
            : "reorder"
          : perDay === 0
            ? "slow"
            : "ok";

    if (v.stock > 0) {
      const costed = !!(v.unitCost && stockValue && v.unitCost.currency === stockValue.currency);
      if (costed) stockValue = addMoney(stockValue!, timesQuantity(v.unitCost!, v.stock));
      else uncosted += 1;
      if (state === "slow" || state === "not_selling") {
        stuckVariants += 1;
        if (costed && stuckValue) stuckValue = addMoney(stuckValue, timesQuantity(v.unitCost!, v.stock));
        else stuckUncosted += 1;
      }
    }

    const own = input.outcomes?.byVariant.get(v.variantId);
    const ownRated = own !== undefined && own.delivered + own.returned >= MIN_DECIDED_TO_RATE;
    const deliveryRate = ownRated ? rateOf(own) : storeRate;
    const rateSource = deliveryRate === null ? null : ownRated ? "variant" : "store";
    const netPerDay = deliveryRate === null || untracked ? null : perDay * deliveryRate;
    const netDaysOfCover = netPerDay === null ? null : v.stock <= 0 ? 0 : netPerDay > 0 ? Math.floor(v.stock / netPerDay) : null;
    const reorderRate = netPerDay ?? perDay;
    const reorderUnits =
      (state === "out" || state === "reorder" || state === "on_order") && lead !== null && reorderRate > 0
        ? Math.max(0, Math.ceil(reorderRate * (lead + COVER_AFTER_ARRIVAL)) - Math.max(0, v.stock) - due)
        : null;

    const o = out.get(v.variantId) ?? { days: 0, out: 0 };
    rows.push({
      variantId: v.variantId,
      title: v.title,
      variantTitle: v.variantTitle,
      sku: v.sku,
      stock: v.stock,
      soldInPeriod: s.period,
      perDay: Math.round(perDay * 10) / 10,
      daysOfCover,
      leadTimeDays: lead,
      leadSource,
      onOrder: due,
      daysOut: o.out,
      daysSnapshotted: o.days,
      soldAtZeroDays: atZero,
      state,
      deliveryRate: deliveryRate === null ? null : Math.round(deliveryRate * 1000) / 10,
      rateSource,
      netPerDay: netPerDay === null ? null : Math.round(netPerDay * 10) / 10,
      netDaysOfCover,
      reorderUnits,
      profit: input.profit?.get(v.variantId) ?? null,
      topProfit: top.has(v.variantId),
    });
  }

  rows.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      Number(b.topProfit) - Number(a.topProfit) ||
      (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) ||
      b.soldInPeriod - a.soldInPeriod ||
      a.title.localeCompare(b.title),
  );

  const picked = input.state ? rows.filter((r) => r.state === input.state) : rows;
  const count = (state: StockState) => rows.filter((r) => r.state === state).length;

  return {
    currency,
    rateWindow: { from: rateFrom, to: rateTo },
    variants: rows.length,
    selling: rows.filter((r) => r.state !== "not_selling").length,
    outNow: count("out"),
    reorderNow: count("reorder"),
    untracked: count("untracked"),
    stockValue,
    uncosted,
    stuck: { value: stuckValue, variants: stuckVariants, uncosted: stuckUncosted },
    hasOutcomes: storeRate !== null,
    hasProfit: !!input.profit,
    rows: picked.slice(0, limit),
    hiddenRows: Math.max(0, picked.length - limit),
    state: input.state ?? null,
    byState: STOCK_STATES.map((state) => ({ state, count: count(state) })).filter((s) => s.count > 0),
    receivedOrders,
    reordersInInventorify: receivedOrders >= PO_USE_MIN,
    openOrders: open
      .map((po) => {
        const late = po.expectedDeliveryDate && po.expectedDeliveryDate < today ? Math.round((Date.parse(today) - Date.parse(po.expectedDeliveryDate)) / 86_400_000) : null;
        return {
          id: po.id,
          poNumber: po.poNumber,
          status: po.status,
          supplierName: po.supplierName,
          expected: po.expectedDeliveryDate,
          daysLate: late,
          units: po.items.reduce((n, i) => n + i.onOrder, 0),
          variants: po.items.length,
        };
      })
      .sort((a, b) => (b.daysLate ?? -1) - (a.daysLate ?? -1)),
  };
}
