import { describe, expect, it } from "vitest";

import { bandOrders, buyerHistoryView, returnersFinding, type HistoryOrder } from "./buyer-history";

const day = (d: number) => new Date(Date.UTC(2026, 6, 1) + d * 86_400_000);
const o = (id: string, customerId: string, placed: number, outcome: string, decidedOn: number | null): HistoryOrder => ({
  orderId: id, customerId, createdAt: day(placed), outcome, outcomeAt: decidedOn === null ? null : day(decidedOn),
});

describe("banding an order by the buyer's earlier history with the store", () => {
  it("uses only outcomes known before the order was placed", () => {
    const b = bandOrders([o("a1", "c", 0, "returned", 10), o("a2", "c", 5, "delivered", 8), o("a3", "c", 12, "delivered", 15)]);
    // a2 was placed before a1 came back: a1's return is hindsight for it.
    expect([b.get("a1"), b.get("a2"), b.get("a3")]).toEqual(["first", "first", "returned_before"]);
  });

  it("calls a buyer whose earlier orders were all delivered 'delivered before'", () => {
    expect(bandOrders([o("a1", "c", 0, "delivered", 3), o("a2", "c", 5, "returned", 9)]).get("a2")).toBe("delivered_before");
  });
});

describe("I5 per store", () => {
  /** `n` buyers each with one earlier return, then an order that is returned `ret` times out of `n`; plus `m` first orders, `mret` returned. */
  function store(n: number, ret: number, m: number, mret: number) {
    const history: HistoryOrder[] = [];
    for (let i = 0; i < n; i++) {
      history.push(o(`r${i}`, `rb${i}`, 0, "returned", 5));
      history.push(o(`p${i}`, `rb${i}`, 20, i < ret ? "returned" : "delivered", 25));
    }
    for (let i = 0; i < m; i++) history.push(o(`f${i}`, `fb${i}`, 20, i < mret ? "returned" : "delivered", 25));
    const periodOrderIds = new Set(history.filter((h) => h.createdAt.getTime() === day(20).getTime()).map((h) => h.orderId));
    return buyerHistoryView({ history, periodOrderIds, otpEnabled: false });
  }

  it("flags buyers who returned before when they come back clearly more often", () => {
    const f = returnersFinding(store(40, 24, 200, 50));
    expect(f).toMatchObject({ kind: "returners", decided: 40, rate: 60, restRate: 25, gapPoints: 35, otpEnabled: false });
  });

  it("needs 30 decided orders from them, and a clear gap", () => {
    expect(returnersFinding(store(20, 12, 200, 50))).toMatchObject({ status: "not_enough_data" });
    expect(returnersFinding(store(40, 11, 200, 50))).toMatchObject({ status: "nothing_found" });
  });

  it("says what share of returns came from those buyers", () => {
    expect(store(10, 5, 10, 5).returnsFromReturners).toBe(50);
  });

  it("says how much of the period's orders came through Preventify's form, which is all OTP can reach", () => {
    const v = buyerHistoryView({ history: [o("a", "c", 1, "delivered", 2), o("b", "d", 1, "delivered", 2)], periodOrderIds: new Set(["a", "b"]), otpEnabled: false, formOrderIds: new Set(["a"]) });
    expect(v.formShare).toBe(50);
    expect(buyerHistoryView({ history: [], periodOrderIds: new Set(["a"]), otpEnabled: null }).formShare).toBeNull();
  });
});
