import { describe, expect, it } from "vitest";
import { detectDateFormat, guessMapping, lineKeys, parseCsv, parseStatementDate, parseStatementMoney, readStatement } from "../statement-csv";

const read = (text: string, decimals = 2) => {
  const rows = parseCsv(text);
  const m = guessMapping(rows);
  if (!m) throw new Error("no mapping");
  return { m, ...readStatement(rows, m, decimals) };
};

describe("parseCsv", () => {
  it("quotes, escaped quotes, newlines in fields, BOM, CRLF, blank lines", () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line\nbreak"\r\n\r\n1,2,3');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line\nbreak"],
      ["1", "2", "3"],
    ]);
  });
  it("detects semicolons and tabs", () => {
    expect(parseCsv("a;b;c\n1;2,5;3")).toEqual([["a", "b", "c"], ["1", "2,5", "3"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("dates", () => {
  it("each format, with times ignored and 2-digit years", () => {
    expect(parseStatementDate("2026-10-13", "YMD")).toBe("2026-10-13");
    expect(parseStatementDate("13/10/2026 14:22", "DMY")).toBe("2026-10-13");
    expect(parseStatementDate("13.10.26", "DMY")).toBe("2026-10-13");
    expect(parseStatementDate("10/13/2026", "MDY")).toBe("2026-10-13");
    expect(parseStatementDate("13-Oct-2026", "DMonY")).toBe("2026-10-13");
    expect(parseStatementDate("13 OCT 2026", "DMonY")).toBe("2026-10-13");
    expect(parseStatementDate("13-Sept-26", "DMonY")).toBe("2026-09-13");
    expect(parseStatementDate("Oct 13, 2026", "MonDY")).toBe("2026-10-13");
    expect(parseStatementDate("2026-10-13T09:00:00+05:00", "YMD")).toBe("2026-10-13");
    expect(parseStatementDate("31/02/2026", "DMY")).toBeNull();
    expect(parseStatementDate("13/10/2026", "MDY")).toBeNull();
  });
  it("detects the format; day-first wins when both read", () => {
    expect(detectDateFormat(["05/06/2026", "07/06/2026"])).toBe("DMY");
    expect(detectDateFormat(["10/13/2026", "10/14/2026"])).toBe("MDY");
    expect(detectDateFormat(["2026-10-13"])).toBe("YMD");
    expect(detectDateFormat(["13-Oct-2026", ""])).toBe("DMonY");
    expect(detectDateFormat(["hello"])).toBeNull();
  });
});

describe("money", () => {
  it.each([
    ["1,234.50", 123450n],
    ["(1,234.50)", -123450n],
    ["-1234.5", -123450n],
    ["1,234.50-", -123450n],
    ["1,234.50 DR", -123450n],
    ["1,234.50 CR", 123450n],
    ["(10.00) DR", 1000n],
    ["Rs. 1,234", 123400n],
    ["PKR 500", 50000n],
    ["AED 12.5", 1250n],
    ["1.234,56", 123456n],
    ["12,5", 1250n],
    ["+7", 700n],
    ["0.005", 1n],
    ["0.004", 0n],
  ])("%s → %s", (input, want) => {
    expect(parseStatementMoney(input, 2)).toBe(want);
  });
  it("blank is null, junk is invalid, zero-decimal currencies", () => {
    expect(parseStatementMoney("", 2)).toBeNull();
    expect(parseStatementMoney("-", 2)).toBeNull();
    expect(parseStatementMoney("abc", 2)).toBe("invalid");
    expect(parseStatementMoney("1/2/3", 2)).toBe("invalid");
    expect(parseStatementMoney("1,234.6", 0)).toBe(1235n);
  });
});

describe("reading whole statements", () => {
  it("a Pakistani bank export with preamble and debit/credit columns", () => {
    const { m, lines, problems, skipped } = read(
      [
        "Meezan Bank Limited",
        "Account Statement,,,,",
        "Account No,0101-0123456789,,,",
        "Transaction Date,Value Date,Description,Debit,Credit,Balance",
        "01/10/2026,01/10/2026,Opening Balance,,,\"150,000.00\"",
        "02/10/2026,02/10/2026,\"IBFT TO SUPPLIER, PACKAGING\",\"12,500.00\",,\"137,500.00\"",
        "03/10/2026,03/10/2026,TCS COD SETTLEMENT,,\"48,200.00\",\"185,700.00\"",
        "13/10/2026,13/10/2026,ATM WDL,\"5,000.00\",,\"180,700.00\"",
      ].join("\n"),
    );
    expect(m).toMatchObject({ headerRow: 3, dateCol: 0, dateFormat: "DMY", outCol: 3, inCol: 4, balanceCol: 5, amountCol: null });
    expect(m.descCols).toEqual([2]);
    expect(problems).toEqual([]);
    expect(skipped).toBe(1); // the opening balance line
    expect(lines.map((l) => [l.date, l.description, l.amount, l.balance])).toEqual([
      ["2026-10-02", "IBFT TO SUPPLIER, PACKAGING", -1250000n, 13750000n],
      ["2026-10-03", "TCS COD SETTLEMENT", 4820000n, 18570000n],
      ["2026-10-13", "ATM WDL", -500000n, 18070000n],
    ]);
  });

  it("a signed amount column, semicolons, and the money-out flip", () => {
    const text = "Date;Narration;Amount;Balance\n2026-10-01;Meta ads;-2500,00;7500,00\n2026-10-02;Refund;300,00;7800,00";
    const r = read(text);
    expect(r.m).toMatchObject({ amountCol: 2, balanceCol: 3, dateFormat: "YMD" });
    expect(r.lines.map((l) => l.amount)).toEqual([-250000n, 30000n]);
    const flipped = readStatement(parseCsv(text), { ...r.m, flip: true }, 2);
    expect(flipped.lines.map((l) => l.amount)).toEqual([250000n, -30000n]);
  });

  it("a card statement with DR/CR markers and month names, no header", () => {
    const r = read("13-Oct-2026,FACEBK ADS,\"1,000.00 DR\"\n14-Oct-2026,PAYMENT THANK YOU,\"5,000.00 CR\"");
    expect(r.m.headerRow).toBe(-1);
    expect(r.lines.map((l) => [l.date, l.description, l.amount])).toEqual([
      ["2026-10-13", "FACEBK ADS", -100000n],
      ["2026-10-14", "PAYMENT THANK YOU", 500000n],
    ]);
  });

  it("money out written with a minus in a debit column still counts as out", () => {
    const r = read("Date,Details,Withdrawal,Deposit\n05/10/2026,Rent,-40000,\n06/10/2026,Sale,,1000");
    expect(r.lines.map((l) => l.amount)).toEqual([-4000000n, 100000n]);
  });

  it("reports rows it can't read instead of guessing", () => {
    const rows = parseCsv("Date,Description,Amount\n01/10/2026,ok,100\n32/10/2026,bad date,50\n02/10/2026,bad amount,abc");
    const m = guessMapping(rows.slice(0, 2))!;
    const r = readStatement(rows, m, 2);
    expect(r.lines).toHaveLength(1);
    expect(r.problems).toEqual([
      { row: 3, message: '"32/10/2026" isn\'t a date in the chosen format' },
      { row: 4, message: '"abc" isn\'t an amount' },
    ]);
  });

  it("files that aren't statements give no mapping", () => {
    expect(guessMapping(parseCsv("name,email\nAli,ali@x.com"))).toBeNull();
    expect(guessMapping([])).toBeNull();
  });
});

describe("line keys", () => {
  it("stable across imports, numbered for identical lines, independent of case and punctuation", () => {
    const a = { date: "2026-10-01", amount: -100n, description: "ATM WDL", balance: null };
    const b = { ...a, description: "atm-wdl" };
    expect(lineKeys([a, a])).toEqual(["2026-10-01|-100|atm wdl|", "2026-10-01|-100|atm wdl|#2"]);
    expect(lineKeys([b])).toEqual(lineKeys([a]));
    expect(lineKeys([{ ...a, balance: 5n }])[0]).not.toBe(lineKeys([a])[0]);
  });
});
