/**
 * Bank statement files → statement lines. Pure and browser-safe: the import
 * screen previews with it, and the server imports with the same code.
 *
 * Handles what banks actually export: a few lines of preamble before the
 * header, comma / semicolon / tab separators, quoted fields, one signed
 * amount column or separate money-out / money-in columns, negatives written
 * as (1,234.50), "-1,234.50", "1,234.50-" or "1,234.50 DR", and dates as
 * 2026-10-13, 13/10/2026, 10/13/2026, 13-Oct-2026 or Oct 13, 2026.
 */

export type DateFormat = "YMD" | "DMY" | "MDY" | "DMonY" | "MonDY";
export const DATE_FORMATS: Array<{ value: DateFormat; label: string }> = [
  { value: "DMY", label: "Day/month/year (13/10/2026)" },
  { value: "MDY", label: "Month/day/year (10/13/2026)" },
  { value: "YMD", label: "Year-month-day (2026-10-13)" },
  { value: "DMonY", label: "13-Oct-2026" },
  { value: "MonDY", label: "Oct 13, 2026" },
];

export interface StatementMapping {
  headerRow: number;
  dateCol: number;
  dateFormat: DateFormat;
  descCols: number[];
  /** One signed column… */
  amountCol: number | null;
  /** …or money out and money in in separate columns. */
  outCol: number | null;
  inCol: number | null;
  balanceCol: number | null;
  /** The file shows money out as positive in its amount column. */
  flip: boolean;
}

export interface StatementRow {
  /** Row number in the file (1-based), for messages. */
  row: number;
  date: string;
  description: string;
  /** Minor units; + money into the account, − money out. */
  amount: bigint;
  balance: bigint | null;
}

/** The app sits behind nginx's default 1 MB request limit. */
export const MAX_STATEMENT_BYTES = 900 * 1024;
export const MAX_STATEMENT_ROWS = 20_000;

// ── CSV ──────────────────────────────────────────────────────────────────────

function detectDelimiter(text: string): string {
  const sample = text.split(/\r\n|\n|\r/).slice(0, 30);
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = sample.map((l) => splitLine(l, d).length).filter((n) => n > 1);
    if (counts.length === 0) continue;
    // Prefer a separator that gives the same column count on many lines.
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [cols, times] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    const score = times * 100 + cols;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Split one physical line (no embedded newlines); used only to detect the separator. */
function splitLine(line: string, d: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse CSV text into rows of trimmed cells. Quoted fields may contain separators, quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const d = detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === d) {
      row.push(cur.trim());
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cur.trim());
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (cur !== "" || row.length) {
    row.push(cur.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(`${s}T00:00:00Z`);
  return dt.toISOString().slice(0, 10) === s ? s : null;
}

/** A date cell in a given format → YYYY-MM-DD, or null. A time after the date is ignored. */
export function parseStatementDate(cell: string, f: DateFormat): string | null {
  const s = cell.trim().replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?\s*(Z|[+-]\d{2}:?\d{2})?$/i, "").trim();
  let m: RegExpMatchArray | null;
  switch (f) {
    case "YMD":
      m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
      return m ? iso(+m[1]!, +m[2]!, +m[3]!) : null;
    case "DMY":
      m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
      return m ? iso(+m[3]!, +m[2]!, +m[1]!) : null;
    case "MDY":
      m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
      return m ? iso(+m[3]!, +m[1]!, +m[2]!) : null;
    case "DMonY": {
      m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,4})[a-z]*[-/., ]+(\d{2}|\d{4})$/);
      const mon = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
      return m && mon ? iso(+m[3]!, mon, +m[1]!) : null;
    }
    case "MonDY": {
      m = s.match(/^([A-Za-z]{3,4})[a-z]*[-/. ](\d{1,2}),?[-/. ]+(\d{2}|\d{4})$/);
      const mon = m ? MONTHS[m[1]!.toLowerCase()] : undefined;
      return m && mon ? iso(+m[3]!, mon, +m[2]!) : null;
    }
  }
}

/** The format that reads every non-empty cell; day-first wins a tie with month-first. */
export function detectDateFormat(cells: string[]): DateFormat | null {
  const filled = cells.map((c) => c.trim()).filter(Boolean);
  if (filled.length === 0) return null;
  for (const f of ["YMD", "DMY", "MDY", "DMonY", "MonDY"] as DateFormat[]) {
    if (filled.every((c) => parseStatementDate(c, f) !== null)) return f;
  }
  return null;
}

// ── Money ────────────────────────────────────────────────────────────────────

/** "1,234.50", "(1,234.50)", "-1234.5", "1,234.50-", "1,234.50 DR", "Rs. 1,234", "1.234,50" → minor units; "" → null. */
export function parseStatementMoney(cell: string, decimals: number): bigint | null | "invalid" {
  let s = cell.trim();
  if (!s || s === "-" || s === "—") return null;
  let neg = false;
  const suffix = s.match(/\s*(CR|DR|Cr|Dr|cr|dr)\.?$/);
  if (suffix) {
    if (suffix[1]!.toLowerCase() === "dr") neg = !neg;
    s = s.slice(0, suffix.index).trim();
  }
  if (/^\(.*\)$/.test(s)) {
    neg = !neg;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(PKR|Rs\.?|AED|SAR|INR|USD|EUR|GBP|[$€£₹﷼])\s*/i, "").replace(/\s*(PKR|AED|SAR|INR|USD|EUR|GBP)$/i, "").trim();
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1).trim();
  } else if (s.endsWith("-")) {
    neg = !neg;
    s = s.slice(0, -1).trim();
  } else if (s.startsWith("+")) s = s.slice(1).trim();
  s = s.replace(/[\s']/g, "");
  // Decimal comma (1.234,56 or 1234,56) when there is no dot after the comma.
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return "invalid";
  const [w, f = ""] = s.split(".");
  // Round half up to the currency's decimals.
  const scale = 10n ** BigInt(decimals);
  let v = BigInt(w!) * scale + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (f.length > decimals && Number(f[decimals]) >= 5) v += 1n;
  return neg ? -v : v;
}

// ── Mapping ──────────────────────────────────────────────────────────────────

const looksLikeMoney = (c: string) => c.trim() !== "" && parseStatementMoney(c, 2) !== "invalid";

/** Guess the header row and columns. The import screen shows the guess and lets people change it. */
export function guessMapping(rows: string[][]): StatementMapping | null {
  if (rows.length === 0) return null;
  // The header: the last mostly-text row before the first row with a date in it.
  let firstData = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    if (rows[i]!.some((c) => detectDateFormat([c]) !== null) && rows[i]!.some((c) => looksLikeMoney(c) && /\d/.test(c) && detectDateFormat([c]) === null)) {
      firstData = i;
      break;
    }
  }
  if (firstData < 0) return null;
  const headerRow = firstData > 0 ? firstData - 1 : -1;
  const header = headerRow >= 0 ? rows[headerRow]!.map((h) => h.toLowerCase()) : [];
  const data = rows.slice(firstData, firstData + 200);
  const width = Math.max(...data.map((r) => r.length));
  const col = (i: number) => data.map((r) => r[i] ?? "");
  const named = (re: RegExp, except: number[] = []) => header.findIndex((h, i) => re.test(h) && !except.includes(i));

  let dateCol = named(/date|value dt|txn dt|posting/);
  if (dateCol < 0 || detectDateFormat(col(dateCol).slice(0, 50)) === null) {
    dateCol = [...Array(width).keys()].find((i) => detectDateFormat(col(i).slice(0, 50)) !== null) ?? -1;
  }
  if (dateCol < 0) return null;
  const dateFormat = detectDateFormat(col(dateCol)) ?? detectDateFormat(col(dateCol).slice(0, 50)) ?? "DMY";

  const numeric = (i: number) => {
    const cs = col(i).filter((c) => c.trim());
    return cs.length > 0 && cs.every(looksLikeMoney) && cs.some((c) => /\d/.test(c));
  };
  const balanceCol = (() => {
    const i = named(/balance|bal\b/);
    return i >= 0 && numeric(i) ? i : null;
  })();
  const outIdx = named(/debit|withdraw|paid out|money out|^dr\b|outflow|payment/, [dateCol]);
  const inIdx = named(/credit|deposit|paid in|money in|^cr\b|inflow|receipt/, [dateCol, outIdx]);
  let amountCol: number | null = null;
  let outCol: number | null = null;
  let inCol: number | null = null;
  if (outIdx >= 0 && inIdx >= 0 && outIdx !== balanceCol && inIdx !== balanceCol) {
    outCol = outIdx;
    inCol = inIdx;
  } else {
    const a = named(/amount|amt|value/, [dateCol, balanceCol ?? -1]);
    amountCol = a >= 0 && numeric(a) ? a : [...Array(width).keys()].find((i) => i !== dateCol && i !== balanceCol && numeric(i)) ?? null;
    if (amountCol === null) return null;
  }
  const used = new Set([dateCol, amountCol, outCol, inCol, balanceCol].filter((x): x is number => x !== null));
  const descNamed = named(/desc|narrat|detail|particular|remark|memo|transaction|reference|payee/, [...used]);
  const textCols = [...Array(width).keys()].filter((i) => !used.has(i) && !numeric(i) && detectDateFormat(col(i).slice(0, 20)) === null);
  const avgLen = (i: number) => col(i).reduce((s, c) => s + c.length, 0) / data.length;
  const descCols = descNamed >= 0 ? [descNamed] : textCols.length ? [textCols.sort((a, b) => avgLen(b) - avgLen(a))[0]!] : [];
  return { headerRow, dateCol, dateFormat, descCols, amountCol, outCol, inCol, balanceCol, flip: false };
}

export interface ReadResult {
  lines: StatementRow[];
  /** Rows that looked like transactions but couldn't be read. */
  problems: Array<{ row: number; message: string }>;
  /** Rows skipped as not transactions (blank amounts: headings, opening balance lines). */
  skipped: number;
}

/**
 * Bank account numbers, IBANs and card numbers in a description are masked to
 * their last 4 digits before anything is kept: matching never needs them, and
 * they mustn't be stored. A run of 10 or more digits (spaces or dashes
 * allowed) counts — account, card and phone numbers; shorter references,
 * dates and amounts stay as they are.
 */
export function maskSensitive(description: string): string {
  return description
    // Country, check digits, a bank code, then groups that each hold a digit (so a name after it isn't swallowed).
    .replace(/\b[A-Z]{2}\d{2}[ ]?[A-Z0-9]{4}(?:[ ]?(?=[A-Z0-9]{0,3}\d)[A-Z0-9]{4}){2,6}(?:(?=[A-Z0-9]{0,2}\d)[A-Z0-9]{1,3})?\b/gi, (m) => {
      const digits = m.replace(/[^0-9]/g, "");
      return digits.length >= 6 ? `IBAN ••${digits.slice(-4)}` : m;
    })
    .replace(/\d(?:[\s-]?\d){9,}/g, (m) => `••${m.replace(/\D/g, "").slice(-4)}`);
}

/** Turn rows into statement lines with a mapping. */
export function readStatement(rows: string[][], m: StatementMapping, decimals: number): ReadResult {
  const lines: StatementRow[] = [];
  const problems: ReadResult["problems"] = [];
  let skipped = 0;
  const money = (r: string[], i: number | null) => (i === null ? null : parseStatementMoney(r[i] ?? "", decimals));
  for (let i = m.headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;
    const dateCell = r![m.dateCol] ?? "";
    let amount: bigint | null;
    if (m.amountCol !== null) {
      const a = money(r!, m.amountCol);
      if (a === "invalid") {
        problems.push({ row: rowNo, message: `"${r![m.amountCol]}" isn't an amount` });
        continue;
      }
      amount = a === null ? null : m.flip ? -a : a;
    } else {
      const o = money(r!, m.outCol);
      const n = money(r!, m.inCol);
      if (o === "invalid" || n === "invalid") {
        problems.push({ row: rowNo, message: `"${o === "invalid" ? r![m.outCol!] : r![m.inCol!]}" isn't an amount` });
        continue;
      }
      // Money out may be written with or without a minus.
      amount = o === null && n === null ? null : (n ?? 0n) - (o === null ? 0n : o < 0n ? -o : o);
    }
    const date = parseStatementDate(dateCell, m.dateFormat);
    if (amount === null || amount === 0n) {
      skipped++;
      continue;
    }
    if (!date) {
      problems.push({ row: rowNo, message: dateCell ? `"${dateCell}" isn't a date in the chosen format` : "No date" });
      continue;
    }
    const bal = money(r!, m.balanceCol);
    const description = maskSensitive(m.descCols.map((c) => (r![c] ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ")).slice(0, 500);
    lines.push({ row: rowNo, date, description, amount, balance: bal === "invalid" ? null : bal });
    if (lines.length > MAX_STATEMENT_ROWS) {
      problems.push({ row: rowNo, message: `Only the first ${MAX_STATEMENT_ROWS.toLocaleString()} lines can be imported at once` });
      lines.pop();
      break;
    }
  }
  return { lines, problems, skipped };
}

/**
 * A stable key per line so importing the same (or an overlapping) file again
 * skips what's already in. Identical lines in one file are numbered.
 */
export function lineKeys(lines: Array<Pick<StatementRow, "date" | "amount" | "description" | "balance">>): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = `${l.date}|${l.amount}|${l.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${l.balance ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}
