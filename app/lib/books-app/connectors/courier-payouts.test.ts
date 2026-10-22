import { describe, expect, it } from "vitest";

import { courierName, minor, payoutDay, planPayout, type SettlementWire } from "./courier-payouts";

const m = { receivable: "owed", receivedIn: "bank", delivery: "delivery", returns: "returns", tax: "wht", other: "other" };
const acc = { held: "held", unexplained: "unexplained", others: "others" };
const $ = (amount: string | number) => ({ amount: String(amount), currency: "PKR" });

const line = (collected: number, deductions: Array<[string, number]>) => ({
  orderId: "1",
  collectedAmount: $(collected),
  deductions: deductions.map(([type, amount]) => ({ type, amount: $(amount) })),
  netAmount: $(collected - deductions.reduce((t, [, a]) => t + a, 0)),
});

const payout = (patch: Partial<SettlementWire>): SettlementWire => ({
  id: "s1",
  courier: "postex",
  settlementDate: "2026-10-10T00:00:00.000Z",
  receivedAt: null,
  direction: "payout",
  netPaid: $(0),
  ...patch,
});

/** Debits and credits of the resulting entry, as the posting engine would make them. */
function ledger(p: ReturnType<typeof planPayout>) {
  if (p.kind !== "post") throw new Error("not posted");
  const out: Record<string, bigint> = {};
  const add = (k: string, v: bigint) => (out[k] = (out[k] ?? 0n) + v);
  add("bank", BigInt(p.data.received));
  for (const d of p.data.deductions) add(d.accountId, BigInt(d.amount));
  if (p.data.others) add("others", -BigInt(p.data.others.amount));
  add("owed", -p.gross);
  expect(Object.values(out).reduce((s, v) => s + v, 0n)).toBe(0n);
  return out;
}

describe("courier payout rules", () => {
  it("names and amounts", () => {
    expect(courierName("postex")).toBe("PostEx");
    expect(courierName("new_courier")).toBe("New Courier");
    expect(minor($("1234.565"), 2)).toBe(123457n);
    expect(minor($("-10.5"), 2)).toBe(-1050n);
    expect(payoutDay({ receivedAt: "2026-10-12T09:00:00Z", settlementDate: "2026-10-10T00:00:00Z" })).toBe("2026-10-12");
    expect(payoutDay({ receivedAt: null, settlementDate: "2026-10-10T00:00:00Z" })).toBe("2026-10-10");
  });

  it("a whole payout: charges by kind, tax withheld, money kept back to Held by courier (D-87)", () => {
    const p = planPayout(
      payout({
        netPaid: $(8_350),
        grossCollected: $(10_000),
        linesGross: $(10_000),
        unattributedGross: $(0),
        totalDeductions: $(1_650),
        lines: [line(6_000, [["delivery_fee", 250], ["cod_fee", 60]]), line(4_000, [["delivery_fee", 200], ["reversal_fee", 40]])],
        settlementDeductions: [{ type: "wht", amount: $(100) }, { type: "carry_forward", amount: $(1_000) }],
      }),
      2,
      m,
      acc,
    );
    expect(ledger(p)).toEqual({ bank: 835_000n, delivery: 51_000n, returns: 4_000n, wht: 10_000n, held: 100_000n, owed: -1_000_000n });
  });

  it("a carry-forward released into a payout reduces what's held", () => {
    const p = planPayout(
      payout({ netPaid: $(6_500), grossCollected: $(6_000), unattributedGross: $(0), totalDeductions: $(-500), lines: [line(6_000, [["delivery_fee", 500]])], settlementDeductions: [{ type: "carry_forward", amount: $(-1_000) }] }),
      2,
      m,
      acc,
    );
    expect(ledger(p)).toMatchObject({ bank: 650_000n, delivery: 50_000n, held: -100_000n, owed: -600_000n });
  });

  it("a small residual goes with delivery charges; a flagged one to 'not explained' (D-92)", () => {
    const base = { netPaid: $(9_500), grossCollected: $(10_000), unattributedGross: $(0), totalDeductions: $(500), lines: [line(10_000, [["delivery_fee", 300]])], settlementDeductions: [{ type: "unallocated", amount: $(200) }] };
    const quiet = planPayout(payout(base), 2, m, acc);
    expect(ledger(quiet)).toMatchObject({ delivery: 50_000n });
    expect(quiet.kind === "post" && quiet.flagged).toBe(false);
    const loud = planPayout(payout({ ...base, invariantOk: false, invariantReason: "unallocated_gap" }), 2, m, acc);
    expect(ledger(loud)).toMatchObject({ delivery: 30_000n, unexplained: 20_000n });
    expect(loud.kind === "post" && loud.flagged).toBe(true);
  });

  it("a shared batch: only this store's parcels come off what couriers owe; the rest is held apart", () => {
    // 2,000 of 10,000 collected is ours. Our parcels' charges 100; WHT 500 on the whole batch (our share 100);
    // the other business's fees (unallocated 600) go with its money.
    const p = planPayout(
      payout({
        courier: "tcs",
        netPaid: $(8_800),
        grossCollected: $(10_000),
        linesGross: $(2_000),
        unattributedGross: $(8_000),
        totalDeductions: $(1_200),
        lines: [line(2_000, [["delivery_fee", 100]])],
        settlementDeductions: [{ type: "wht", amount: $(500) }, { type: "unallocated", amount: $(600) }],
      }),
      2,
      m,
      acc,
    );
    const l = ledger(p);
    expect(l).toEqual({ bank: 880_000n, delivery: 10_000n, wht: 10_000n, others: -700_000n, owed: -200_000n });
    expect(p.kind === "post" && p.mixed).toBe(true);
  });

  it("a courier's invoice is money going out", () => {
    const p = planPayout(
      payout({ direction: "invoice", netPaid: $(-300), grossCollected: $(0), unattributedGross: $(0), totalDeductions: $(300), lines: [line(0, [["reversal_fee", 300]])] }),
      2,
      m,
      acc,
    );
    expect(ledger(p)).toEqual({ bank: -30_000n, returns: 30_000n, owed: 0n });
  });

  it("left out: no parcels of the store's, or figures that don't add up", () => {
    expect(planPayout(payout({ netPaid: $(100), lines: [] }), 2, m, acc)).toEqual({ kind: "skip", reason: "no_lines" });
    expect(planPayout(payout({ netPaid: $(100), lines: [line(100, [])], invariantOk: false, invariantReason: "identity_broken" }), 2, m, acc)).toEqual({ kind: "skip", reason: "identity_broken" });
  });
});
