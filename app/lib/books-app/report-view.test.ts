import { describe, expect, it } from "vitest";

import { ledgerHref, viewSection } from "./report-view";

describe("reports as the screens show them (B6)", () => {
  const s = {
    key: "sales",
    label: "Sales",
    rows: [
      { accountId: "a1", code: "4000", name: "Sales", amount: 150_000n },
      { accountId: "a2", code: "4010", name: "Online", amount: 50_000n, depth: 1 },
      { accountId: "cash:collected", code: "", name: "Collected from couriers", amount: 10_000n },
      { accountId: "a3", code: "4100", name: "Wholesale", amount: 0n, header: true },
    ],
    total: 210_000n,
  };
  const m = (v: bigint) => `${v}`;

  it("each account opens its general-ledger lines for the same dates; cash rows and headings open nothing", () => {
    const v = viewSection(s, m, false, "2026-10-01", "2026-10-31");
    expect(v.rows[0]!.href).toBe("/books/reports/general-ledger?account=a1&range=custom&from=2026-10-01&to=2026-10-31");
    expect(v.rows[2]!.href).toBeNull();
    expect(v.rows[3]!.href).toBeNull();
    expect(ledgerHref("", "2026-10-01", "2026-10-31")).toBeNull();
    expect(v.total).toBe("210000");
  });

  it("an accountant sees codes on top-level accounts; an owner sees names", () => {
    expect(viewSection(s, m, true, "2026-10-01", "2026-10-31").rows.map((r) => r.name)).toEqual(["4000 · Sales", "Online", "Collected from couriers", "4100 · Wholesale"]);
    expect(viewSection(s, m, false, "2026-10-01", "2026-10-31").rows.map((r) => r.name)).toEqual(["Sales", "Online", "Collected from couriers", "Wholesale"]);
  });
});
