import { describe, expect, it } from "vitest";

import { dayLabel, outcomeLine, resultCounts, type WatchRow } from "./line";

// Made-up numbers throughout; nothing here comes from a real store.
const w = (o: Partial<WatchRow>): WatchRow => ({
  id: "w1", insightId: "i1", detector: "city_returns", subject: "lahore", trigger: "clicked",
  actedAt: new Date("2026-10-20T08:00:00Z"), internal: false,
  baseline: { finding: { finding: { kind: "city_returns", city: "Lahore" } } },
  effect: null, verdict: "too_early", observed: null, checkpoints: [], judgedAt: null, closedAt: null, closedReason: null, hiddenAt: null,
  ...o,
});
const opts = { timezone: "Asia/Karachi", canSeeMoney: true, currency: "PKR" };
const rate = {
  before: { subject: 39.2, rest: 42.1 }, after: { subject: 21, rest: 31.6 }, progress: { decided: 150, orders: 160 },
  tallies: { after: { subject: { delivered: 120, returned: 32, open: 8, stale: 0 } } },
};

describe("an outcome as a sentence", () => {
  it("labels the day in the store's time", () => {
    expect(dayLabel("2026-10-05")).toBe("5 Oct");
  });
  it("never shows a placebo", () => {
    expect(outcomeLine(w({ trigger: "placebo" }), opts)).toBeNull();
  });
  it("while watching: the progress, no direction", () => {
    expect(outcomeLine(w({ effect: { progress: { decided: 62, orders: 140 } } }), opts)).toMatchObject({
      status: "watching",
      text: "Watching since 20 Oct · 62 of 140 orders decided so far",
    });
    expect(outcomeLine(w({}), opts)!.text).toBe("Watching since 20 Oct");
  });
  it("once measured: before and after against the comparison, never a verdict word", () => {
    const l = outcomeLine(w({ verdict: "improved", judgedAt: new Date(), effect: rate }), opts)!;
    expect(l.status).toBe("measured");
    expect(l.text).toBe("Since you looked at this on 20 Oct, Lahore's return rate went from 39.2% to 21% (the rest of the store: 42.1% → 31.6%), across 152 orders.");
    expect(l.text).not.toMatch(/improv|worse|better/i);
  });
  it("leads with what the store changed when a signal was seen", () => {
    const l = outcomeLine(w({ verdict: "no_change", judgedAt: new Date(), effect: rate, observed: { text: "Lahore went from 40% of orders to 10%" } }), opts)!;
    expect(l.text).toMatch(/^After you opened this on 20 Oct: Lahore went from 40% of orders to 10%\. Since then, Lahore's return rate/);
    expect(l.signal).toBe("Lahore went from 40% of orders to 10%");
  });
  it("shows I1 as a delivery rate", () => {
    const l = outcomeLine(w({ detector: "courier_for_city", subject: "karachi", baseline: { finding: { finding: { city: "Karachi" } } }, verdict: "no_change", judgedAt: new Date(), effect: rate }), opts)!;
    expect(l.text).toContain("Karachi's delivery rate went from 60.8% to 79% (the store's other cities: 57.9% → 68.4%)");
  });
  it("says when there were too few orders", () => {
    expect(outcomeLine(w({ verdict: "not_enough_data", judgedAt: new Date(), effect: { progress: { decided: 12, orders: 14 } } }), opts)!.text).toBe(
      "Since you looked at this on 20 Oct, there were too few orders to measure (12 decided).",
    );
  });
  it("cash held: shows the measured amount paid, only to a viewer who may see money", () => {
    const cash = w({ detector: "cash_held", subject: "orio", effect: { items: 561, resolvedNow: 120 }, checkpoints: [{ day: 7, resolved: 120, total: 561, amount: "412000.00" }] });
    expect(outcomeLine(cash, opts)).toMatchObject({ text: "Watching since 20 Oct · 120 of 561 owed orders paid so far", money: "PKR 412,000 paid" });
    expect(outcomeLine(cash, { ...opts, canSeeMoney: false })!.money).toBeNull();
  });
  it("no money for detectors not approved", () => {
    const r = w({ detector: "returns_not_received", effect: { items: 10, resolvedNow: 4 }, checkpoints: [{ day: 7, resolved: 4, total: 10, amount: "5000.00" }] });
    expect(outcomeLine(r, opts)!.money).toBeNull();
  });
  it("counts in the detector's own unit, shows a signal while watching, and says why a watch can't be measured", () => {
    expect(outcomeLine(w({ detector: "unfollowed_checkouts", effect: { progress: { decided: 2, orders: 9 } } }), opts)!.text).toBe("Watching since 20 Oct · 2 of 9 abandoned checkouts decided so far");
    expect(outcomeLine(w({ detector: "product_loss", effect: { progress: { decided: 3, orders: 5 } }, observed: { text: "ad spend on the product fell to 0 a day" } }), opts)!.text).toBe(
      "Watching since 20 Oct · 3 of 5 orders decided so far · seen since: ad spend on the product fell to 0 a day",
    );
    expect(outcomeLine(w({ detector: "stuck_parcels", effect: { reason: "the watch has no saved orders to follow (its baseline is unavailable)" } }), opts)!.text).toBe(
      "Opened 20 Oct. It can't be measured: the watch has no saved orders to follow (its baseline is unavailable).",
    );
  });
  it("closed and hidden watches say so", () => {
    expect(outcomeLine(w({ closedAt: new Date(), closedReason: "dismissed_wrong" }), opts)!.status).toBe("closed");
    expect(outcomeLine(w({ hiddenAt: new Date() }), opts)!.status).toBe("hidden");
  });
});

describe("results counts", () => {
  it("leave out internal, hidden and closed watches", () => {
    const lines = [
      outcomeLine(w({ id: "a" }), opts)!,
      outcomeLine(w({ id: "b", verdict: "no_change", judgedAt: new Date(), effect: rate, observed: { text: "x" } }), opts)!,
      outcomeLine(w({ id: "c", internal: true }), opts)!,
      outcomeLine(w({ id: "d", hiddenAt: new Date() }), opts)!,
      outcomeLine(w({ id: "e", closedAt: new Date() }), opts)!,
    ];
    expect(resultCounts(lines)).toEqual({ watched: 2, measured: 1, watching: 1, changed: 1, hidden: 1 });
  });
});
