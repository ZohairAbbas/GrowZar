/**
 * A statement file of any common kind → CSV text the statement reader
 * understands. Runs in the browser (and in tests on Node): the server only
 * ever receives CSV, so it keeps one reader.
 *
 *  - CSV / TXT in UTF-8, UTF-16 (with or without a byte-order mark) or
 *    Windows-1252 (what older Windows exports use);
 *  - Excel .xlsx (the first sheet; dates written as Excel dates come out as
 *    YYYY-MM-DD);
 *  - ".xls" files that are really an HTML table or Excel 2003 XML — what
 *    many banks' "Excel" downloads are;
 *  - a true old binary .xls can't be read: the message says how to save it.
 */

export class StatementFileError extends Error {}

/** Biggest file accepted before conversion (the CSV sent is checked separately). */
export const MAX_RAW_FILE_BYTES = 10 * 1024 * 1024;

// ── Text encodings ───────────────────────────────────────────────────────────

/** Bytes → text: byte-order marks first, then UTF-16 without one, then UTF-8, falling back to Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  const b = bytes;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  // UTF-16 without a mark: lots of zero bytes in every other position.
  const n = Math.min(b.length, 4000);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i++) if (b[i] === 0) (i % 2 === 0 ? evenZero++ : oddZero++);
  if (n >= 4 && oddZero > n / 4 && evenZero < n / 50) return new TextDecoder("utf-16le").decode(b);
  if (n >= 4 && evenZero > n / 4 && oddZero < n / 50) return new TextDecoder("utf-16be").decode(b);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

// ── CSV out ──────────────────────────────────────────────────────────────────

export function rowsToCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map((c) => cell(c ?? "")).join(",")).join("\n");
}

// ── XML / HTML helpers (no DOM, so the same code runs in tests) ─────────────

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? m[2] ?? m[3] ?? null : null;
};

// ── Zip (for .xlsx) ──────────────────────────────────────────────────────────

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new StatementFileError("This browser can't open Excel files. Save the statement as CSV, or use a newer browser.");
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DS("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files in a zip, by name (only the ones `want` accepts are inflated). */
export async function unzip(bytes: Uint8Array, want: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new StatementFileError("This file isn't a readable Excel file. Save it as CSV and try again.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const names = new TextDecoder("utf-8");
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new StatementFileError("This Excel file looks damaged. Save it as CSV and try again.");
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new StatementFileError("This Excel file is compressed in a way Books can't read. Save it as CSV and try again.");
  }
  return out;
}

// ── .xlsx ────────────────────────────────────────────────────────────────────

/** Built-in Excel number formats that are dates. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Excel's serial day number → YYYY-MM-DD (the 1900 system, with its leap-year quirk). */
export function excelDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export async function xlsxToRows(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const text = (n: string) => (files.has(n) ? new TextDecoder("utf-8").decode(files.get(n)!) : "");
  // The first sheet, as the workbook lists it.
  const wb = text("xl/workbook.xml");
  const firstSheet = /<sheet\b[^>]*>/i.exec(wb)?.[0] ?? "";
  const rid = attr(firstSheet, "r:id");
  const rels = text("xl/_rels/workbook.xml.rels");
  let path = "xl/worksheets/sheet1.xml";
  for (const rel of rels.match(/<Relationship\b[^>]*>/gi) ?? []) {
    if (attr(rel, "Id") === rid) {
      const t = attr(rel, "Target") ?? "";
      path = t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`;
    }
  }
  const sheet = text(path) || [...files.keys()].filter((n) => n.startsWith("xl/worksheets/")).map(text)[0] || "";
  if (!sheet) throw new StatementFileError("This Excel file has no sheet Books can read. Save it as CSV and try again.");
  const shared = (text("xl/sharedStrings.xml").match(/<si\b[\s\S]*?<\/si>/g) ?? []).map((si) => decodeEntities((si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  // Which cell styles are dates.
  const styles = text("xl/styles.xml");
  const customDate = new Set<number>();
  for (const f of styles.match(/<numFmt\b[^>]*>/g) ?? []) {
    const id = Number(attr(f, "numFmtId"));
    const code = (attr(f, "formatCode") ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "").toLowerCase();
    if (/[dy]/.test(code) || /m{1,2}[^a-z]*[dy]|[dy][^a-z]*m/.test(code)) customDate.add(id);
  }
  const xfs = (/<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(styles)?.[0] ?? "").match(/<xf\b[^>]*>/g) ?? [];
  const dateStyle = xfs.map((xf) => {
    const id = Number(attr(xf, "numFmtId") ?? 0);
    return DATE_FORMAT_IDS.has(id) || customDate.has(id);
  });
  const rows: string[][] = [];
  for (const row of sheet.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) ?? []) {
    const r: string[] = [];
    let next = 0;
    for (const c of row.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) ?? []) {
      const open = /<c\b[^>]*>/.exec(c)?.[0] ?? c;
      const ref = attr(open, "r");
      const i = ref ? colIndex(ref) : next;
      next = i + 1;
      const t = attr(open, "t");
      const s = Number(attr(open, "s") ?? 0);
      const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
      let val = "";
      if (t === "s") val = shared[Number(v)] ?? "";
      else if (t === "inlineStr") val = decodeEntities((c.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "")).join(""));
      else if (t === "str" || t === "e") val = decodeEntities(v ?? "");
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) val = dateStyle[s] ? excelDate(Number(v)) ?? v : v;
      while (r.length < i) r.push("");
      r[i] = val.trim();
    }
    rows.push(r);
  }
  return rows.filter((r) => r.some((x) => x !== ""));
}

// ── "Excel" files that are HTML or Excel 2003 XML ────────────────────────────

export function htmlTableToRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (tr.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) ?? []).map((td) => {
      const open = /<t[dh]\b[^>]*>/i.exec(td)?.[0] ?? "";
      const span = Math.min(50, Math.max(1, Number(attr(open, "colspan") ?? 1) || 1));
      const v = decodeEntities(td.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      return [v, ...Array(span - 1).fill("")];
    });
    rows.push(cells.flat());
  }
  return rows.filter((r) => r.some((x) => x !== ""));
}

export function spreadsheetMlToRows(xml: string): string[][] {
  const table = /<(?:ss:)?Worksheet\b[\s\S]*?<\/(?:ss:)?Worksheet>/i.exec(xml)?.[0] ?? xml;
  const rows: string[][] = [];
  for (const row of table.match(/<(?:ss:)?Row\b[\s\S]*?<\/(?:ss:)?Row>|<(?:ss:)?Row\b[^>]*\/>/gi) ?? []) {
    const r: string[] = [];
    for (const cell of row.match(/<(?:ss:)?Cell\b[\s\S]*?<\/(?:ss:)?Cell>|<(?:ss:)?Cell\b[^>]*\/>/gi) ?? []) {
      const open = /<(?:ss:)?Cell\b[^>]*>/i.exec(cell)?.[0] ?? "";
      const idx = attr(open, "ss:Index");
      if (idx) while (r.length < Number(idx) - 1) r.push("");
      const data = /<(?:ss:)?Data\b([^>]*)>([\s\S]*?)<\/(?:ss:)?Data>/i.exec(cell);
      let v = data ? decodeEntities(data[2]!.replace(/<[^>]+>/g, "")).trim() : "";
      // Dates come as 2026-10-13T00:00:00.000.
      if (data && /DateTime/i.test(data[1]!) && /^\d{4}-\d{2}-\d{2}T/.test(v)) v = v.slice(0, 10);
      r.push(v);
    }
    rows.push(r);
  }
  return rows.filter((r) => r.some((x) => x !== ""));
}

// ── Any file ─────────────────────────────────────────────────────────────────

/** A statement file → CSV text, and what kind it was. */
export async function statementFileToCsv(name: string, bytes: Uint8Array): Promise<{ text: string; kind: "csv" | "xlsx" | "html" | "xml" }> {
  if (bytes.length > MAX_RAW_FILE_BYTES) throw new StatementFileError("That file is too large (10 MB at most). Export a shorter period.");
  if (/\.pdf$/i.test(name) || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    throw new StatementFileError("PDF statements can't be read. Download the statement as CSV or Excel from your bank instead.");
  }
  // Zip: .xlsx (or .xlsm). Old binary Excel: can't be read.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return { text: rowsToCsv(await xlsxToRows(bytes)), kind: "xlsx" };
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new StatementFileError("This is an old-style Excel file (.xls). Open it in Excel or Google Sheets and save it as .xlsx or CSV, then import that.");
  }
  const text = decodeText(bytes);
  const head = text.slice(0, 3000).toLowerCase();
  // Excel 2003 XML first: it has <Table> too.
  if (/urn:schemas-microsoft-com:office:spreadsheet/.test(head) || /<(ss:)?workbook\b/.test(head)) return { text: rowsToCsv(spreadsheetMlToRows(text)), kind: "xml" };
  if (/<table\b/.test(head) || (/<html\b/.test(head) && /<table\b/i.test(text))) return { text: rowsToCsv(htmlTableToRows(text)), kind: "html" };
  return { text: text.replace(/^﻿/, ""), kind: "csv" };
}
