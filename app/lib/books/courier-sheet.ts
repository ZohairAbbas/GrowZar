/**
 * Couriers' files, read the same way whoever the courier is.
 *
 * A settlement (payment report) says, parcel by parcel, what the courier
 * collected, what it kept (delivery and return charges, sales tax on them,
 * income tax withheld, other fees) and what it paid out — and which parcels
 * came back. A loadsheet lists the parcels handed to the courier and the
 * cash to collect on each.
 *
 * Pure and browser-safe: the screen reads the file and shows the rows; the
 * server reads the same text again before anything is saved.
 */

import { cell, findColumns, isBlankOrTotal, normHeader, type ColumnSpec } from "./sheet";
import { detectDateFormat, parseCsv, parseStatementDate, parseStatementMoney } from "./statement-csv";

export type SheetStatus = "delivered" | "returned" | "other";

export interface SheetLine {
  row: number;
  tracking: string | null;
  orderRef: string | null;
  status: SheetStatus;
  rawStatus: string | null;
  cod: bigint;
  collected: bigint;
  delivery: bigint;
  returnFee: bigint;
  salesTax: bigint;
  withheld: bigint;
  otherFees: bigint;
  net: bigint;
  /** The row's own sum doesn't work out (collected − kept ≠ net): by how much. */
  unexplained: bigint;
}

export interface SheetRead {
  lines: SheetLine[];
  problems: string[];
  /** A date found on the rows (payment or dispatch date), when they all share one. */
  date: string | null;
  /** A reference found on the rows (payment or loadsheet number), when they all share one. */
  ref: string | null;
  /** Which columns were read, by what the file calls them. */
  columns: Record<string, string>;
}

export const MAX_SHEET_ROWS = 20_000;

// Specific names first: in the "contains" pass, earlier columns claim headers first.
const SETTLEMENT_SPECS: ColumnSpec[] = [
  { key: "tracking", names: ["tracking number", "tracking no", "tracking", "cn number", "cn no", "cn", "consignment number", "consignment no", "consignment", "awb number", "awb no", "awb", "booking number", "booking no", "shipment number", "shipment no", "tracking id"] },
  { key: "orderRef", names: ["order number", "order no", "order id", "order ref", "order reference", "order", "customer reference", "shipper reference", "reference number", "ref no", "reference"] },
  { key: "status", names: ["delivery status", "shipment status", "parcel status", "order status", "status", "remarks"] },
  { key: "net", names: ["net payable", "net amount", "amount payable", "net payment", "payable amount", "net paid", "paid amount", "transfer amount", "net"] },
  { key: "collected", names: ["collected amount", "amount collected", "cash collected", "received amount", "collected", "cod collected"] },
  { key: "returnFee", names: ["return charges", "rto charges", "return fee", "reverse charges", "return shipping", "rto"] },
  { key: "withheld", names: ["withholding tax", "with holding tax", "income tax", "wht", "withholding", "tax deducted", "it"] },
  { key: "salesTax", names: ["sales tax", "gst", "sst", "pst", "fed", "tax on charges", "service tax"] },
  { key: "otherFees", names: ["other charges", "fuel surcharge", "fuel", "insurance", "cash handling", "cod fee", "cod charges", "handling charges", "packaging"] },
  { key: "delivery", names: ["delivery charges", "shipping charges", "service charges", "courier charges", "delivery fee", "freight", "charges", "fee"] },
  { key: "cod", names: ["cod amount", "cod value", "invoice amount", "order amount", "collectable amount", "collectable", "cod", "amount"] },
  { key: "date", names: ["payment date", "settlement date", "paid on", "transfer date", "date"] },
  { key: "ref", names: ["payment number", "payment no", "settlement number", "settlement no", "cpr number", "cpr no", "invoice number", "invoice no", "batch no"] },
];

const LOADSHEET_SPECS: ColumnSpec[] = [
  SETTLEMENT_SPECS[0]!,
  SETTLEMENT_SPECS[1]!,
  { key: "cod", names: ["cod amount", "cod value", "collectable amount", "invoice amount", "order amount", "amount to collect", "collectable", "cod", "amount"] },
  { key: "date", names: ["dispatch date", "booking date", "pickup date", "load date", "date"] },
  { key: "ref", names: ["loadsheet number", "loadsheet no", "load sheet no", "loadsheet id", "manifest no", "manifest number", "sheet no"] },
];

/** A courier's word for a parcel's outcome → delivered, returned, or neither. */
export function sheetStatus(raw: string): SheetStatus | null {
  const t = raw.toLowerCase().trim();
  if (!t) return null;
  if (/cancel|lost|void|damag/.test(t)) return "other";
  if (/return|rto|\brts\b|refus|reject|un-?deliver|not deliver|failed|back to (shipper|origin)/.test(t)) return "returned";
  if (/deliver|paid|success|complete|dlvd|\bdl\b|received/.test(t)) return "delivered";
  return "other";
}

/** Same tracking number however it's written: upper case, letters and digits only. */
export function normTracking(s: string | null | undefined): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "#1234", "1234", "SHOP-1234" → "1234" for comparing with Shopify's order name; "" when there are no digits. */
export function normOrderRef(s: string | null | undefined): string {
  const m = String(s ?? "").match(/(\d+)\D*$/);
  return m ? m[1]!.replace(/^0+/, "") : "";
}

function money(raw: string, decimals: number, line: number, what: string, problems: string[]): bigint {
  if (!raw) return 0n;
  const v = parseStatementMoney(raw, decimals);
  if (v === "invalid") {
    problems.push(`Row ${line}: the ${what} "${raw}" isn't a number — read as 0`);
    return 0n;
  }
  return v ?? 0n;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

function sharedValue(values: string[]): string | null {
  const filled = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  return filled.length === 1 ? filled[0]! : null;
}

/** Growzar: the columns each kind of file is read by, so the browser sends only those (D-72's rule, for courier files too). */
export { LOADSHEET_SPECS, SETTLEMENT_SPECS };

/** Read a settlement (payment report). */
export function readSettlementFile(text: string, decimals: number): SheetRead {
  const all = parseCsv(text);
  const found = findColumns(all, SETTLEMENT_SPECS);
  const problems: string[] = [];
  const none = (msg: string): SheetRead => ({ lines: [], problems: [msg], date: null, ref: null, columns: {} });
  if (!found) return none("Couldn't find the columns. The file needs a header row with a tracking or order number and amounts.");
  const { headerRow, cols } = found;
  if (cols.tracking === undefined && cols.orderRef === undefined) return none("Couldn't find a tracking number or order number column, so the rows can't be matched to your orders.");
  if (cols.net === undefined && cols.collected === undefined && cols.cod === undefined) return none("Couldn't find any amounts (COD, collected or net payable).");
  const data = all.slice(headerRow + 1).filter((r) => !isBlankOrTotal(r));
  const lines: SheetLine[] = [];
  data.slice(0, MAX_SHEET_ROWS).forEach((r, i) => {
    const line = headerRow + 2 + i;
    const tracking = cell(r, cols, "tracking") || null;
    const orderRef = cell(r, cols, "orderRef") || null;
    if (!tracking && !orderRef) return;
    const m = (key: string, what: string) => (cols[key] === undefined ? null : money(cell(r, cols, key), decimals, line, what, problems));
    const cod = m("cod", "COD amount");
    // Charges are what the courier kept: read as positive whichever way the file signs them.
    const fee = (key: string, what: string) => abs(m(key, what) ?? 0n);
    const delivery = fee("delivery", "delivery charge");
    const returnFee = fee("returnFee", "return charge");
    const salesTax = fee("salesTax", "sales tax");
    const withheld = fee("withheld", "tax withheld");
    const otherFees = fee("otherFees", "other charge");
    const kept = delivery + returnFee + salesTax + withheld + otherFees;
    const rawStatus = cell(r, cols, "status") || null;
    let collected = m("collected", "collected amount");
    const net = m("net", "net amount");
    let status = rawStatus ? sheetStatus(rawStatus) : null;
    // No status column: money collected means delivered; none, with a return charge, means returned.
    if (!status) {
      const got = collected ?? (net !== null ? net + kept : cod ?? 0n);
      status = got > 0n ? "delivered" : returnFee > 0n ? "returned" : "other";
    }
    // No "collected" column: a delivered parcel collected its COD (so a short payout shows as not adding up).
    if (collected === null) collected = status === "delivered" ? (cod ?? (net !== null ? net + kept : 0n)) : 0n;
    const netV = net ?? collected - kept;
    lines.push({
      row: line,
      tracking: tracking?.slice(0, 100) ?? null,
      orderRef: orderRef?.slice(0, 100) ?? null,
      status,
      rawStatus: rawStatus?.slice(0, 100) ?? null,
      cod: cod ?? collected,
      collected,
      delivery,
      returnFee,
      salesTax,
      withheld,
      otherFees,
      net: netV,
      unexplained: collected - kept - netV,
    });
  });
  if (data.length > MAX_SHEET_ROWS) problems.push(`Only the first ${MAX_SHEET_ROWS.toLocaleString()} rows were read`);
  const dates = data.map((r) => cell(r, cols, "date"));
  const fmt = detectDateFormat(dates);
  const d = sharedValue(dates);
  return {
    lines,
    problems,
    date: d && fmt ? parseStatementDate(d, fmt) : null,
    ref: sharedValue(data.map((r) => cell(r, cols, "ref")))?.slice(0, 100) ?? null,
    columns: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, all[headerRow]![i] ?? ""])),
  };
}

/** Read a loadsheet (dispatch list). Every row is a parcel handed over; status is "other" until it settles. */
export function readLoadsheetFile(text: string, decimals: number): SheetRead {
  const all = parseCsv(text);
  const found = findColumns(all, LOADSHEET_SPECS);
  const problems: string[] = [];
  const none = (msg: string): SheetRead => ({ lines: [], problems: [msg], date: null, ref: null, columns: {} });
  if (!found) return none("Couldn't find the columns. The file needs a header row with tracking or order numbers and the COD amount.");
  const { headerRow, cols } = found;
  if (cols.tracking === undefined && cols.orderRef === undefined) return none("Couldn't find a tracking number or order number column.");
  if (cols.cod === undefined) return none("Couldn't find the COD amount column.");
  const data = all.slice(headerRow + 1).filter((r) => !isBlankOrTotal(r));
  const lines: SheetLine[] = [];
  const seen = new Set<string>();
  data.slice(0, MAX_SHEET_ROWS).forEach((r, i) => {
    const line = headerRow + 2 + i;
    const tracking = cell(r, cols, "tracking") || null;
    const orderRef = cell(r, cols, "orderRef") || null;
    if (!tracking && !orderRef) return;
    const key = tracking ? `t:${normTracking(tracking)}` : `o:${normOrderRef(orderRef)}`;
    if (seen.has(key)) return void problems.push(`Row ${line}: ${tracking ?? orderRef} is on the loadsheet twice — counted once`);
    seen.add(key);
    const cod = abs(money(cell(r, cols, "cod"), decimals, line, "COD amount", problems));
    lines.push({ row: line, tracking: tracking?.slice(0, 100) ?? null, orderRef: orderRef?.slice(0, 100) ?? null, status: "other", rawStatus: null, cod, collected: 0n, delivery: 0n, returnFee: 0n, salesTax: 0n, withheld: 0n, otherFees: 0n, net: 0n, unexplained: 0n });
  });
  if (data.length > MAX_SHEET_ROWS) problems.push(`Only the first ${MAX_SHEET_ROWS.toLocaleString()} rows were read`);
  const dates = data.map((r) => cell(r, cols, "date"));
  const fmt = detectDateFormat(dates);
  const d = sharedValue(dates);
  return {
    lines,
    problems,
    date: d && fmt ? parseStatementDate(d, fmt) : null,
    ref: sharedValue(data.map((r) => cell(r, cols, "ref")))?.slice(0, 100) ?? null,
    columns: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, all[headerRow]![i] ?? ""])),
  };
}

export interface SettlementTotals {
  parcels: number;
  delivered: number;
  returned: number;
  other: number;
  /** COD of the parcels on it (delivered and returned). */
  cod: bigint;
  collected: bigint;
  /** COD of returned parcels — no money, the sale comes off. */
  returnedCod: bigint;
  delivery: bigint;
  returnFee: bigint;
  salesTax: bigint;
  withheld: bigint;
  otherFees: bigint;
  net: bigint;
  /** Rows whose own sums don't work out, added up (collected − kept − net). */
  unexplained: bigint;
}

/** The settlement's sums. The check: collected = net + everything kept + unexplained. */
export function settlementTotals(lines: SheetLine[]): SettlementTotals {
  const t: SettlementTotals = { parcels: lines.length, delivered: 0, returned: 0, other: 0, cod: 0n, collected: 0n, returnedCod: 0n, delivery: 0n, returnFee: 0n, salesTax: 0n, withheld: 0n, otherFees: 0n, net: 0n, unexplained: 0n };
  for (const l of lines) {
    t[l.status]++;
    t.cod += l.cod;
    t.collected += l.collected;
    if (l.status === "returned") t.returnedCod += l.cod;
    t.delivery += l.delivery;
    t.returnFee += l.returnFee;
    t.salesTax += l.salesTax;
    t.withheld += l.withheld;
    t.otherFees += l.otherFees;
    t.net += l.net;
    t.unexplained += l.unexplained;
  }
  return t;
}

/** A header the person can recognise ("COD_Amount" → "COD Amount") for "read from column …". */
export function headerLabel(h: string): string {
  return normHeader(h).replace(/\b\w/g, (c) => c.toUpperCase());
}

const COURIER_NAMES = ["PostEx", "Leopards", "TCS", "Trax", "M&P", "BlueEx", "Call Courier", "Swyft", "Rider", "DHL", "Daewoo", "Movex", "Tranzum", "Aramex", "Shipa", "Fetchr", "Delhivery", "Shiprocket", "Xpressbees", "Ecom Express"];

/**
 * The courier a file is from, when its text names exactly one (known couriers
 * first — the merchant's own names — then common ones). Null when unsure: the
 * person chooses.
 */
export function courierFromFile(text: string, known: string[]): string | null {
  const head = text.slice(0, 20_000).toLowerCase();
  const esc = (x: string) => x.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (n: string) => new RegExp(`(^|[^a-z])${esc(n)}([^a-z]|$)`).test(head);
  const hitsKnown = known.filter(has);
  if (hitsKnown.length === 1) return hitsKnown[0]!;
  if (hitsKnown.length > 1) return null;
  const hits = COURIER_NAMES.filter(has);
  return hits.length === 1 ? hits[0]! : null;
}

// ── Payments files ───────────────────────────────────────────────────────────

/**
 * A payments file: money received for orders that no courier settlement
 * covers — a payment gateway's payout export (GoKwik, Safepay, PayFast…) or
 * the store's own list of bank transfers and cash. One row per order: what was
 * paid, the fee kept, what arrived, and optionally the day.
 */
export interface PaymentLine {
  row: number;
  orderRef: string;
  /** Paid by the customer (before fees). */
  amount: bigint;
  fee: bigint;
  /** What reached you: amount − fee unless the file says. */
  net: bigint;
  /** The row's own date (YYYY-MM-DD), when the file has one. */
  date: string | null;
  /** The row's sums don't work out (amount − fee ≠ net): by how much. */
  unexplained: bigint;
}

export interface PaymentsRead {
  lines: PaymentLine[];
  problems: string[];
  date: string | null;
  ref: string | null;
  columns: Record<string, string>;
  /** Rows left out because the file says the payment failed, was refunded or reversed. */
  notPaid: number;
}

const PAYMENT_SPECS: ColumnSpec[] = [
  { key: "orderRef", names: ["order number", "order no", "order id", "order name", "order ref", "order reference", "merchant order id", "merchant reference", "shopify order", "order", "reference number", "ref no", "reference"] },
  { key: "status", names: ["transaction status", "payment status", "status"] },
  { key: "net", names: ["net amount", "net payable", "settled amount", "settlement amount", "payout amount", "amount settled", "amount payable", "net"] },
  { key: "fee", names: ["total fee", "fees", "fee", "commission", "mdr", "charges", "processing fee", "gateway fee", "service charges"] },
  { key: "amount", names: ["transaction amount", "order amount", "gross amount", "paid amount", "amount paid", "gross", "amount", "total"] },
  { key: "date", names: ["settlement date", "payout date", "settled on", "paid on", "payment date", "transfer date", "transaction date", "date"] },
  { key: "ref", names: ["payout id", "payout reference", "settlement id", "settlement reference", "utr", "batch id", "batch no"] },
];

const NOT_PAID = /fail|refund|revers|cancel|declin|void|chargeback|pending|unpaid/i;

/** Read a payments file. Rows the file marks as failed, refunded or reversed are left out. */
export function readPaymentsFile(text: string, decimals: number): PaymentsRead {
  const all = parseCsv(text);
  const found = findColumns(all, PAYMENT_SPECS);
  const problems: string[] = [];
  const none = (msg: string): PaymentsRead => ({ lines: [], problems: [msg], date: null, ref: null, columns: {}, notPaid: 0 });
  if (!found) return none("Couldn't find the columns. The file needs a header row with an order number and an amount.");
  const { headerRow, cols } = found;
  if (cols.orderRef === undefined) return none("Couldn't find an order number column, so the rows can't be matched to your orders.");
  if (cols.amount === undefined && cols.net === undefined) return none("Couldn't find an amount column.");
  const data = all.slice(headerRow + 1).filter((r) => !isBlankOrTotal(r));
  const dates = data.map((r) => cell(r, cols, "date"));
  const fmt = detectDateFormat(dates);
  const lines: PaymentLine[] = [];
  const seen = new Set<string>();
  let notPaid = 0;
  data.slice(0, MAX_SHEET_ROWS).forEach((r, i) => {
    const line = headerRow + 2 + i;
    const orderRef = cell(r, cols, "orderRef");
    if (!orderRef) return;
    const status = cell(r, cols, "status");
    if (status && NOT_PAID.test(status)) return void notPaid++;
    const key = normOrderRef(orderRef) || orderRef.trim().toLowerCase();
    if (seen.has(key)) return void problems.push(`Row ${line}: order ${orderRef} is in the file twice — counted once`);
    seen.add(key);
    const m = (k: string, what: string) => (cols[k] === undefined ? null : money(cell(r, cols, k), decimals, line, what, problems));
    const fee = abs(m("fee", "fee") ?? 0n);
    const net = m("net", "net amount");
    const amount = m("amount", "amount") ?? (net !== null ? net + fee : 0n);
    const netV = net ?? amount - fee;
    if (amount <= 0n && netV <= 0n) return void problems.push(`Row ${line}: order ${orderRef} has no amount — left out`);
    const raw = cell(r, cols, "date");
    const date = raw && fmt ? parseStatementDate(raw, fmt) : null;
    if (raw && !date) problems.push(`Row ${line}: couldn't read the date "${raw}" — the payment date you choose is used`);
    lines.push({ row: line, orderRef: orderRef.slice(0, 100), amount, fee, net: netV, date, unexplained: amount - fee - netV });
  });
  if (data.length > MAX_SHEET_ROWS) problems.push(`Only the first ${MAX_SHEET_ROWS.toLocaleString()} rows were read`);
  const d = sharedValue(dates);
  return {
    lines,
    problems,
    date: d && fmt ? parseStatementDate(d, fmt) : null,
    ref: sharedValue(data.map((r) => cell(r, cols, "ref")))?.slice(0, 100) ?? null,
    columns: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, all[headerRow]![i] ?? ""])),
    notPaid,
  };
}
