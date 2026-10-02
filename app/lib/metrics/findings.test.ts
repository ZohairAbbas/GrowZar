import { describe, expect, it } from "vitest";

import {
  courierifyStoppedFinding,
  disagreementFinding,
  findings,
  marginFinding,
  matchesFilter,
  parseOrderFilter,
  variantReturnsFinding,
  type FindingsInput,
} from "./findings";
import { bucketOf, profitAfterReturns, type RollupOrder } from "./rollups";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;

function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`,
    localDay: "2026-09-20",
    createdAt: new Date("2026-09-20T06:00:00Z"),
    currency: "PKR",
    placed: pkr("1000.00"),
    delivered: pkr("1000.00"),
    refunded: pkr("0.00"),
    collected: null,
    cogs: pkr("300.00"),
    cogsComplete: true,
    courierFee: null,
    outcome: "delivered",
    outcomeTiming: null,
    financifyOutcome: "delivered",
    parcelCount: 0,
    courier: null,
    fulfilledVia: null,
    city: null,
    lines: [{ variantId: "1", productId: "p1", title: "Plain mug", quantity: 1, value: pkr("1000.00"), cost: pkr("300.00") }],
    confirmation: null,
    customerId: null,
    ...o,
  };
}
const returned = (o: Partial<RollupOrder> = {}) =>
  order({ outcome: "returned", delivered: pkr("0.00"), financifyOutcome: "returned", ...o });
const open = (o: Partial<RollupOrder> = {}) =>
  order({ outcome: "in_transit", delivered: null, financifyOutcome: "in_transit", ...o });
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);
const line = (variantId: string, title: string) => [
  { variantId, productId: `p${variantId}`, title, quantity: 1, value: pkr("1000.00"), cost: pkr("300.00") },
];

function input(rows: RollupOrder[], o: Partial<FindingsInput> = {}): FindingsInput {
  const orders = bucketOf("store", rows);
  const adSpend = "adSpend" in o ? o.adSpend! : [pkr("600.00")];
  return {
    currency: "PKR",
    rows,
    orders,
    profit: profitAfterReturns(orders, "PKR", adSpend),
    adSpend,
    courierify: { connected: true, lastParcelDay: null },
    ...o,
  };
}

describe("card (a): where delivered revenue went, as a ceiling", () => {
  it("subtracts COGS and ads from delivered revenue, and says how much ads took", () => {
    const f = marginFinding(input([order(), order(), returned()]))!;
    expect(f.deliveredRevenue).toEqual(pkr("2000.00"));
    expect(f.cogsDelivered).toEqual(pkr("600.00"));
    expect(f.ceiling).toEqual(pkr("800.00"));
    expect(f.adsShareOfDelivered).toBe(30);
  });

  it("says fees are unknown, and counts open orders as able to raise it, not lower it", () => {
    const rows = [...times(6, () => order()), returned(), open({ placed: pkr("450.00") })];
    const f = marginFinding(input(rows))!;
    expect(f.feesUnknown).toEqual({ orders: 8, shipped: 8 });
    expect(f.stillOpen).toEqual({ orders: 1, placed: pkr("450.00") });
  });

  it("is absent while more than 15% of the period's orders are still open, rather than reading as a loss", () => {
    // 2 of 12 open (16.7%): ads are counted in full, most revenue is not in yet.
    const young = [...times(10, () => order()), open(), open()];
    expect(marginFinding(input(young))).toBeNull();
    expect(marginFinding(input([...young, order(), order()]))).not.toBeNull(); // 2 of 14
  });

  it("is absent without the whole period's ad spend, rather than a figure that leaves ads out", () => {
    expect(marginFinding(input([order()], { adSpend: null }))).toBeNull();
  });

  it("is absent with no delivered revenue", () => {
    expect(marginFinding(input([open(), returned()]))).toBeNull();
  });

  it("names which app decided the outcomes", () => {
    const f = marginFinding(input([order({ parcelCount: 1 }), ...times(6, () => order())]))!;
    expect(f.decidedBy).toEqual({ courierify: 1, financify: 6 });
  });
});

describe("card (b): variants that return far more than the store", () => {
  // Store: 100 decided orders. Mug 30 of 70 decided returned is not enough
  // of a gap to the store; the lamp's 18 of 30 is.
  const rows = [
    ...times(50, () => order({ lines: line("1", "Plain mug") })),
    ...times(20, () => returned({ lines: line("1", "Plain mug") })),
    ...times(12, () => order({ lines: line("2", "Desk lamp") })),
    ...times(18, () => returned({ lines: line("2", "Desk lamp") })),
  ];

  it("flags a variant ≥ 10 points above the store's own return rate, with its sample", () => {
    const f = variantReturnsFinding(input(rows))!;
    expect(f.store).toEqual({ returned: 38, decided: 100, returnRate: 38 });
    expect(f.flagged).toEqual([
      { variantId: "2", title: "Desk lamp", returned: 18, decided: 30, stillOpen: 0, returnRate: 60 },
    ]);
    expect(f.bestSellers.map((v) => v.variantId)).toEqual(["1"]);
  });

  it("does not compare a variant with fewer than 30 decided orders", () => {
    const small = rows.filter((o) => o.lines[0]!.variantId === "1").concat(
      times(5, () => order({ lines: line("3", "Rare vase") })),
      times(24, () => returned({ lines: line("3", "Rare vase") })),
    );
    expect(variantReturnsFinding(input(small))).toBeNull();
  });

  it("leaves international orders out instead of counting them as open", () => {
    const aed = times(40, () => open({ currency: "AED", placed: { amount: "50.00", currency: "AED" }, lines: line("2", "Desk lamp") }));
    const f = variantReturnsFinding(input([...rows, ...aed]))!;
    expect(f.internationalExcluded).toBe(40);
    expect(f.flagged[0]!.stillOpen).toBe(0);
  });

  it("lists exactly the orders it counted when its link is followed", () => {
    const aed = open({ currency: "AED", placed: { amount: "50.00", currency: "AED" }, lines: line("2", "Desk lamp") });
    const all = [...rows, aed];
    const listed = all.filter((o) => matchesFilter(o, { kind: "variant", variantId: "2" }, "PKR"));
    expect(listed).toHaveLength(30);
  });
});

describe("card (c): where Courierify and Financify disagree", () => {
  const viaCourier = (o: Partial<RollupOrder>) => order({ parcelCount: 1, ...o });
  const rows = [
    ...times(3, () => viaCourier({ outcome: "returned", delivered: pkr("0.00"), financifyOutcome: "delivered" })),
    ...times(2, () => viaCourier({ outcome: "shipment_cancelled", delivered: null, financifyOutcome: "returned" })),
    // Not material: both mean "not shipped yet".
    ...times(4, () => viaCourier({ outcome: "booked", delivered: null, financifyOutcome: "not_shipped" })),
    // Not a disagreement Courierify could have: no parcel.
    ...times(4, () => returned({ financifyOutcome: "delivered" })),
    ...times(6, () => viaCourier({})),
  ];

  it("counts only material disagreements on orders both apps know", () => {
    const f = disagreementFinding(input(rows))!;
    expect(f.total).toBe(5);
    expect(f.bothApps).toBe(15);
    expect(f.groups).toEqual([
      { financify: "delivered", courier: "returned", orders: 3, placed: [pkr("3000.00")] },
      { financify: "returned", courier: "shipment_cancelled", orders: 2, placed: [pkr("2000.00")] },
    ]);
  });

  it("stays silent below five", () => {
    expect(disagreementFinding(input(rows.slice(1)))).toBeNull();
  });

  it("lists exactly the orders it counted when its link is followed", () => {
    expect(rows.filter((o) => matchesFilter(o, { kind: "disagree" }, "PKR"))).toHaveLength(5);
  });
});

describe("card (d): the store stopped booking through Courierify", () => {
  const shipped = [...times(3, () => order({ parcelCount: 1 })), ...times(17, () => order())];

  it("says so when under half of shipped orders had a parcel", () => {
    const f = courierifyStoppedFinding(input(shipped, { courierify: { connected: true, lastParcelDay: "2026-09-01" } }))!;
    expect(f).toMatchObject({ lastParcelDay: "2026-09-01", shipped: 20, withParcel: 3 });
  });

  it("says nothing for a store that never used Courierify, or isn't connected to it", () => {
    expect(courierifyStoppedFinding(input(shipped, { courierify: { connected: true, lastParcelDay: null } }))).toBeNull();
    expect(courierifyStoppedFinding(input(shipped, { courierify: { connected: false, lastParcelDay: "2026-09-01" } }))).toBeNull();
  });

  it("needs 20 shipped orders", () => {
    expect(courierifyStoppedFinding(input(shipped.slice(1), { courierify: { connected: true, lastParcelDay: "2026-09-01" } }))).toBeNull();
  });
});

describe("findings(), and the Orders filters behind each link", () => {
  it("returns nothing for an empty period rather than a card of zeros", () => {
    expect(findings(input([]))).toEqual([]);
  });

  it("accepts only filters it can match, and a numeric variant id", () => {
    expect(parseOrderFilter(new URLSearchParams("variant=123"))).toEqual({ kind: "variant", variantId: "123" });
    expect(parseOrderFilter(new URLSearchParams("variant=1;drop"))).toBeNull();
    expect(parseOrderFilter(new URLSearchParams("disagree=1"))).toEqual({ kind: "disagree" });
    expect(parseOrderFilter(new URLSearchParams("decidedBy=financify"))).toEqual({ kind: "decided_by", app: "financify" });
    expect(parseOrderFilter(new URLSearchParams("decidedBy=preventify"))).toBeNull();
  });
});
