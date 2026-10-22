import { describe, expect, it } from "vitest";
import { buildXlsx } from "./xlsx-fixture";
import { decodeText, excelDate, htmlTableToRows, rowsToCsv, spreadsheetMlToRows, statementFileToCsv, xlsxToRows } from "../statement-file";
import { guessMapping, parseCsv, readStatement } from "../statement-csv";

const enc = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string, bom = true) => {
  const out = new Uint8Array((bom ? 2 : 0) + s.length * 2);
  let i = 0;
  if (bom) {
    out[0] = 0xff;
    out[1] = 0xfe;
    i = 2;
  }
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out[i++] = c & 0xff;
    out[i++] = c >> 8;
  }
  return out;
};

describe("text encodings", () => {
  it("UTF-8 with and without a mark, UTF-16 with and without, Windows-1252", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("Date,Amount")]))).toBe("Date,Amount");
    expect(decodeText(enc("Café,1"))).toBe("Café,1");
    expect(decodeText(utf16le("Date,Amount\n01/10/2026,5"))).toBe("Date,Amount\n01/10/2026,5");
    expect(decodeText(utf16le("Date,Amount\n01/10/2026,5", false))).toBe("Date,Amount\n01/10/2026,5");
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café"); // 0xE9 alone isn't UTF-8
  });
  it("CSV out quotes what needs quoting", () => {
    expect(rowsToCsv([["a,b", 'say "hi"', "x\ny", "plain"]])).toBe('"a,b","say ""hi""","x\ny",plain');
    expect(parseCsv(rowsToCsv([["a,b", 'say "hi"', "plain"]]))).toEqual([["a,b", 'say "hi"', "plain"]]);
  });
});

describe("Excel files", () => {
  it("reads an .xlsx: text, numbers, the first sheet only, money formats aren't dates", async () => {
    const bytes = buildXlsx([
      { name: "Statement", rows: [["Date", "Description", "Debit", "Credit", "Balance"], ["01/10/2026", "IBFT ALI & SONS", { v: 1500.5, s: "money" }, null, { v: 8499.5, s: "money" }], ["02/10/2026", "COD PAYOUT <TCS>", null, 2000, 10499.5]] },
      { name: "Other", rows: [["ignore me"]] },
    ]);
    const rows = await xlsxToRows(bytes);
    expect(rows).toEqual([
      ["Date", "Description", "Debit", "Credit", "Balance"],
      ["01/10/2026", "IBFT ALI & SONS", "1500.5", "", "8499.5"],
      ["02/10/2026", "COD PAYOUT <TCS>", "", "2000", "10499.5"],
    ]);
    const { text, kind } = await statementFileToCsv("statement.xlsx", bytes);
    expect(kind).toBe("xlsx");
    const csv = parseCsv(text);
    const m = guessMapping(csv)!;
    const r = readStatement(csv, m, 2);
    expect(r.lines.map((l) => [l.date, l.amount])).toEqual([["2026-10-01", -150050n], ["2026-10-02", 200000n]]);
  });
  it("Excel date numbers become dates", () => {
    expect(excelDate(46296)).toBe("2026-10-01");
    expect(excelDate(0)).toBeNull();
  });
  it('"Excel" downloads that are HTML tables', async () => {
    const html = `<html><body><table><tr><th>Date</th><th>Narration</th><th colspan="2">Amount</th></tr><tr><td>01/10/2026</td><td>ALI&nbsp;&amp;&nbsp;SONS<br>IBFT</td><td>-1,500.00</td><td></td></tr></table></body></html>`;
    expect(htmlTableToRows(html)).toEqual([["Date", "Narration", "Amount", ""], ["01/10/2026", "ALI & SONS IBFT", "-1,500.00", ""]]);
    expect((await statementFileToCsv("x.xls", enc(html))).kind).toBe("html");
  });
  it("Excel 2003 XML, with skipped cells and dates", async () => {
    const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="S"><Table><Row><Cell><Data ss:Type="String">Date</Data></Cell><Cell><Data ss:Type="String">Amount</Data></Cell></Row><Row><Cell><Data ss:Type="DateTime">2026-10-01T00:00:00.000</Data></Cell><Cell ss:Index="3"><Data ss:Type="Number">250</Data></Cell></Row></Table></Worksheet></Workbook>`;
    expect(spreadsheetMlToRows(xml)).toEqual([["Date", "Amount"], ["2026-10-01", "", "250"]]);
    expect((await statementFileToCsv("x.xls", enc(xml))).kind).toBe("xml");
  });
  it("PDF and old binary Excel say what to do", async () => {
    await expect(statementFileToCsv("s.pdf", enc("%PDF-1.4"))).rejects.toThrow(/PDF statements can't be read/);
    await expect(statementFileToCsv("s.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).rejects.toThrow(/old-style Excel/);
    await expect(statementFileToCsv("s.xlsx", new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).rejects.toThrow(/isn't a readable Excel file/);
  });
});

import { maskSensitive } from "../statement-csv";

describe("restricted numbers are masked before anything is kept", () => {
  it("account numbers, IBANs, card and phone numbers → last 4 only; references and dates stay", () => {
    expect(maskSensitive("IBFT TO 01234567890123 ALI")).toBe("IBFT TO ••0123 ALI");
    expect(maskSensitive("FROM PK36SCBL0000001123456702 HAMZA")).toBe("FROM IBAN ••6702 HAMZA");
    expect(maskSensitive("POS 4111 1111 1111 1111 DARAZ")).toBe("POS ••1111 DARAZ");
    expect(maskSensitive("RAAST 0300-1234567")).toBe("RAAST ••4567");
    expect(maskSensitive("CHQ 004512 ON 13/10/2026 REF 77831")).toBe("CHQ 004512 ON 13/10/2026 REF 77831");
    expect(maskSensitive("INV-0012 PAYMENT")).toBe("INV-0012 PAYMENT");
  });
  it("the statement reader masks what it reads", () => {
    const rows = [["Date", "Description", "Amount"], ["2026-10-01", "IBFT FROM 1234567890123 ALI", "500"]];
    const r = readStatement(rows, { headerRow: 0, dateCol: 0, dateFormat: "YMD", descCols: [1], amountCol: 2, outCol: null, inCol: null, balanceCol: null, flip: false }, 2);
    expect(r.lines[0]!.description).toBe("IBFT FROM ••0123 ALI");
  });
});
describe("IBAN shapes", () => {
  it("grouped, compact, and lengths that aren't a multiple of 4", () => {
    expect(maskSensitive("PK36 SCBL 0000 0011 2345 6702 X")).toBe("IBAN ••6702 X");
    expect(maskSensitive("AE070331234567890123456 Y")).toBe("IBAN ••3456 Y");
    expect(maskSensitive("GB29NWBK60161331926819")).toBe("IBAN ••6819");
  });
});
