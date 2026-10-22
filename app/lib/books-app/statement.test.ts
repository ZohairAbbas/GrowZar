import { describe, expect, it } from "vitest";

import { parseCsv, readStatement, type StatementMapping } from "../books/statement-csv";
import { minimiseStatement } from "./statement";

/** Synthetic statement: made-up numbers only (D-72: no real statement is ever used). */
const rows = parseCsv(
  [
    "Date,Branch,Narration,Cheque,Debit,Credit,Balance",
    "01/10/2026,0042,IBFT TO ACC 1234567890123 ALI TRADERS,,1500.00,,8500.00",
    '02/10/2026,0042,"CARD 4111 1111 1111 1234, POS",77,250.00,,8250.00',
    "03/10/2026,0042,COD PAYOUT PK36SCBL0000001123456702,,,2000.00,10250.00",
  ].join("\n"),
);
const m: StatementMapping = { headerRow: 0, dateCol: 0, dateFormat: "DMY", descCols: [2], amountCol: null, outCol: 4, inCol: 5, balanceCol: 6, flip: false };

describe("what leaves the browser (D-72)", () => {
  it("only the mapped columns, descriptions masked to the last four digits", () => {
    const { text, mapping } = minimiseStatement(rows, m);
    expect(text).not.toMatch(/0042/); // the branch column stays behind
    expect(text).not.toMatch(/,77,/); // so does the cheque number
    expect(text).not.toMatch(/1234567890123|4111 1111 1111|PK36SCBL0000001123456702/);
    expect(text).toMatch(/••0123/);
    expect(text).toMatch(/IBAN ••6702/);
    expect(mapping).toMatchObject({ dateCol: 0, descCols: [1], outCol: 2, inCol: 3, balanceCol: 4, amountCol: null });
  });

  it("reads back to the same lines as the full file", () => {
    const full = readStatement(rows, m, 2);
    const { text, mapping } = minimiseStatement(rows, m);
    const small = readStatement(parseCsv(text), mapping, 2);
    expect(small.lines).toEqual(full.lines);
    expect(small.lines.map((l) => l.amount)).toEqual([-150000n, -25000n, 200000n]);
  });

  it("a signed amount column and two description columns", () => {
    const r = parseCsv(["Date,Ref,Detail,Amount", "2026-10-01,9988776655443,Rent,-500"].join("\n"));
    const { text, mapping } = minimiseStatement(r, { headerRow: 0, dateCol: 0, dateFormat: "YMD", descCols: [1, 2], amountCol: 3, outCol: null, inCol: null, balanceCol: null, flip: false });
    expect(text.split("\n")[1]).toBe("2026-10-01,••5443,Rent,-500");
    expect(mapping).toMatchObject({ descCols: [1, 2], amountCol: 3 });
  });
});

describe("courier files leave the browser without the buyer's details", () => {
  it("a settlement file: only the columns Books reads, and it reads the same", async () => {
    const { minimiseSheet } = await import("./statement");
    const { readSettlementFile } = await import("../books/courier-sheet");
    const text = [
      "PostEx Settlement Report",
      "Tracking Number,Order Ref,Customer Name,Phone,Address,Status,COD Amount,Delivery Charges,Net Payable,Payment Date",
      "PX111,#1001,Test Buyer,03001234567,House 1 Street 2,Delivered,1500,150,1350,2026-10-12",
      "PX112,#1002,Other Buyer,03007654321,Flat 3,Returned,0,100,-100,2026-10-12",
    ].join("\n");
    const small = minimiseSheet(text, "settlement")!;
    expect(small).not.toMatch(/Buyer|0300|Street|Flat|Customer|Phone|Address/);
    expect(readSettlementFile(small, 2).lines).toEqual(readSettlementFile(text, 2).lines);
    expect(minimiseSheet("just,some\nwords,here", "settlement")).toBeNull();
  });
});
