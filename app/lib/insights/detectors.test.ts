import { describe, expect, it } from "vitest";

import { parseInsightAction, safeAppPath } from "./actions";
import { rankInsights, runDetectors, withoutMoney, type App, type Insight } from "./detectors";
import type { FindingsInput } from "../metrics/findings";
import { bucketOf, profitAfterReturns, type RollupOrder } from "../metrics/rollups";

// Made-up numbers throughout; nothing here comes from a real store.
const pkr = (amount: string) => ({ amount, currency: "PKR" });
let seq = 0;
function order(o: Partial<RollupOrder> = {}): RollupOrder {
  seq += 1;
  return {
    orderId: `o${seq}`, localDay: "2026-09-20", createdAt: new Date("2026-09-20T06:00:00Z"), currency: "PKR",
    placed: pkr("1000.00"), delivered: pkr("1000.00"), refunded: pkr("0.00"), collected: null, uncollected: null, cogs: pkr("300.00"),
    cogsComplete: true, courierFee: null, outcome: "delivered", outcomeTiming: null, financifyOutcome: "delivered",
    parcelCount: 1, courier: "tcs", fulfilledVia: null, cityRaw: null, city: null, confirmation: null, customerId: null,
    lines: [{ variantId: "1", productId: "p1", title: "Plain mug", quantity: 1, value: pkr("1000.00"), cost: pkr("300.00") }],
    ...o,
  };
}
const times = (k: number, make: () => RollupOrder) => Array.from({ length: k }, make);
const line = (variantId: string) => [{ variantId, productId: `p${variantId}`, title: `Item ${variantId}`, quantity: 1, value: pkr("1000.00"), cost: pkr("300.00") }];
const returned = (o: Partial<RollupOrder> = {}) => order({ outcome: "returned", delivered: pkr("0.00"), financifyOutcome: "returned", ...o });

// A store where two products return far more than the rest, and the apps
// disagree on six orders.
const rows = [
  ...times(80, () => order({ lines: line("1") })),
  ...times(20, () => returned({ lines: line("1") })),
  ...times(12, () => order({ lines: line("2") })),
  ...times(18, () => returned({ lines: line("2") })),
  ...times(15, () => order({ lines: line("3") })),
  ...times(15, () => returned({ lines: line("3") })),
  ...times(6, () => returned({ financifyOutcome: "delivered", lines: line("1") })),
];
function input(r: RollupOrder[] = rows): FindingsInput {
  const orders = bucketOf("s", r);
  const adSpend = [pkr("1000.00")];
  return { currency: "PKR", rows: r, orders, profit: profitAfterReturns(orders, "PKR", adSpend), adSpend, courierify: { connected: true, lastParcelDay: "2026-09-20" } };
}
const both = new Set<App>(["COURIERIFY", "FINANCIFY"]);
const found = (outcomes: ReturnType<typeof runDetectors>) => outcomes.flatMap((o) => (o.status === "found" ? o.insights : []));

describe("detectors: every answer is found, nothing found, not enough data, or locked", () => {
  it("gives one insight per flagged product, with a fingerprint that names it", () => {
    const fps = found(runDetectors(input(), both)).map((i) => i.fingerprint).sort();
    // The made-up store records no courier fee, so I13 fires too.
    expect(fps).toEqual(["margin_ceiling:store", "missing_courier_fees:store", "outcome_disagreement:store", "variant_returns:2", "variant_returns:3"]);
    for (const i of found(runDetectors(input(), both)).filter((x) => x.detector === "variant_returns")) {
      expect(i.finding.kind === "variant_returns" && i.finding.flagged.map((v) => v.variantId)).toEqual([i.subject]);
    }
  });

  it("locks a detector whose app is missing, with what connecting it would show", () => {
    const outcomes = runDetectors(input(), new Set<App>(["FINANCIFY"]));
    expect(outcomes.find((o) => o.detector === "outcome_disagreement")).toMatchObject({ status: "locked", needs: ["COURIERIFY"] });
    expect(outcomes.find((o) => o.detector === "margin_ceiling")).toMatchObject({ status: "found" });
  });

  it("locks I3 without Inventorify, and says it lacks data when Inventorify has sent nothing", () => {
    expect(runDetectors(input(), both).find((o) => o.detector === "stockout")).toMatchObject({ status: "locked", needs: ["INVENTORIFY"] });
    const withInv = runDetectors({ ...input(), inventory: null }, new Set<App>(["COURIERIFY", "FINANCIFY", "INVENTORIFY"]));
    expect(withInv.find((o) => o.detector === "stockout")).toMatchObject({ status: "not_enough_data" });
  });

  it("locks I6 without Retainify, and says it lacks data when Retainify has sent no checkouts", () => {
    expect(runDetectors(input(), both).find((o) => o.detector === "unfollowed_checkouts")).toMatchObject({ status: "locked", needs: ["RETAINIFY"] });
    const withRet = runDetectors({ ...input(), checkouts: null }, new Set<App>(["COURIERIFY", "FINANCIFY", "RETAINIFY"]));
    expect(withRet.find((o) => o.detector === "unfollowed_checkouts")).toMatchObject({ status: "not_enough_data" });
  });

  it("locks I6 on COD forms without Preventify", () => {
    expect(runDetectors(input(), both).find((o) => o.detector === "unfollowed_form_abandonments")).toMatchObject({ status: "locked", needs: ["PREVENTIFY"] });
  });

  it("passes a gate's reason through instead of an empty space", () => {
    const quiet = runDetectors(input(times(40, () => order())), both);
    expect(quiet.find((o) => o.detector === "outcome_disagreement")).toMatchObject({ status: "nothing_found", reason: expect.stringMatching(/0 material/) });
    expect(quiet.find((o) => o.detector === "variant_returns")).toMatchObject({ status: "nothing_found" });
  });
});

describe("ranking: specific findings by orders affected, then store-wide context", () => {
  it("puts more excess returns first, and context last", () => {
    const ranked = rankInsights(found(runDetectors(input(), both))).map((i) => i.fingerprint);
    // Store rate is 59 of 166 = 35.5%, so 30 decided orders "should" bring 11
    // returns. Product 2: 18, so 7 more; disagreements: 6; product 3: 15, 4 more.
    // Context after, by orders: I13's 172 unpriced orders before margin's 107 delivered.
    expect(ranked).toEqual(["variant_returns:2", "outcome_disagreement:store", "variant_returns:3", "missing_courier_fees:store", "margin_ceiling:store"]);
  });

  it("is stable for equal sizes", () => {
    const a = { rank: { group: "specific", ordersAffected: 3 }, fingerprint: "b" } as Insight;
    const b = { rank: { group: "specific", ordersAffected: 3 }, fingerprint: "a" } as Insight;
    expect(rankInsights([a, b]).map((i) => i.fingerprint)).toEqual(["a", "b"]);
  });
});

describe("money only for a role that may see Finance (staff may not)", () => {
  it("drops the money card and blanks placed values, keeping the counts", () => {
    const stripped = withoutMoney(found(runDetectors(input(), both)));
    expect(stripped.map((i) => i.detector)).not.toContain("margin_ceiling");
    const d = stripped.find((i) => i.detector === "outcome_disagreement")!.finding;
    expect(d.kind === "disagreements" && d.groups.every((g) => g.placed.length === 0)).toBe(true);
    expect(d.kind === "disagreements" && d.total).toBe(6);
    expect(JSON.stringify(stripped)).not.toMatch(/"amount"/);
  });

  it("strips I8's and I13's estimates for staff, keeping the cards", () => {
    const cost = { total: pkr("3000.00"), perReturn: pkr("200.00"), returns: 15, pricedReturns: 196 };
    const i8 = { detector: "unconfirmed_returns", subject: "store", fingerprint: "unconfirmed_returns:store", rank: { group: "specific", ordersAffected: 15 }, revealsMoney: true, finding: { kind: "unconfirmed_returns", excessReturns: 15, cost } } as unknown as Insight;
    const i13 = { detector: "missing_courier_fees", subject: "store", fingerprint: "missing_courier_fees:store", rank: { group: "context", ordersAffected: 30 }, revealsMoney: true, finding: { kind: "missing_fees", missing: 30, estimate: { total: pkr("6750.00"), medianFee: pkr("225.00"), pricedOrders: 30 } } } as unknown as Insight;
    const stripped = withoutMoney([i8, i13]);
    expect(stripped.map((i) => i.detector)).toEqual(["unconfirmed_returns", "missing_courier_fees"]);
    expect(JSON.stringify(stripped)).not.toMatch(/"amount"/);
  });

  it("keeps a returns card for staff, without its money estimate", () => {
    const withCost = runDetectors({ ...input(), returnCost: { perReturn: pkr("200.00"), priced: 100, returns: 300 } }, both);
    const insights = found(withCost);
    const products = insights.filter((i) => i.detector === "variant_returns");
    expect(products.every((i) => i.revealsMoney)).toBe(true);
    const stripped = withoutMoney(insights);
    expect(stripped.filter((i) => i.detector === "variant_returns")).toHaveLength(products.length);
    expect(JSON.stringify(stripped)).not.toMatch(/"amount"/);
  });
});

describe("acting on an insight", () => {
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };

  it("needs a known reason to dismiss, and only 7 or 30 days to snooze", () => {
    expect(parseInsightAction(form({ intent: "dismiss", reason: "already_knew", note: " seen it " }))).toEqual({
      intent: "dismiss", reason: "already_knew", note: "seen it",
    });
    expect(parseInsightAction(form({ intent: "dismiss" }))).toBeNull();
    expect(parseInsightAction(form({ intent: "dismiss", reason: "toString" }))).toBeNull();
    expect(parseInsightAction(form({ intent: "snooze", days: "30" }))).toEqual({ intent: "snooze", days: 30 });
    expect(parseInsightAction(form({ intent: "snooze", days: "365" }))).toBeNull();
    expect(parseInsightAction(form({ intent: "delete" }))).toBeNull();
  });

  it("sends a card's link only to a path in this app", () => {
    expect(safeAppPath("/orders?days=30&variant=1")).toBe("/orders?days=30&variant=1");
    for (const bad of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "orders", "", null, "/%5C%5Cevil.example"]) {
      const out = safeAppPath(bad);
      expect(out === null || out.startsWith("/") && !out.startsWith("//")).toBe(true);
    }
    expect(safeAppPath("//evil.example/x")).toBeNull();
    // Passes the prefix checks, but the URL parser drops the tab: "//evil.example".
    expect(safeAppPath("/\t/evil.example/x")).toBeNull();
    expect(safeAppPath("https://evil.example/")).toBeNull();
  });
});
