import { describe, expect, it } from "vitest";

import {
  courierifyStoppedFinding,
  disagreementFinding,
  findings,
  marginFinding,
  matchesFilter,
  missingFeesFinding,
  cashHeldFindings,
  unconfirmedFinding,
  courierCityFindings,
  productLossFindings,
  cityReturnsFindings,
  parseOrderFilter,
  variantReturnsFinding,
  type Finding,
  type FindingsInput,
  type Skip,
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
    collected: null, uncollected: null,
    cogs: pkr("300.00"),
    cogsComplete: true,
    courierFee: null,
    outcome: "delivered",
    outcomeTiming: null,
    financifyOutcome: "delivered",
    parcelCount: 0,
    courier: null,
    fulfilledVia: null,
    cityRaw: null,
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

function found<T extends Finding>(x: T | Skip): T {
  if (x.kind === "skip") throw new Error(`expected a finding, got: ${x.reason}`);
  return x;
}

function found2<T extends Finding>(x: T[] | Skip): T[] {
  if (!Array.isArray(x)) throw new Error(`expected findings, got: ${x.reason}`);
  return x;
}

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
    const f = found(marginFinding(input([order(), order(), returned()])));
    expect(f.deliveredRevenue).toEqual(pkr("2000.00"));
    expect(f.cogsDelivered).toEqual(pkr("600.00"));
    expect(f.ceiling).toEqual(pkr("800.00"));
    expect(f.adsShareOfDelivered).toBe(30);
  });

  it("says fees are unknown, and counts open orders as able to raise it, not lower it", () => {
    const rows = [...times(6, () => order()), returned(), open({ placed: pkr("450.00") })];
    const f = found(marginFinding(input(rows)));
    expect(f.feesUnknown).toEqual({ orders: 8, shipped: 8 });
    expect(f.stillOpen).toEqual({ orders: 1, placed: pkr("450.00") });
  });

  it("is absent while more than 15% of the period's orders are still open, rather than reading as a loss", () => {
    // 2 of 12 open (16.7%): ads are counted in full, most revenue is not in yet.
    const young = [...times(10, () => order()), open(), open()];
    expect(marginFinding(input(young))).toMatchObject({ kind: "skip", status: "not_enough_data" });
    expect(marginFinding(input([...young, order(), order()]))).not.toHaveProperty("kind", "skip"); // 2 of 14
  });

  it("is absent without the whole period's ad spend, rather than a figure that leaves ads out", () => {
    expect(marginFinding(input([order()], { adSpend: null }))).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });

  it("is absent with no delivered revenue", () => {
    expect(marginFinding(input([open(), returned()]))).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });

  it("names which app decided the outcomes", () => {
    const f = found(marginFinding(input([order({ parcelCount: 1 }), ...times(6, () => order())])));
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
    const f = found(variantReturnsFinding(input(rows)));
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
    // The vase (29 decided) is not compared; the mug is, and is not flagged.
    expect(variantReturnsFinding(input(small))).toMatchObject({ kind: "skip", status: "nothing_found", reason: expect.stringMatching(/none of 1 product/) });
    // With no product at 30, it is not enough data rather than "nothing found".
    const tiny = times(29, () => returned({ lines: line("3", "Rare vase") }));
    expect(variantReturnsFinding(input(tiny))).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });

  it("leaves international orders out instead of counting them as open", () => {
    const aed = times(40, () => open({ currency: "AED", placed: { amount: "50.00", currency: "AED" }, lines: line("2", "Desk lamp") }));
    const f = found(variantReturnsFinding(input([...rows, ...aed])));
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
    const f = found(disagreementFinding(input(rows)));
    expect(f.total).toBe(5);
    expect(f.bothApps).toBe(15);
    expect(f.groups).toEqual([
      { financify: "delivered", courier: "returned", orders: 3, placed: [pkr("3000.00")] },
      { financify: "returned", courier: "shipment_cancelled", orders: 2, placed: [pkr("2000.00")] },
    ]);
  });

  it("stays silent below five", () => {
    expect(disagreementFinding(input(rows.slice(1)))).toMatchObject({ kind: "skip", status: "nothing_found" });
  });

  it("lists exactly the orders it counted when its link is followed", () => {
    expect(rows.filter((o) => matchesFilter(o, { kind: "disagree" }, "PKR"))).toHaveLength(5);
  });
});

describe("card (d): the store stopped booking through Courierify", () => {
  const shipped = [...times(3, () => order({ parcelCount: 1 })), ...times(17, () => order())];

  it("says so when under half of shipped orders had a parcel", () => {
    const f = found(courierifyStoppedFinding(input(shipped, { courierify: { connected: true, lastParcelDay: "2026-09-01" } })));
    expect(f).toMatchObject({ lastParcelDay: "2026-09-01", shipped: 20, withParcel: 3 });
  });

  it("says nothing for a store that never used Courierify, or isn't connected to it", () => {
    expect(courierifyStoppedFinding(input(shipped, { courierify: { connected: true, lastParcelDay: null } }))).toMatchObject({ kind: "skip", status: "nothing_found" });
    expect(courierifyStoppedFinding(input(shipped, { courierify: { connected: false, lastParcelDay: "2026-09-01" } }))).toMatchObject({ kind: "skip", status: "nothing_found" });
  });

  it("needs 20 shipped orders", () => {
    expect(courierifyStoppedFinding(input(shipped.slice(1), { courierify: { connected: true, lastParcelDay: "2026-09-01" } }))).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });
});

describe("I13: orders shipped through Courierify with no courier fee recorded", () => {
  const fee = pkr("250.00");
  const via = (o: Partial<RollupOrder>) => order({ parcelCount: 1, courier: "trax", ...o });
  const rows = [
    ...times(20, () => via({})),
    ...times(8, () => via({ fulfilledVia: "orio" })),
    ...times(3, () => via({ courier: "tcs", outcome: "returned", delivered: pkr("0.00") })),
    ...times(10, () => via({ courierFee: fee })),
    // Not shipped: no fee is owed yet.
    ...times(5, () => via({ outcome: "booked", delivered: null })),
    // Outside Courierify: counted, not the finding.
    ...times(7, () => order({ parcelCount: 0 })),
  ];

  it("counts Courierify-booked shipped orders without a fee, by courier, returns included", () => {
    const f = found(missingFeesFinding(input(rows)));
    expect(f).toMatchObject({ missing: 31, viaCourierify: 41, via3pl: 8, outsideCourierify: 7 });
    expect(f.byCourier).toEqual([
      { courier: "trax", missing: 28, shipped: 38 },
      { courier: "tcs", missing: 3, shipped: 3 },
    ]);
  });

  it("stays silent below 25", () => {
    expect(missingFeesFinding(input(rows.slice(7)))).toMatchObject({ kind: "skip", status: "nothing_found" });
  });

  it("does not blame Courierify for orders it never shipped", () => {
    expect(missingFeesFinding(input(times(40, () => order({ parcelCount: 0 }))))).toMatchObject({
      kind: "skip",
      status: "not_enough_data",
      reason: expect.stringMatching(/none of 40 shipped/),
    });
  });

  it("lists exactly the orders it counted when its link is followed", () => {
    expect(rows.filter((o) => matchesFilter(o, { kind: "fee_missing" }, "PKR"))).toHaveLength(31);
  });
});

describe("I4: COD a courier or 3PL has not paid, against its own rhythm", () => {
  const asOf = new Date("2026-10-02T12:00:00Z");
  const delivered = (daysAgo: number, o: Partial<RollupOrder> = {}) =>
    order({
      parcelCount: 1,
      courier: "trax",
      fulfilledVia: "orio",
      uncollected: pkr("5000.00"),
      outcomeTiming: { basis: "status_as_of", at: new Date(asOf.getTime() - daysAgo * 86_400_000) },
      ...o,
    });
  // Orio paid daily until 2026-08-25; TCS weekly until 2026-09-29.
  const orio = { payer: "orio", payouts: 5, lastPaidDay: "2026-08-25", medianGapDays: 1, disputed: 0 };
  const tcs = { payer: "tcs", payouts: 6, lastPaidDay: "2026-09-29", medianGapDays: 7, disputed: 3 };
  const cashInput = (awaiting: RollupOrder[], payers = [orio, tcs]) => input([], { cash: { asOf, payers, awaiting } });

  it("names the payer (the 3PL, not the courier), the COD, and how late it is", () => {
    const [f] = cashHeldFindings(cashInput(times(4, () => delivered(30)))) as Exclude<ReturnType<typeof cashHeldFindings>, { kind: "skip" }>;
    expect(f).toMatchObject({ payer: "orio", orders: 4, cod: [pkr("20000.00")], lastPaidDay: "2026-08-25", medianGapDays: 1, daysLate: 37 });
  });

  it("does not count an order still inside the payer's usual gap plus grace", () => {
    // TCS pays weekly and paid 3 days ago; deliveries 5 days ago are not due.
    const fresh = times(20, () => delivered(5, { courier: "tcs", fulfilledVia: null }));
    expect(cashHeldFindings(cashInput(fresh))).toMatchObject({ kind: "skip", status: "nothing_found" });
    // 9 days: past TCS's 7-day gap but inside the 3-day grace, so not yet due.
    const graced = times(20, () => delivered(9, { courier: "tcs", fulfilledVia: null }));
    expect(cashHeldFindings(cashInput(graced))).toMatchObject({ kind: "skip", status: "nothing_found" });
    expect(cashHeldFindings(cashInput(times(20, () => delivered(11, { courier: "tcs", fulfilledVia: null }))))).toHaveLength(1);
  });

  it("fires on a large amount even when the payer is on time", () => {
    const owed = times(11, () => delivered(15, { courier: "tcs", fulfilledVia: null })); // 55,000 > 50,000
    expect(cashHeldFindings(cashInput(owed))).toEqual([expect.objectContaining({ payer: "tcs", orders: 11, daysLate: 0 })]);
    expect(cashHeldFindings(cashInput(owed.slice(1)))).toMatchObject({ kind: "skip" }); // 50,000 exactly, on time
  });

  it("never calls a parcel with nothing to collect (COD 0.00) unpaid, however late the payer", () => {
    const prepaid = times(8, () => delivered(150, { courier: "tcs", fulfilledVia: null, uncollected: pkr("0.00") }));
    const lateTcs = { ...tcs, lastPaidDay: "2026-07-02" };
    expect(cashHeldFindings(cashInput(prepaid, [orio, lateTcs]))).toMatchObject({ kind: "skip", status: "nothing_found" });
    expect(prepaid.filter((o) => matchesFilter(o, { kind: "awaiting_payout", payer: "tcs" }, "PKR", { payers: [lateTcs], asOf }))).toHaveLength(0);
  });

  it("never judges a payer with too few payouts, and says so", () => {
    const blueex = times(30, () => delivered(60, { courier: "blueex", fulfilledVia: null }));
    expect(cashHeldFindings(cashInput(blueex))).toMatchObject({ kind: "skip", status: "not_enough_data", reason: expect.stringMatching(/blueex/) });
    const both = [...blueex, ...times(2, () => delivered(30))];
    const [f] = cashHeldFindings(cashInput(both)) as Exclude<ReturnType<typeof cashHeldFindings>, { kind: "skip" }>;
    expect(f!.notJudged).toEqual([{ payer: "blueex", orders: 30 }]);
  });

  it("lists exactly the orders it counted when its link is followed", () => {
    const rows = [...times(4, () => delivered(30)), ...times(3, () => delivered(1)), delivered(30, { courier: "tcs", fulfilledVia: null })];
    expect(rows.filter((o) => matchesFilter(o, { kind: "awaiting_payout", payer: "orio" }, "PKR", { payers: [orio, tcs], asOf }))).toHaveLength(4);
  });
});

describe("I8: orders nobody confirmed come back more often", () => {
  const c = (confirmation: string | null, outcome: "delivered" | "returned" | "not_shipped" | "booked" | "in_transit" = "delivered", o: Partial<RollupOrder> = {}) =>
    outcome === "returned" ? returned({ confirmation, ...o })
      : outcome === "delivered" ? order({ confirmation, ...o })
        : order({ confirmation, outcome, delivered: null, ...o });
  // Confirmed: 25 of 100 returned. Unanswered: 40 of 100 (timed out and expired).
  const rows = [
    ...times(75, () => c("confirmed")), ...times(25, () => c("confirmed", "returned")),
    ...times(50, () => c("timed_out")), ...times(30, () => c("timed_out", "returned")),
    ...times(10, () => c("expired")), ...times(10, () => c("expired", "returned")),
    ...times(4, () => c("timed_out", "not_shipped")), ...times(2, () => c("expired", "booked")),
    ...times(3, () => c("timed_out", "in_transit")), // already with the courier: too late to call
    ...times(5, () => c("declined")), ...times(7, () => c("declined", "returned")),
    ...times(30, () => c(null, "returned")), // no record: voice may have confirmed
  ];

  it("compares unanswered with confirmed, by order, and counts the returns beyond the confirmed rate", () => {
    const f = found(unconfirmedFinding(input(rows)));
    expect(f.confirmed).toMatchObject({ decided: 100, returned: 25, returnRate: 25 });
    expect(f.unanswered).toMatchObject({ decided: 100, returned: 40, returnRate: 40 });
    expect(f.excessReturns).toBe(15);
    expect(f.declinedShipped).toMatchObject({ decided: 12, returned: 7 });
    expect(f.noRecord).toBe(30);
  });

  it("counts as waiting only recent unanswered orders not yet with the courier, and links to exactly those", () => {
    const asOf = new Date("2026-09-22T06:00:00Z"); // fixture orders are from 2026-09-20
    const stale = times(5, () => c("timed_out", "not_shipped", { createdAt: new Date("2026-09-01T06:00:00Z") }));
    const all = [...rows, ...stale];
    expect(found(unconfirmedFinding(input(all, { asOf }))).waiting).toBe(6);
    expect(all.filter((o) => matchesFilter(o, { kind: "unanswered_waiting" }, "PKR", { asOf }))).toHaveLength(6);
  });

  it("never counts an order with no confirmation record as unconfirmed", () => {
    const f = found(unconfirmedFinding(input([...rows, ...times(100, () => c(null, "returned"))])));
    expect(f.unanswered.decided).toBe(100);
  });

  it("needs 100 decided orders in each group, and a 5-point gap", () => {
    expect(unconfirmedFinding(input(rows.slice(1)))).toMatchObject({ kind: "skip", status: "not_enough_data" });
    const close = [...times(75, () => c("confirmed")), ...times(25, () => c("confirmed", "returned")),
      ...times(71, () => c("timed_out")), ...times(29, () => c("timed_out", "returned"))]; // 29% vs 25%
    expect(unconfirmedFinding(input(close))).toMatchObject({ kind: "skip", status: "nothing_found" });
  });

  it("leaves international orders out", () => {
    const aed = times(50, () => c("timed_out", "returned", { currency: "AED", placed: { amount: "50.00", currency: "AED" } }));
    expect(found(unconfirmedFinding(input([...rows, ...aed]))).unanswered.decided).toBe(100);
  });
});

describe("I1: a route that delivers better in a city", () => {
  // A route is a courier as booked: directly, or through a 3PL.
  const r = (courier: string, via: string | null, d: number, ret: number, city = "Karachi", day = "2026-08-10") => [
    ...times(d, () => order({ parcelCount: 1, courier, fulfilledVia: via, city, localDay: day })),
    ...times(ret, () => returned({ parcelCount: 1, courier, fulfilledVia: via, city, localDay: day })),
  ];

  it("compares routes, so the same courier booked two ways is two routes", () => {
    const rows = [...r("nk", null, 131, 32), ...r("nk", "orio", 68, 30)]; // 80.4% vs 69.4%
    const [f] = found2(courierCityFindings(input(rows)));
    expect(f!.best).toMatchObject({ courier: "nk", via: "direct", decided: 163, rate: 80.4 });
    expect(f!.worse).toEqual([expect.objectContaining({ courier: "nk", via: "orio", gapPoints: 11, z: expect.any(Number) })]);
    expect(f!.worse[0]!.z).toBeGreaterThanOrEqual(1.96);
  });

  it("says nothing about a gap that could be chance, however wide in points", () => {
    const rows = [...r("nk", null, 131, 32), ...r("trax", "orio", 89, 34)]; // 80.4% vs 72.4%, z about 1.6
    expect(courierCityFindings(input(rows))).toMatchObject({ kind: "skip", status: "nothing_found" });
  });

  it("needs 50 decided orders on each route", () => {
    const rows = [...r("nk", null, 45, 4), ...r("trax", "orio", 25, 24)];
    expect(courierCityFindings(input(rows))).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });

  it("only compares within a city, and ignores orders with no city", () => {
    // Two city-less routes that would differ significantly if they were compared.
    const noCity = [
      ...times(131, () => order({ parcelCount: 1, courier: "nk", city: null })),
      ...times(32, () => returned({ parcelCount: 1, courier: "nk", city: null })),
      ...times(68, () => order({ parcelCount: 1, courier: "nk", fulfilledVia: "orio", city: null })),
      ...times(30, () => returned({ parcelCount: 1, courier: "nk", fulfilledVia: "orio", city: null })),
    ];
    const rows = [...r("nk", null, 131, 32, "Karachi"), ...r("trax", null, 50, 50, "Lahore"), ...noCity];
    expect(courierCityFindings(input(rows))).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });

  it("says when its data ends, and lists exactly a route's orders when its link is followed", () => {
    const rows = [...r("nk", null, 131, 32, "Karachi", "2026-09-01"), ...r("nk", "orio", 68, 30, "Karachi", "2026-08-20")];
    const [f] = found2(courierCityFindings(input(rows)));
    expect(f!.lastDay).toBe("2026-09-01");
    expect(rows.filter((o) => matchesFilter(o, { kind: "city_route", city: "Karachi", courier: "nk", via: "orio" }, "PKR"))).toHaveLength(98);
  });
});

describe("I2: a product that looks profitable but loses money as delivered", () => {
  // Each order: one line worth 4,000 that cost 1,000, so 3,000 a delivered order.
  const lamp = (cost: string | null = "1000.00") => [{ variantId: "9", productId: "p9", title: "Desk lamp", quantity: 1, value: pkr("4000.00"), cost: cost ? pkr(cost) : null }];
  const rows = (d = 12, r = 18, o: Partial<RollupOrder> = {}) => [
    ...times(d, () => order({ lines: lamp(), ...o })),
    ...times(r, () => returned({ lines: lamp(), ...o })),
  ];
  const withAds = (rs: RollupOrder[], ads: string, days = 30) => input(rs, { adByVariant: { "9": [pkr(ads)] }, periodDays: days });

  it("says it loses at least the as-delivered figure, when placed it looked profitable", () => {
    const [f] = found2(productLossFindings(withAds(rows(), "60000.00")));
    expect(f).toMatchObject({
      variantId: "9", title: "Desk lamp", decided: 30, returned: 18, returnRate: 60,
      ifAllDelivered: pkr("30000.00"), ceiling: pkr("-24000.00"), per30Days: pkr("-24000.00"),
    });
  });

  it("says nothing when it would lose money even if every order were delivered (not 'looks profitable')", () => {
    expect(productLossFindings(withAds(rows(), "100000.00"))).toMatchObject({ kind: "skip", status: "nothing_found" });
  });

  it("needs a loss of 15,000 per 30 days", () => {
    expect(productLossFindings(withAds(rows(), "37000.00"))).toMatchObject({ kind: "skip", status: "nothing_found" }); // -1,000
    // Over 60 days the loss is halved per 30 days: 36,000 - 66,000 = -30,000, so exactly -15,000.
    expect(found2(productLossFindings(withAds(rows(), "66000.00", 60)))[0]!.per30Days).toEqual(pkr("-15000.00"));
    expect(productLossFindings(withAds(rows(), "55000.00", 60))).toMatchObject({ kind: "skip" }); // -9,500 per 30 days
  });

  it("does not judge a young period, where ads count in full and revenue has not arrived", () => {
    const young = [...rows(), ...times(10, () => order({ lines: lamp(), outcome: "in_transit", delivered: null }))];
    expect(productLossFindings(withAds(young, "60000.00"))).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });

  it("needs the period's ad spend per product, and 30 decided orders", () => {
    expect(productLossFindings(input(rows()))).toMatchObject({ kind: "skip", status: "not_enough_data" });
    expect(productLossFindings(withAds(rows(11, 18), "60000.00"))).toMatchObject({ kind: "skip", status: "not_enough_data" });
  });

  it("stays one-sided: a delivered line with no cost is not subtracted, and is counted", () => {
    const rs = [...rows(), order({ lines: lamp(null) })];
    const [f] = found2(productLossFindings(withAds(rs, "60000.00")));
    expect(f!.linesWithoutCost).toBe(1);
    expect(f!.ceiling).toEqual(pkr("-20000.00")); // the 4,000 counted, no cost taken off
  });

  it("lists exactly its orders when its link is followed", () => {
    expect(rows().filter((o) => matchesFilter(o, { kind: "variant", variantId: "9" }, "PKR"))).toHaveLength(30);
  });
});

describe("I12: a city whose orders come back far more often than the rest", () => {
  const city = (name: string | null, d: number, r: number) => [
    ...times(d, () => order({ parcelCount: name ? 1 : 0, city: name })),
    ...times(r, () => returned({ parcelCount: name ? 1 : 0, city: name })),
  ];

  it("compares a city with the rest of the store, and says profit is not computed", () => {
    const [f] = found2(cityReturnsFindings(input([...city("Quetta", 50, 50), ...city("Lahore", 160, 40), ...city(null, 80, 20)])));
    expect(f).toMatchObject({ city: "Quetta", decided: 100, returned: 50, returnRate: 50, rest: { decided: 300, returned: 60, returnRate: 20 } });
  });

  it("needs 100 decided orders, 10 points, and a gap unlikely to be chance", () => {
    expect(cityReturnsFindings(input([...city("Quetta", 45, 50), ...city("Lahore", 160, 40)]))).toMatchObject({ kind: "skip", status: "nothing_found" });
    expect(cityReturnsFindings(input([...city("Quetta", 72, 28), ...city("Lahore", 160, 40)]))).toMatchObject({ kind: "skip", status: "nothing_found" });
    expect(cityReturnsFindings(input([...city("Quetta", 40, 40), ...city("Lahore", 40, 10)]))).toMatchObject({ kind: "skip", status: "not_enough_data" });
    // 30% against 20% is 10 points, but against only 40 other orders it could be chance (z about 1.2).
    expect(cityReturnsFindings(input([...city("Quetta", 70, 30), ...city(null, 32, 8)]))).toMatchObject({ kind: "skip", status: "nothing_found" });
  });

  it("lists exactly the city's orders when its link is followed", () => {
    const rs = [...city("Quetta", 50, 50), ...city("Lahore", 160, 40)];
    expect(rs.filter((o) => matchesFilter(o, { kind: "city", city: "Quetta" }, "PKR"))).toHaveLength(100);
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
    expect(parseOrderFilter(new URLSearchParams("feeMissing=1"))).toEqual({ kind: "fee_missing" });
    expect(parseOrderFilter(new URLSearchParams("awaitingPayout=orio"))).toEqual({ kind: "awaiting_payout", payer: "orio" });
    expect(parseOrderFilter(new URLSearchParams("awaitingPayout=a'b"))).toBeNull();
    expect(parseOrderFilter(new URLSearchParams("unanswered=waiting"))).toEqual({ kind: "unanswered_waiting" });
    expect(parseOrderFilter(new URLSearchParams("city=D.I.+Khan&courier=tcs&via=direct"))).toEqual({ kind: "city_route", city: "D.I. Khan", courier: "tcs", via: "direct" });
    expect(parseOrderFilter(new URLSearchParams("city=%3Cscript%3E&courier=tcs&via=direct"))).toBeNull();
    expect(parseOrderFilter(new URLSearchParams("city=Quetta"))).toEqual({ kind: "city", city: "Quetta" });
  });
});
