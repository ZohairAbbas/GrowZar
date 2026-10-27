import { describe, expect, it } from "vitest";

import { cashFeedbackInputs, monthEndFeedbackInputs } from "../forecast/plan-form";
import type { CashForecast } from "../forecast/cash";
import type { MonthEnd } from "../forecast/month-end";
import { KINDS_FOR, parseFeedback } from "./product-feedback";

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};

describe("the 'this looks wrong' form", () => {
  it("reads the tool, what looks wrong, the note and the figures shown", () => {
    const inputs = { asOf: "2026-10-27T09:00:00Z", weeks: [{ from: "2026-10-27", due: { low: 1, likely: 2, high: 3 } }] };
    expect(parseFeedback(form({ tool: "cash_forecast", kind: "wrong_date", storeId: "s1", note: "  Leopards paid on Friday ", inputs: JSON.stringify(inputs) }))).toEqual({
      tool: "cash_forecast", kind: "wrong_date", storeId: "s1", note: "Leopards paid on Friday", subject: null, inputs,
    });
  });

  it("offers each tool its own choices", () => {
    expect(KINDS_FOR.month_end).toEqual(["wrong_amount", "wrong_date", "not_my_store", "other"]);
    expect(KINDS_FOR.return_risk).toEqual(["wrong_band", "not_my_store", "other"]);
    expect(parseFeedback(form({ tool: "return_risk", kind: "wrong_amount", storeId: "s1", subject: "o1", inputs: "{}" }))).toEqual({ error: "Choose what looks wrong." });
  });

  it("needs the order for a return-risk band", () => {
    expect(parseFeedback(form({ tool: "return_risk", kind: "wrong_band", storeId: "s1", inputs: "{}" }))).toEqual({ error: "Which order?" });
    expect(parseFeedback(form({ tool: "return_risk", kind: "wrong_band", storeId: "s1", subject: "o1", inputs: '{"band":"high"}' }))).toMatchObject({ subject: "o1", inputs: { band: "high" } });
  });

  it("refuses what it can't read rather than guess", () => {
    expect(parseFeedback(form({ tool: "simulator", kind: "other", storeId: "s1", inputs: "{}" }))).toEqual({ error: "Unknown tool." });
    expect(parseFeedback(form({ tool: "month_end", kind: "other", storeId: "", inputs: "{}" }))).toEqual({ error: "Unknown store." });
    expect(parseFeedback(form({ tool: "month_end", kind: "other", storeId: "s1", inputs: "not json" }))).toEqual({ error: "The figures shown could not be read." });
    expect(parseFeedback(form({ tool: "month_end", kind: "other", storeId: "s1", inputs: "[1]" }))).toEqual({ error: "The figures shown could not be read." });
    expect(parseFeedback(form({ tool: "month_end", kind: "other", storeId: "s1", inputs: JSON.stringify({ x: "y".repeat(20_000) }) }))).toEqual({ error: "Too much to send." });
  });
});

describe("the figures sent with it", () => {
  const R = (x: number) => ({ low: x * 0.8, likely: x, high: x * 1.2 });
  const month = (m: string, money: boolean): MonthEnd => ({
    month: m, daysInMonth: 31, daysElapsed: 27, currency: "PKR", orders: { soFar: 300, toCome: R(40), total: R(340.4) },
    deliveredRevenue: money ? R(900_000) : null, profit: money ? R(120_000) : null, adSpend: money ? { soFar: 1, projected: 2 } : null, unresolvedAtMonthEnd: 0.2, trend: 1, notes: [],
  }) as MonthEnd;

  it("carries no money for a viewer without finance:view", () => {
    // As the loader hands the month to such a viewer: money already null.
    const out = monthEndFeedbackInputs({ current: month("2026-10", false), previous: month("2026-09", false) }, false);
    expect(out).toEqual({
      day: 27, daysInMonth: 31, ordersSoFar: 300, currency: null,
      current: { month: "2026-10", orders: { low: 272, likely: 340, high: 408 } },
      previous: { month: "2026-09", orders: { low: 272, likely: 340, high: 408 } },
    });
    // Even if money reached it, it would not be sent.
    expect(JSON.stringify(monthEndFeedbackInputs({ current: month("2026-10", true), previous: month("2026-09", true) }, false))).not.toMatch(/900000|120000|Revenue|profit/);
  });

  it("keeps the money a finance viewer saw, rounded as shown", () => {
    const out = monthEndFeedbackInputs({ current: month("2026-10", true), previous: month("2026-09", true) }, true);
    expect(out.current).toMatchObject({ deliveredRevenue: { low: 720_000, likely: 900_000, high: 1_080_000 }, profit: { likely: 120_000 } });
    expect(out.currency).toBe("PKR");
  });

  it("keeps the cash forecast's weeks, with paid out only where a cycle is timed", () => {
    const cash = {
      asOf: "2026-10-27T09:00:00Z", currency: "PKR",
      weeks: [{ from: "2026-10-27", to: "2026-11-02" }],
      due: { byPayer: [{}], weeks: [R(50_000.4)], total: R(50_000) },
      paid: { byPayer: [], weeks: [R(0)], total: R(0) },
      untimed: [{ payer: "smartlane", deliveredUnpaid: 120_000.6, expected: R(40_000), reason: "x", basis: "unknown", deliveredParcels: 3 }],
      overdue: [], notTracked: { orders: 2, expected: R(1000) },
    } as unknown as CashForecast;
    expect(cashFeedbackInputs(cash)).toEqual({
      asOf: "2026-10-27T09:00:00Z", currency: "PKR",
      weeks: [{ from: "2026-10-27", to: "2026-11-02", due: { low: 40_000, likely: 50_000, high: 60_000 }, paid: null }],
      untimed: [{ payer: "smartlane", deliveredUnpaid: 120_001, expected: { low: 32_000, likely: 40_000, high: 48_000 } }],
      overdue: [], notTracked: { orders: 2, expected: { low: 800, likely: 1000, high: 1200 } },
    });
  });
});
