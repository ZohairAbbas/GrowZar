import { describe, expect, it } from "vitest";

import {
  byCity,
  byDay,
  byVariant,
  bucketOf,
  courierTiming,
  productLines,
  profitAfterReturns,
  roas,
  rollup,
  type RollupOrder,
} from "./rollups";
import { parseAdSpendDay } from "./ad-spend";

const pkr = (amount: string) => ({ amount, currency: "PKR" });
let n = 0;

function order(o: Partial<RollupOrder> = {}): RollupOrder {
  n += 1;
  return {
    orderId: `o${n}`,
    localDay: "2026-09-20",
    createdAt: new Date("2026-09-20T06:00:00Z"),
    currency: "PKR",
    placed: pkr("1000.00"),
    delivered: pkr("1000.00"),
    refunded: pkr("0.00"),
    collected: null,
    cogs: pkr("300.00"),
    cogsComplete: true,
    courierFee: pkr("200.00"),
    outcome: "delivered",
    outcomeTiming: { basis: "happened_on", at: new Date("2026-09-23T06:00:00Z") },
    parcelCount: 1,
    courier: "tcs",
    city: "Lahore",
    lines: [{ variantId: "v1", productId: "p1", quantity: 1, value: pkr("1000.00"), cost: pkr("300.00") }],
    ...o,
  };
}

const returned = (o: Partial<RollupOrder> = {}) =>
  order({ outcome: "returned", delivered: pkr("0.00"), outcomeTiming: null, ...o });
const open = (o: Partial<RollupOrder> = {}) =>
  order({ outcome: "in_transit", delivered: null, outcomeTiming: null, ...o });

describe("rule #8: delivery rate by order, with still-open beside it", () => {
  it("is delivered ÷ (delivered + returned), and never drops the open count", () => {
    const b = bucketOf("week", [order(), order(), order(), returned(), open(), open()]);
    expect(b.deliveryRate).toEqual({ rate: 0.75, delivered: 3, returned: 1, stillOpen: 2, partial: 0 });
  });

  it("has no rate for a week where nothing is decided yet", () => {
    expect(bucketOf("young", [open(), open()]).deliveryRate.rate).toBeNull();
  });

  it("groups by the order's local day, not the delivery day", () => {
    const late = order({ localDay: "2026-09-20", outcomeTiming: { basis: "happened_on", at: new Date("2026-09-29Z") } });
    expect(rollup([late], byDay)[0]!.key).toBe("2026-09-20");
  });
});

describe("rule #12: cities are canonical or unmapped, never raw spellings", () => {
  it("groups an unmapped spelling as 'unmapped'", () => {
    const keys = rollup([order({ city: "Lahore" }), order({ city: null }), order({ city: null, parcelCount: 0 })], byCity).map((b) => b.key);
    expect(keys.sort()).toEqual(["Lahore", "no city (no Courierify parcel)", "unmapped"]);
  });
});

describe("rules #2 and #4 in a roll-up", () => {
  it("keeps placed, delivered and returned value apart, and currencies apart", () => {
    const b = bucketOf("d", [order(), returned(), order({ currency: "AED", placed: { amount: "50.00", currency: "AED" }, delivered: { amount: "50.00", currency: "AED" } })]);
    expect(b.placed).toEqual([{ amount: "50.00", currency: "AED" }, pkr("2000.00")]);
    expect(b.deliveredRevenue).toEqual([{ amount: "50.00", currency: "AED" }, pkr("1000.00")]);
    expect(b.returnedValue).toEqual([pkr("1000.00")]);
  });
});

describe("profit after returns (rule #15: a named figure, not Financify's net profit)", () => {
  it("subtracts COGS of delivered orders, fees of shipped orders, and ad spend", () => {
    const b = bucketOf("d", [order(), returned()]);
    const p = profitAfterReturns(b, "PKR", [pkr("100.00")]);
    // 1000 revenue − 300 COGS (delivered only) − 400 fees (both shipped) − 100 ads
    expect(p.amount).toBe("200.00");
    expect(p.complete).toBe(true);
  });

  it("says it is incomplete, and why, rather than treating unknowns as zero", () => {
    const b = bucketOf("d", [order({ courierFee: null }), open()]);
    const p = profitAfterReturns(b, "PKR", null);
    expect(p.complete).toBe(false);
    expect(p.missing).toEqual(
      expect.arrayContaining([
        "1 order(s) still open",
        "courier fee unknown on 1 of 2 shipped order(s)",
        "ad spend not available",
      ]),
    );
  });

  it("excludes other currencies instead of converting them (rule #4)", () => {
    const b = bucketOf("d", [order(), order({ placed: { amount: "50.00", currency: "AED" }, delivered: { amount: "50.00", currency: "AED" } })]);
    expect(profitAfterReturns(b, "PKR", [pkr("0.00")]).missing).toContain("orders in AED excluded, not converted");
  });
});

describe("rule #16: ROAS on delivered revenue", () => {
  it("is delivered revenue ÷ ad spend", () => {
    expect(roas(bucketOf("d", [order(), order()]), [pkr("500.00")], "PKR")).toBe(4);
  });
  it("has no ROAS without spend", () => {
    expect(roas(bucketOf("d", [order()]), [], "PKR")).toBeNull();
  });
});

describe("rules #28, #29, #30: products", () => {
  it("keys by variant id, counts units, and rates returns by order", () => {
    const lines = productLines([
      order({ lines: [{ variantId: "v1", productId: "p1", quantity: 2, value: pkr("2000.00"), cost: pkr("600.00") }] }),
      returned({ lines: [{ variantId: "v1", productId: "p1", quantity: 1, value: pkr("1000.00"), cost: pkr("300.00") }] }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ variantId: "v1", units: 3, orders: 2, lineValue: [pkr("3000.00")] });
    expect(lines[0]!.deliveryRate.rate).toBe(0.5);
  });

  it("puts one order in each of its variants' buckets once", () => {
    const o = order({
      lines: [
        { variantId: "v1", productId: "p1", quantity: 1, value: null, cost: null },
        { variantId: "v1", productId: "p1", quantity: 1, value: null, cost: null },
        { variantId: "v2", productId: "p2", quantity: 1, value: null, cost: null },
      ],
    });
    expect(rollup([o], byVariant).map((b) => [b.key, b.orders])).toEqual([["v1", 1], ["v2", 1]]);
  });
});

describe("per-courier timing is gated, never a number from no history", () => {
  it("returns not_enough_data for a courier with no courier-timed deliveries", () => {
    const orders = Array.from({ length: 50 }, () => order({ courier: "tranzo", outcomeTiming: { basis: "status_as_of", at: new Date() } }));
    expect(courierTiming(orders)).toEqual([
      { courier: "tranzo", verdict: "not_enough_data", reason: "no_courier_history", timedOrders: 0 },
    ]);
  });

  it("gives a median once the courier has enough timed deliveries", () => {
    const orders = Array.from({ length: 30 }, () => order({ courier: "tcs" }));
    expect(courierTiming(orders)[0]).toMatchObject({ courier: "tcs", verdict: "ok", medianDaysToDeliver: 3 });
  });
});

describe("ad spend: measured versus allocated", () => {
  const body = {
    dateBasis: "ad_platform_day",
    platformDays: [
      { date: "2026-09-20", platform: "facebook", spend: pkr("24405.44"), fees: pkr("1220.27"), fx: { status: "ok" } },
      { date: "2026-09-20", platform: "tiktok", spend: pkr("7258.36"), fees: pkr("362.92"), fx: { status: "ok" } },
    ],
    campaigns: [{ date: "2026-09-20", platform: "facebook", campaignId: "c1", campaignName: "FV", spend: pkr("3048.45"), fees: pkr("152.42") }],
    campaignCoverage: [{ date: "2026-09-20", platform: "facebook", unassignedToCampaign: pkr("0.00") }],
    products: {
      method: "allocated",
      items: [{ productId: "p1", variantId: "v1", spend: pkr("19682.43"), fees: pkr("984.12") }],
      unattributed: { spend: pkr("11.53"), fees: pkr("0.58"), reasons: { no_evidence: 1 } },
      attributionCoverage: 0.84,
    },
  };

  it("labels platform and campaign rows measured and product rows allocated", () => {
    const { rows } = parseAdSpendDay("2026-09-20", body, "PKR");
    const method = (level: string) => rows.filter((r) => r.level === level).map((r) => r.method);
    expect(method("platform")).toEqual(["measured", "measured"]);
    expect(method("campaign")).toEqual(["measured"]);
    expect(method("product")).toEqual(["allocated"]);
    expect(method("product_unattributed")).toEqual(["allocated"]);
  });

  it("writes a day row with the platform total pre-fee, fees separate", () => {
    const day = parseAdSpendDay("2026-09-20", body, "PKR").rows.find((r) => r.level === "day")!;
    expect(day.spend).toEqual(pkr("31663.80"));
    expect(day.fees).toEqual(pkr("1583.19"));
    expect(day.detail.attributionCoverage).toBe(0.84);
  });

  it("writes a day row even when nothing was spent, so the day counts as fetched", () => {
    const { rows } = parseAdSpendDay("2026-09-21", { dateBasis: "ad_platform_day", platformDays: [], products: null }, "PKR");
    expect(rows).toEqual([expect.objectContaining({ level: "day", spend: pkr("0.00") })]);
  });

  it("keeps a spend Financify could not convert out of the day total and says so (rule #4)", () => {
    const { rows, problems } = parseAdSpendDay(
      "2026-09-20",
      { dateBasis: "ad_platform_day", platformDays: [{ date: "2026-09-20", platform: "snap", spend: { amount: "10.00", currency: "USD" }, fx: { status: "conversion_failed" } }] },
      "PKR",
    );
    expect(rows.find((r) => r.level === "day")!.spend).toEqual(pkr("0.00"));
    expect(rows.find((r) => r.level === "platform")!.fxStatus).toBe("conversion_failed");
    expect(problems[0]).toMatch(/USD, not PKR/);
  });
});
