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
};

export type DailySales = { variantId: string; date: string; units: number };
export type StockSnapshot = { variantId: string; date: string; stock: number };
export type PurchaseOrder = {
  id: string;
  poNumber: string;
  status: string;
  supplierName: string | null;
  expectedDeliveryDate: string | null;
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
/** Rows on screen; the rest is counted. */
export const ROWS_SHOWN = 50;

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
  };
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
  onOrder: number;
  /** Days in the period that opened with no stock, of the days with a snapshot. */
  daysOut: number;
  daysSnapshotted: number;
  /** Days in the rate window it sold on, though the day opened with no stock. */
  soldAtZeroDays: number;
  state: StockState;
};

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
  rows: InventoryRow[];
  hiddenRows: number;
  openOrders: Array<{ id: string; poNumber: string; status: string; supplierName: string | null; expected: string | null; units: number; variants: number }>;
};

const STATE_ORDER: Record<StockState, number> = { out: 0, reorder: 1, on_order: 2, ok: 3, slow: 4, untracked: 5, not_selling: 6 };

export function inventoryView(input: {
  variants: InventoryVariant[];
  sales: DailySales[];
  snapshots: StockSnapshot[];
  purchaseOrders: PurchaseOrder[];
  period: { from: string; to: string };
  today: string;
  currency: string | null;
  /** Rows kept; the screen shows ROWS_SHOWN, a detector wants them all. */
  limit?: number;
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

  let stockValue: Money | null = currency ? zero(currency) : null;
  let uncosted = 0;
  const rows: InventoryRow[] = [];

  for (const v of input.variants) {
    if (v.archived) continue;
    const s = sold.get(v.variantId) ?? { period: 0, rate: 0, selling: false };
    const perDay = s.rate / RATE_DAYS;
    const atZero = soldAtZero.get(v.variantId) ?? 0;
    const untracked = atZero >= UNTRACKED_SALE_DAYS;
    const daysOfCover = untracked ? null : v.stock <= 0 ? 0 : perDay > 0 ? Math.floor(v.stock / perDay) : null;
    const due = onOrder.get(v.variantId) ?? 0;
    const state: StockState = !s.selling
      ? "not_selling"
      : untracked
        ? "untracked"
        : v.stock <= 0
        ? "out"
        : daysOfCover !== null && v.leadTimeDays !== null && daysOfCover <= v.leadTimeDays
          ? due > 0
            ? "on_order"
            : "reorder"
          : perDay === 0
            ? "slow"
            : "ok";

    if (v.stock > 0) {
      if (v.unitCost && stockValue && v.unitCost.currency === stockValue.currency) {
        stockValue = addMoney(stockValue, timesQuantity(v.unitCost, v.stock));
      } else {
        uncosted += 1;
      }
    }

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
      leadTimeDays: v.leadTimeDays,
      onOrder: due,
      daysOut: o.out,
      daysSnapshotted: o.days,
      soldAtZeroDays: atZero,
      state,
    });
  }

  rows.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) ||
      b.soldInPeriod - a.soldInPeriod ||
      a.title.localeCompare(b.title),
  );

  return {
    currency,
    rateWindow: { from: rateFrom, to: rateTo },
    variants: rows.length,
    selling: rows.filter((r) => r.state !== "not_selling").length,
    outNow: rows.filter((r) => r.state === "out").length,
    reorderNow: rows.filter((r) => r.state === "reorder").length,
    untracked: rows.filter((r) => r.state === "untracked").length,
    stockValue,
    uncosted,
    rows: rows.slice(0, limit),
    hiddenRows: Math.max(0, rows.length - limit),
    openOrders: open.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      status: po.status,
      supplierName: po.supplierName,
      expected: po.expectedDeliveryDate,
      units: po.items.reduce((n, i) => n + i.onOrder, 0),
      variants: po.items.length,
    })),
  };
}
