import { describe, expect, it } from "vitest";

import { checkoutFate, checkoutsView, parseCheckout, parseFormAbandonment, unfollowedCheckoutsFinding, type Checkout, type CheckoutMessage } from "./checkouts";

const NOW = new Date("2026-10-20T00:00:00Z");
const at = (d: string) => new Date(`2026-10-${d}Z`);

const pkr = (amount: string) => ({ amount, currency: "PKR" });

const checkout = (token: string, o: Partial<Checkout> = {}): Checkout => ({
  token, startedAt: at("01T10:00:00"), total: pkr("2400.00"), email: "b@example.test", customerId: "c1", becameOrderAt: null, ...o,
});
const fate = (c: Checkout, messages: CheckoutMessage[] = [], orders: number[] = []) =>
  checkoutFate(c, { messages, orderTimes: new Map([["c1", orders]]), now: NOW });

describe("what happened to a checkout", () => {
  it("is not abandoned when it becomes an order within the hour", () => {
    expect(fate(checkout("t", { becameOrderAt: at("01T10:20:00") })).fate).toBe("converted");
    expect(fate(checkout("t"), [], [at("01T10:50:00").getTime()]).fate).toBe("converted");
  });

  it("is recovered only with a message before the order, within 7 days", () => {
    const msg = { checkoutToken: "t", email: null, customerId: null, sentAt: at("01T12:00:00") };
    expect(fate(checkout("t"), [msg], [at("02T10:00:00").getTime()])).toEqual({ fate: "recovered", followedUp: true });
    // A message after the order did not bring it back.
    expect(fate(checkout("t"), [{ ...msg, sentAt: at("03T10:00:00") }], [at("02T10:00:00").getTime()])).toEqual({ fate: "came_back", followedUp: false });
  });

  it("counts a message to the same buyer by email or customer, not only by checkout", () => {
    const byEmail = { checkoutToken: null, email: "b@example.test", customerId: null, sentAt: at("02T10:00:00") };
    expect(fate(checkout("t"), [byEmail]).followedUp).toBe(true);
    expect(fate(checkout("t"), [{ ...byEmail, email: "other@example.test" }]).followedUp).toBe(false);
  });

  it("is lost after 7 days with no order, and open before that", () => {
    expect(fate(checkout("t")).fate).toBe("lost");
    expect(checkoutFate(checkout("t", { startedAt: at("18T10:00:00") }), { messages: [], orderTimes: new Map(), now: NOW }).fate).toBe("open");
  });
});

describe("checkoutsView and I6", () => {
  const many = (n: number, o: Partial<Checkout> = {}) => Array.from({ length: n }, (_, i) => checkout(`t${i}`, { ...o, customerId: `x${i}`, email: `b${i}@example.test` }));

  it("adds up abandoned, followed-up and recovered checkouts, with their value", () => {
    const v = checkoutsView({
      checkouts: [...many(3), checkout("conv", { becameOrderAt: at("01T10:05:00") })],
      messages: [{ checkoutToken: "t0", email: null, customerId: null, sentAt: at("01T11:00:00") }],
      orderTimes: new Map(),
      journeys: [{ id: "j", name: "Abandoned Cart", kind: "flow", trigger: "cart_abandoned", status: "paused" }],
      lastSentByJourney: new Map([["j", "2026-07-23T17:42:21.773Z"]]),
      now: NOW,
    });
    expect(v).toMatchObject({ started: 4, abandoned: 3, settled: 3, followedUp: 1, notFollowedUp: 2, notFollowedUpValue: [pkr("4800.00")], abandonedValue: [pkr("7200.00")] });
    expect(v.cartJourneys).toEqual([{ name: "Abandoned Cart", status: "paused", lastSent: "2026-07-23T17:42:21.773Z" }]);
  });

  it("speaks when half or more of 20+ settled checkouts got no message, naming a paused cart journey", () => {
    const base = { messages: [], orderTimes: new Map(), lastSentByJourney: new Map([["j", "2026-07-23T17:42:21.773Z"]]), now: NOW };
    const paused = [{ id: "j", name: "Abandoned Cart", kind: "flow" as const, trigger: "cart_abandoned", status: "paused" }];
    const f = unfollowedCheckoutsFinding(checkoutsView({ ...base, checkouts: many(25), journeys: paused }));
    expect(f).toMatchObject({ kind: "unfollowed_checkouts", settled: 25, notFollowedUp: 25, pausedJourney: { name: "Abandoned Cart", status: "paused" } });
    expect(unfollowedCheckoutsFinding(checkoutsView({ ...base, checkouts: many(10), journeys: paused }))).toMatchObject({ status: "not_enough_data" });
    expect(unfollowedCheckoutsFinding(null)).toMatchObject({ status: "not_enough_data" });
  });
});

describe("parseCheckout", () => {
  it("reads Retainify's row, lowercasing the email and keeping the phone apart", () => {
    expect(
      parseCheckout({ checkoutToken: "tok", abandonedAt: "2026-10-01T10:00:00.000Z", total: { amount: "2400.00", currency: "PKR" }, buyer: { email: "B@Example.TEST", phone: null, phoneRaw: "0300 1234567" }, recoveredAt: null }),
    ).toMatchObject({ token: "tok", email: "b@example.test", total: pkr("2400.00"), phoneRaw: "0300 1234567", becameOrderAt: null });
    expect(parseCheckout({ checkoutToken: "tok" })).toBeNull();
  });
});


describe("COD-form abandonments (Preventify)", () => {
  it("reads Preventify's row as a checkout, with no email and its session's order as becoming an order", () => {
    expect(
      parseFormAbandonment({ id: "ab1", sessionId: "s", abandonedAt: "2026-10-01T10:00:00.000Z", total: { amount: "1500.00", currency: "AED" }, phone: "+971501234567", phoneRaw: "0501234567", hasEmail: true, recovered: true, recoveredAt: "2026-10-01T12:00:00.000Z" }),
    ).toMatchObject({ token: "ab1", email: null, total: { amount: "1500.00", currency: "AED" }, phoneE164: "+971501234567", becameOrderAt: new Date("2026-10-01T12:00:00.000Z") });
  });

  it("never blames a COD-form abandonment on Retainify's cart journey, and says when Retainify is not connected", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ token: `f${i}`, startedAt: new Date("2026-10-01T10:00:00Z"), total: null, email: null, customerId: `x${i}`, becameOrderAt: null }));
    const v = checkoutsView({
      checkouts: many, messages: [], orderTimes: new Map(),
      journeys: [{ id: "j", name: "Abandoned Cart", kind: "flow", trigger: "cart_abandoned", status: "paused" }],
      lastSentByJourney: new Map(), now: new Date("2026-10-20T00:00:00Z"),
    });
    expect(unfollowedCheckoutsFinding(v, "cod_form", false)).toMatchObject({ source: "cod_form", retainifyConnected: false, pausedJourney: null, notFollowedUp: 25 });
    expect(unfollowedCheckoutsFinding(null, "cod_form", false)).toMatchObject({ status: "not_enough_data", reason: expect.stringMatching(/Preventify/) });
  });
});
