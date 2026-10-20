import { describe, expect, it } from "vitest";

import type { RollupOrder } from "../metrics/rollups";
import { matchesFilter, orderFilterQuery, parseOrderFilter } from "../metrics/findings";
import {
  backtestRisk, bandOf, categoriesOf, fitCuts, MIN_STORE, reasonsOf, RiskState, riskPass, scoreOf, shuffled, type RiskOrder,
} from "./return-risk";
import { rng } from "./stats";

// Made-up orders.
const DAY = 86_400_000;
const T0 = Date.parse("2026-06-01T00:00:00Z");
let seq = 0;
const order = (o: Partial<RiskOrder> = {}): RiskOrder => {
  const createdAt = o.createdAt ?? new Date(T0 + seq * 3_600_000);
  seq += 1;
  return {
    orderId: `o${seq}`, createdAt, knownAt: new Date(createdAt.getTime() + 5 * DAY), returned: false, customerId: null,
    courier: "trax", city: "Lahore", products: [{ id: "p1", title: "Lawn suit" }], confirmation: "confirmed", payment: "cod", offerTaken: null, network: null,
    ...o,
  };
};

describe("categories", () => {
  it("knows a first order from a repeat, and uses the city alone before a courier is booked", () => {
    const state = new RiskState();
    const cats = (o: RiskOrder) => Object.fromEntries(categoriesOf(o, state).map((c) => [c.signal, c.key]));
    expect(cats(order({ customerId: "c1", courier: null }))).toMatchObject({ buyer: "c1", repeat: "first", route: "city|Lahore", confirmation: "confirmed", payment: "cod" });
    state.placements.set("c1", 1);
    expect(cats(order({ customerId: "c1" }))).toMatchObject({ repeat: "repeat", route: "trax|Lahore" });
    // No Preventify, no buyer, no network answer: those signals are absent, not "no".
    expect(Object.keys(cats(order()))).toEqual(["route", "product", "confirmation", "payment"]);
  });
});

describe("the pass", () => {
  it("scores nothing until the store has enough decided orders", () => {
    const state = new RiskState();
    state.store = { n: MIN_STORE - 1, r: 30 };
    expect(scoreOf(categoriesOf(order(), state), state)).toBeNull();
  });

  it("scores an order only from outcomes known before it was placed", () => {
    // 150 confirmed orders all delivered, then declined ones that all come back, known 5 days after each.
    const early = Array.from({ length: 150 }, (_, i) => order({ createdAt: new Date(T0 - 60 * DAY + i * 3_600_000) }));
    const declined = Array.from({ length: 60 }, () => order({ confirmation: "declined", returned: true }));
    const late = order({ confirmation: "declined", createdAt: new Date(declined[0]!.createdAt.getTime() + DAY) });
    const pass = riskPass([...early, ...declined, late], new Date(T0 + 100 * DAY));
    // A day after the first declined order, none of their returns was known yet: no declined history.
    expect(pass.atPlacement.get(late.orderId)!.contributions.find((c) => c.signal === "confirmation")).toBeUndefined();
    const after = riskPass([...early, ...declined, late], new Date(T0 + 100 * DAY)).state;
    // Once known, every declined order counts, the late one (delivered) too.
    expect(after.get("confirmation", "declined")).toEqual({ n: 61, r: 60 });
  });

  it("shrinks a thin category toward the store, and takes the riskiest product, not the sum", () => {
    const state = new RiskState();
    state.store = { n: 1000, r: 250 };
    state.counts.set("product:a", { n: 2, r: 2 });
    state.counts.set("product:b", { n: 200, r: 150 });
    state.counts.set("product:c", { n: 200, r: 120 });
    const s = scoreOf([{ signal: "product", key: "a", label: "A" }, { signal: "product", key: "b", label: "B" }, { signal: "product", key: "c", label: "C" }], state)!;
    expect(s.contributions).toHaveLength(1);
    expect(s.contributions[0]).toMatchObject({ key: "b" });
    const thin = scoreOf([{ signal: "product", key: "a", label: "A" }], state)!;
    // Two of two came back, but two orders weigh little against 30 of the store's.
    expect(thin.contributions[0]!.value).toBeLessThan(0.3);
  });
});

describe("bands", () => {
  it("cuts the largest top slice at twice the store's odds, and the bottom at half", () => {
    // 100 orders at 80% returned on top, 200 at 35%, 100 at 5% at the bottom; the store at 39%.
    const scored = [
      ...Array.from({ length: 100 }, (_, i) => ({ score: 3, returned: i < 80 })),
      ...Array.from({ length: 200 }, (_, i) => ({ score: 1, returned: i < 70 })),
      ...Array.from({ length: 100 }, (_, i) => ({ score: -1, returned: i < 5 })),
    ];
    const cuts = fitCuts(scored);
    expect(cuts).toMatchObject({ high: 3, low: -1, orders: 400 });
    expect([bandOf(3.5, cuts), bandOf(1, cuts), bandOf(-2, cuts)]).toEqual(["high", "medium", "low"]);
  });

  it("draws no band when no slice of 30 reaches it", () => {
    expect(fitCuts(Array.from({ length: 100 }, (_, i) => ({ score: i, returned: i % 4 === 0 })))).toMatchObject({ high: null, low: null });
  });
});

describe("reasons", () => {
  const scored = (signal: "network" | "route" | "buyer", value: number) => ({
    score: 0, storeRate: 0.25, contributions: [{ signal, key: "k", label: signal === "network" ? "Courierify's network rates this buyer high" : "Quetta by trax", value, n: 40, r: 20 }],
  });

  it("gives network figures exactly when they span two or more other stores (D-53)", () => {
    expect(reasonsOf(scored("network", 1), "high", { level: "high", otherStores: 3, orders: 50, returned: 10 })).toEqual([
      "Courierify's network rates this buyer high: 40 of 50 delivered network-wide (80%)",
    ]);
    expect(reasonsOf(scored("network", 1), "high", { level: "high", otherStores: 1, orders: null, returned: null })).toEqual(["Courierify's network rates this buyer high (from 1 other store)"]);
  });

  it("says a route's rate against the store's, and gives no reason for a small pull", () => {
    expect(reasonsOf(scored("route", 0.6), "high")).toEqual(["Quetta by trax: 50% of 40 came back (store 25%)"]);
    expect(reasonsOf(scored("route", 0.05), "high")).toEqual([]);
    expect(reasonsOf(scored("buyer", -0.8), "low")).toEqual(["this buyer returned 20 of 40 earlier orders"]);
  });
});

describe("backtest", () => {
  // 600 orders a day apart in hours: undeclined 15% returned, declined 70%.
  const history = () => {
    const next = rng(5);
    return Array.from({ length: 800 }, (_, i) => {
      const declined = next() < 0.2;
      return order({ createdAt: new Date(T0 + i * 4 * 3_600_000), confirmation: declined ? "declined" : "confirmed", returned: next() < (declined ? 0.7 : 0.15) });
    });
  };

  it("finds the high band out of sample, and the placebo finds nothing", () => {
    const orders = history();
    const end = new Date(T0 + 200 * DAY);
    const real = backtestRisk(orders, end);
    const high = real.test.bands.find((b) => b.band === "high")!;
    expect(high.orders).toBeGreaterThan(30);
    expect(high.rate).toBeGreaterThan(2 * real.test.storeRate);
    const placebo = backtestRisk(shuffled(orders, rng(11)), end);
    expect(placebo.fit.cuts.high).toBeNull();
  });
});

describe("the Orders filter", () => {
  it("is ?risk=high, and matches only high-risk orders not yet with the courier, from the last 30 days", () => {
    const f = parseOrderFilter(new URLSearchParams("risk=high"))!;
    expect(f).toEqual({ kind: "risk_high" });
    expect(orderFilterQuery(f)).toBe("risk=high");
    const asOf = new Date("2026-10-20T00:00:00Z");
    const o = (orderId: string, outcome: string, daysAgo: number) => ({ orderId, outcome, createdAt: new Date(asOf.getTime() - daysAgo * DAY) }) as RollupOrder;
    const ctx = { asOf, returnRisk: new Set(["a", "b", "c", "d"]) };
    expect(["a", "b", "c", "d", "e"].map((id, i) => matchesFilter(o(id, ["booked", "not_shipped", "in_transit", "booked", "booked"][i]!, i === 3 ? 40 : 2), f, "PKR", ctx))).toEqual([
      true, true, false, false, false,
    ]);
  });
});
