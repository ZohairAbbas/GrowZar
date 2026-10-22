/**
 * Growzar: the Excel writer behind Books' workbook (D-91: exceljs), with the
 * same sheet shape and style names as Financify's dashboard writer
 * (`~/lib/dashboard-v3/xlsx`, not part of the handover), so workbook.server.ts
 * reads as Financify's.
 */
import ExcelJS from "exceljs";

export type StyleKey =
  | "default"
  | "title"
  | "subtle"
  | "note"
  | "header"
  | "headerRight"
  | "section"
  | "indent"
  | "bold"
  | "labelSubtotal"
  | "labelTotal"
  | "money"
  | "moneySubtotal"
  | "moneyTotal"
  | "moneySubtle";

export type XCell = { v: string | number; s?: StyleKey } | string | number | null;

export interface XSheet {
  name: string;
  /** Column widths, in characters. */
  cols: number[];
  rows: XCell[][];
  freezeRows?: number;
  merges?: string[];
  landscape?: boolean;
}

const GREY = "FF616161";
const LINE = "FF9CA3AF";
const DARK = "FF374151";
const SECTION_FILL = "FFE6EDF7";
const HEADER_FILL = "FFF1F2F4";

function styleFor(s: StyleKey, moneyFormat: string): Partial<ExcelJS.Style> {
  const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const money = { numFmt: moneyFormat, alignment: { horizontal: "right" as const } };
  switch (s) {
    case "title":
      return { font: { bold: true, size: 16 } };
    case "subtle":
      return { font: { color: { argb: GREY } } };
    case "note":
      return { font: { italic: true, color: { argb: GREY } }, alignment: { wrapText: false } };
    case "header":
      return { font: { bold: true, color: { argb: GREY } }, fill: fill(HEADER_FILL), border: { bottom: { style: "thin", color: { argb: LINE } } } };
    case "headerRight":
      return { font: { bold: true, color: { argb: GREY } }, fill: fill(HEADER_FILL), border: { bottom: { style: "thin", color: { argb: LINE } } }, alignment: { horizontal: "right" } };
    case "section":
      return { font: { bold: true }, fill: fill(SECTION_FILL) };
    case "indent":
      return { alignment: { indent: 2 }, font: { color: { argb: "FF444444" } } };
    case "bold":
      return { font: { bold: true } };
    case "labelSubtotal":
      return { font: { bold: true }, border: { top: { style: "thin", color: { argb: LINE } } } };
    case "labelTotal":
      return { font: { bold: true }, border: { top: { style: "thin", color: { argb: DARK } }, bottom: { style: "double", color: { argb: DARK } } } };
    case "money":
      return money;
    case "moneySubtle":
      return { ...money, font: { color: { argb: GREY } } };
    case "moneySubtotal":
      return { ...money, font: { bold: true }, border: { top: { style: "thin", color: { argb: LINE } } } };
    case "moneyTotal":
      return { ...money, font: { bold: true }, border: { top: { style: "thin", color: { argb: DARK } }, bottom: { style: "double", color: { argb: DARK } } } };
    default:
      return {};
  }
}

/** Excel's sheet names: at most 31 characters, none of []:*?/\ and unique. */
function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";
  let out = base;
  for (let i = 2; used.has(out.toLowerCase()); i++) out = `${base.slice(0, 28)} ${i}`;
  used.add(out.toLowerCase());
  return out;
}

export async function buildXlsx(sheets: XSheet[], meta: { title: string; creator: string; decimals?: number }): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.creator;
  wb.title = meta.title;
  wb.created = new Date();
  const d = meta.decimals ?? 2;
  const moneyFormat = `#,##0${d > 0 ? `.${"0".repeat(d)}` : ""};[Red]-#,##0${d > 0 ? `.${"0".repeat(d)}` : ""}`;
  const used = new Set<string>();
  for (const s of sheets) {
    const ws = wb.addWorksheet(sheetName(s.name, used), {
      views: s.freezeRows ? [{ state: "frozen", ySplit: s.freezeRows }] : [],
      pageSetup: { orientation: s.landscape ? "landscape" : "portrait", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    ws.columns = s.cols.map((w) => ({ width: w }));
    s.rows.forEach((row, r) => {
      const xr = ws.getRow(r + 1);
      row.forEach((c, i) => {
        if (c === null || c === undefined) return;
        const cell = xr.getCell(i + 1);
        if (typeof c === "string" || typeof c === "number") {
          cell.value = c;
          return;
        }
        cell.value = c.v;
        if (c.s && c.s !== "default") cell.style = styleFor(c.s, moneyFormat);
      });
    });
    for (const m of s.merges ?? []) ws.mergeCells(m);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
