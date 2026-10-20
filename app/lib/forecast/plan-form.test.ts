import { describe, expect, it } from "vitest";

import { admin, manager, owner, staff } from "../permissions";
import { parseSimRequest, withoutMoney } from "./plan-form";
import type { Plan } from "./simulator/types";

const form = (entries: Array<[string, string]>) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe("the simulator form", () => {
  it("reads a budget, days, what to include, and the merchant's lags and lead times", () => {
    const got = parseSimRequest(
      form([["budget", "100,000"], ["horizon", "30"], ["ads", "on"], ["buffer", "on"], ["exclude", "snapchat"], ["keep", "v1"], ["lead:v1", "10"], ["lead:v2", ""], ["lag:orio", "9"], ["minBuffer", "5000"]]),
    );
    expect(got).toEqual({
      request: {
        budget: 100_000, horizonDays: 30, include: { ads: true, stock: false, buffer: true }, keepInStock: ["v1"], minBuffer: 5000,
        excludePlatforms: ["snapchat"], leadTimes: { v1: 10 }, payoutLags: { orio: 9 },
      },
    });
  });

  it("says what is wrong rather than guess", () => {
    expect(parseSimRequest(form([["budget", "0"], ["ads", "on"]]))).toEqual({ error: "Enter a budget above zero." });
    expect(parseSimRequest(form([["budget", "1000"], ["horizon", "90"], ["ads", "on"]]))).toMatchObject({ error: expect.stringContaining("7 to 60") });
    expect(parseSimRequest(form([["budget", "1000"]]))).toEqual({ error: "Pick at least one of ads, stock and a cash buffer." });
    expect(parseSimRequest(form([["budget", "1000"], ["ads", "on"], ["minBuffer", "2000"]]))).toMatchObject({ error: expect.stringContaining("buffer") });
  });
});

describe("a plan for a viewer without finance:view", () => {
  it("keeps orders and dates, and takes every amount out", () => {
    const r = { low: 1, likely: 2, high: 3 };
    const plan: Plan = {
      status: "plan", asOf: "2026-10-20", currency: "PKR",
      request: { budget: 100_000, horizonDays: 30, include: { ads: true, stock: false, buffer: true }, keepInStock: [], minBuffer: 5000, excludePlatforms: [], leadTimes: {}, payoutLags: {} },
      lines: [{ kind: "campaign", key: "a", label: "Campaign A", platform: "facebook", amount: 20_000, buys: "700 a day", deliveredOrders: r, profit: r, cashBackBy: "2026-12-06", products: [], notes: ["note with 20,000"] }],
      totals: { allocated: 20_000, kept: 80_000, deliveredOrders: r, profit: r, cashBackBy: "2026-12-06" },
      assumptions: ["Rests on 135,000 of spend"],
      leftOut: ["80,000 kept as cash", "stock: left out of this plan"],
    };
    const out = withoutMoney(plan);
    expect(JSON.stringify(out)).not.toMatch(/20000|80000|135,000|20,000|100000/);
    if (out.status !== "plan") throw new Error();
    expect(out.lines[0]).toMatchObject({ deliveredOrders: r, cashBackBy: "2026-12-06" });
    expect(out.leftOut).toEqual(["stock: left out of this plan"]);
  });
});

describe("who sees Plan by default (P11-13)", () => {
  it("is owner, admin and manager; not staff", () => {
    const can = (role: { authorize: (r: Record<string, string[]>) => { success: boolean } }) => role.authorize({ plan: ["view"] }).success;
    expect([owner, admin, manager, staff].map(can)).toEqual([true, true, true, false]);
  });
});
