import { describe, expect, it } from "vitest";
import { courierFromFile, readPaymentsFile, normOrderRef, normTracking, readLoadsheetFile, readSettlementFile, settlementTotals, sheetStatus } from "../courier-sheet";

describe("courier statuses", () => {
  it("delivered, returned, or neither — whatever the courier calls them", () => {
    for (const s of ["Delivered", "DELIVERED", "Payment Received", "Paid", "Dlvd"]) expect(sheetStatus(s), s).toBe("delivered");
    for (const s of ["Returned", "Return to Shipper", "RTO", "Refused to accept", "Undelivered", "Not Delivered", "Rejected by customer", "Delivery failed"]) expect(sheetStatus(s), s).toBe("returned");
    for (const s of ["Cancelled", "Lost", "Damaged", "In transit"]) expect(sheetStatus(s), s).toBe("other");
    expect(sheetStatus("")).toBeNull();
  });
  it("tracking and order numbers compare however they're written", () => {
    expect(normTracking(" pex-12 345 ")).toBe("PEX12345");
    expect(normOrderRef("#01234")).toBe("1234");
    expect(normOrderRef("SHOP-1234")).toBe("1234");
    expect(normOrderRef("abc")).toBe("");
  });
});

describe("reading a settlement", () => {
  it("your example: 100,000 dispatched, 80,000 delivered, 20,000 back, 15,000 charges, 5,000 WHT, 60,000 paid", () => {
    const csv = ["CN,Order No,Status,COD,Delivery Charges,WHT,Net Payable", "A1,1,Delivered,50000,9000,3000,38000", "A2,2,Delivered,30000,6000,2000,22000", "A3,3,Returned,20000,0,0,0"].join("\n");
    const r = readSettlementFile(csv, 0);
    expect(r.problems).toEqual([]);
    const t = settlementTotals(r.lines);
    expect(t).toMatchObject({ parcels: 3, delivered: 2, returned: 1, cod: 100000n, returnedCod: 20000n, collected: 80000n, delivery: 15000n, withheld: 5000n, net: 60000n, unexplained: 0n });
    // The two checks: dispatched = delivered + returned; delivered = paid + kept.
    expect(t.cod).toBe(t.collected + t.returnedCod);
    expect(t.collected).toBe(t.net + t.delivery + t.returnFee + t.salesTax + t.withheld + t.otherFees + t.unexplained);
  });
  it("charges written as negatives are still what the courier kept", () => {
    const r = readSettlementFile("Tracking,Status,COD Amount,Charges,Net Amount\nA,Delivered,1000,-150,850\n", 0);
    expect(r.lines[0]).toMatchObject({ collected: 1000n, delivery: 150n, net: 850n, unexplained: 0n });
  });
  it("a row that doesn't add up says by how much", () => {
    const r = readSettlementFile("Tracking,Status,COD,Charges,Net\nA,Delivered,1000,100,850\n", 0);
    expect(r.lines[0]!.unexplained).toBe(50n);
  });
  it("no status column: money collected means delivered; a return charge and nothing collected means returned", () => {
    const r = readSettlementFile("Tracking,Collected Amount,Delivery Charges,Return Charges,Net Payable\nA,1000,100,,900\nB,0,,80,-80\n", 0);
    expect(r.lines.map((l) => l.status)).toEqual(["delivered", "returned"]);
    expect(settlementTotals(r.lines).net).toBe(820n);
  });
  it("partial delivery: collected less than the COD", () => {
    const r = readSettlementFile("Tracking,Status,COD Amount,Collected Amount,Charges,Net\nA,Delivered,3000,1000,100,900\n", 0);
    expect(r.lines[0]).toMatchObject({ cod: 3000n, collected: 1000n, net: 900n, unexplained: 0n });
  });
  it("finds the header under title rows, a shared date and number, and says which columns it read", () => {
    const csv = ["Leopards Courier","Payment Advice","Tracking Number,Order ID,Payment Date,CPR No,COD Amount,Net Amount","LE1,10,15/10/2026,CPR-1,500,450","LE2,11,15/10/2026,CPR-1,700,640"].join("\n");
    const r = readSettlementFile(csv, 0);
    expect([r.date, r.ref, r.lines.length]).toEqual(["2026-10-15", "CPR-1", 2]);
    expect(r.columns.tracking).toBe("Tracking Number");
    expect(r.columns.net).toBe("Net Amount");
    expect(r.columns.cod).toBe("COD Amount");
  });
  it("refuses a file it can't match to orders", () => {
    expect(readSettlementFile("Name,Amount\nA,1\n", 0).problems[0]).toMatch(/tracking number or order number/);
  });
});

describe("reading a loadsheet", () => {
  it("one row per parcel; a parcel listed twice counts once", () => {
    const r = readLoadsheetFile("Loadsheet No,Tracking,Order,COD Amount\nLS-9,A1,1,1500\nLS-9,A1,1,1500\nLS-9,A2,2,2500\n", 0);
    expect(r.lines.map((l) => [l.tracking, l.cod])).toEqual([["A1", 1500n], ["A2", 2500n]]);
    expect(r.ref).toBe("LS-9");
    expect(r.problems[0]).toMatch(/twice/);
  });
});

describe("which courier a file is from", () => {
  it("names one the merchant uses, or a common one; unsure means the person chooses", () => {
    expect(courierFromFile("PostEx payment report\nTracking,COD\n", ["Leopards", "PostEx"])).toBe("PostEx");
    expect(courierFromFile("M&P Courier CPR\n", [])).toBe("M&P");
    expect(courierFromFile("Tracking,COD\nA,1\n", ["PostEx"])).toBeNull();
    expect(courierFromFile("PostEx and Leopards combined\n", ["PostEx", "Leopards"])).toBeNull();
    // A word that only contains a name isn't it ("Strax" isn't Trax).
    expect(courierFromFile("Strax Holdings\n", [])).toBeNull();
  });
});

describe("payments files (gateway payouts, bank transfers)", () => {
  it("reads a gateway export: order, amount, fee, net, payout date; failed and refunded rows left out", () => {
    const csv = ["Merchant Order ID,Transaction Status,Transaction Amount,Total Fee,Net Amount,Settlement Date,Payout ID", "#1001,SUCCESS,1500.00,45.00,1455.00,2026-10-10,PO-77", "1002,Refunded,900,27,873,2026-10-10,PO-77", "SHOP-1003,success,2000,60,1940,2026-10-10,PO-77", "#1004,FAILED,500,0,0,2026-10-10,PO-77"].join("\n");
    const r = readPaymentsFile(csv, 2);
    expect(r.problems).toEqual([]);
    expect(r.notPaid).toBe(2);
    expect(r.date).toBe("2026-10-10");
    expect(r.ref).toBe("PO-77");
    expect(r.lines.map((l) => [l.orderRef, l.amount, l.fee, l.net, l.unexplained])).toEqual([
      ["#1001", 150000n, 4500n, 145500n, 0n],
      ["SHOP-1003", 200000n, 6000n, 194000n, 0n],
    ]);
  });
  it("a bank-transfer list: amount only, each row its own date; net = amount", () => {
    const r = readPaymentsFile("Order,Amount,Date\n#2001,1200,05/10/2026\n#2002,800,07/10/2026", 2);
    expect(r.lines.map((l) => [l.orderRef, l.net, l.date])).toEqual([
      ["#2001", 120000n, "2026-10-05"],
      ["#2002", 80000n, "2026-10-07"],
    ]);
    expect(r.date).toBeNull();
  });
  it("only net and fee: amount = net + fee; sums that don't work out are flagged per row", () => {
    const r = readPaymentsFile("order id,net amount,fee,gross amount\n11,970,30,1000\n12,950,30,1000", 2);
    expect(r.lines.map((l) => l.unexplained)).toEqual([0n, 2000n]);
    expect(readPaymentsFile("order id,net amount,fee\n13,970,30", 2).lines[0]!.amount).toBe(100000n);
  });
  it("the same order twice counts once; no order column or no amounts is refused", () => {
    const r = readPaymentsFile("order,amount\n#5,100\n5,100", 2);
    expect(r.lines).toHaveLength(1);
    expect(r.problems[0]).toMatch(/twice/);
    expect(readPaymentsFile("amount,date\n100,2026-10-01", 2).problems[0]).toMatch(/order number/);
    expect(readPaymentsFile("order,note\n#5,hi", 2).problems[0]).toMatch(/amount/);
    expect(readPaymentsFile("order,amount\n#6,0", 2).lines).toHaveLength(0);
  });
});
