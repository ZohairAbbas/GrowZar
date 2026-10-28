import { describe, expect, it } from "vitest";

import type { Insight } from "../insights/detectors";
import type { CashHeldFinding, UnconfirmedFinding } from "../metrics/findings";
import {
  booksPush,
  DAILY_CAP,
  digestPush,
  findingCandidates,
  findingKey,
  inSendingHours,
  isWeeklyTime,
  modeFor,
  pickForNow,
  subscriptionOutcome,
  switchVisible,
  type Candidate,
  type StoreFindings,
} from "./rules";

// Made-up numbers; nothing here comes from a real store.
const cash: CashHeldFinding = {
  kind: "cash_held", payer: "tcs", orders: 40, cod: [{ amount: "120000.00", currency: "PKR" }], oldestDay: "2026-09-20",
  lastPaidDay: "2026-10-10", medianGapDays: 7, dueAfterDays: 10, daysLate: 12, disputed: 0, asOf: "2026-10-28",
  byUpload: false, notJudged: [], filter: { kind: "awaiting_payout", payer: "tcs" },
};
const group = (orders: number, returned: number) => ({ orders, returned, decided: orders, returnRate: (returned / orders) * 100 });
const unconfirmed = {
  kind: "unconfirmed_returns", confirmed: group(200, 20), unanswered: group(100, 30), declinedShipped: null, waiting: 4, excessReturns: 20,
  cost: { total: { amount: "9000.00", currency: "PKR" }, perReturn: { amount: "450.00", currency: "PKR" }, returns: 20, pricedReturns: 20 },
  noRecord: 0, decidedBy: "courierify", filter: { kind: "unconfirmed" },
} as unknown as UnconfirmedFinding;

const insight = (detector: string, finding: unknown, ordersAffected: number, group: "specific" | "context" = "specific"): Insight =>
  ({ detector, subject: "store", fingerprint: `${detector}:store`, rank: { group, ordersAffected }, revealsMoney: true, finding }) as Insight;

const seen = new Date("2026-10-27T05:00:00Z");
const store = (visible: StoreFindings["visible"], storeName: string | null = null): StoreFindings => ({
  storeId: "s1",
  storeName,
  visible,
  appearedAt: new Map(visible.map((v) => [v.id, seen])),
  period: "days=30",
});
const owner = { memberId: "m1", canSeeMoney: true };
const staff = { memberId: "m2", canSeeMoney: false };
const none = () => false;

describe("who gets a real push", () => {
  it("is everyone when sending is on, internal accounts only when internal, nobody when off", () => {
    expect([modeFor("on", false), modeFor("on", true)]).toEqual(["live", "live"]);
    expect([modeFor("internal", true), modeFor("internal", false)]).toEqual(["live", "dry_run"]);
    expect([modeFor("off", true), modeFor("off", false)]).toEqual(["dry_run", "dry_run"]);
  });
  it("shows the switch to internal accounts until sending is on, and never without keys", () => {
    expect(switchVisible("internal", false, true)).toBe(false);
    expect(switchVisible("off", false, true)).toBe(false);
    expect(switchVisible("internal", true, true)).toBe(true);
    expect(switchVisible("on", false, true)).toBe(true);
    expect(switchVisible("on", true, false)).toBe(false);
  });
});

describe("quiet hours and the weekly slot", () => {
  it("sends from 08:00 up to 22:00 only", () => {
    expect([7, 8, 13, 21, 22, 23, 0].map(inSendingHours)).toEqual([false, true, true, true, false, false, false]);
  });
  it("puts Books and the digest on Monday from 09:00", () => {
    expect(isWeeklyTime({ weekday: 1, hour: 8 })).toBe(false);
    expect(isWeeklyTime({ weekday: 1, hour: 9 })).toBe(true);
    expect(isWeeklyTime({ weekday: 2, hour: 9 })).toBe(false);
  });
});

describe("the daily cap", () => {
  const c = (kind: Candidate["kind"], priority: number): Candidate => ({ kind, priority, title: kind, body: "", url: "/", dedupeKey: kind, storeId: null, insightId: null });
  const all = [c("digest", 4), c("books", 3), c("top_finding", 2), c("cash_held", 1)];
  it("keeps the two that matter most: late payout, then the top finding", () => {
    expect(DAILY_CAP).toBe(2);
    expect(pickForNow(all, 0).map((x) => x.kind)).toEqual(["cash_held", "top_finding"]);
  });
  it("counts what already went today", () => {
    expect(pickForNow(all, 1).map((x) => x.kind)).toEqual(["cash_held"]);
    expect(pickForNow(all, 2)).toEqual([]);
    expect(pickForNow(all, 5)).toEqual([]);
  });
});

describe("what a push service's answer means", () => {
  it("deletes the subscription on 404 and 410 only", () => {
    expect(subscriptionOutcome(201)).toBe("delivered");
    expect(subscriptionOutcome(404)).toBe("gone");
    expect(subscriptionOutcome(410)).toBe("gone");
    expect(subscriptionOutcome(429)).toBe("failed");
    expect(subscriptionOutcome(500)).toBe("failed");
    expect(subscriptionOutcome(undefined)).toBe("failed");
  });
});

describe("a store's findings, for one member", () => {
  // Ranked, as Home hands them over: more orders first, so unconfirmed returns is the top row.
  const visible = [
    { id: "i-unc", insight: insight("unconfirmed_returns", unconfirmed, 60) },
    { id: "i-cash", insight: insight("cash_held", cash, 40) },
  ];

  it("pushes a late payout and the top row, worded as the card, through the tracked route", () => {
    const out = findingCandidates(store(visible), owner, "live", none);
    expect(out.map((c) => [c.kind, c.insightId, c.priority])).toEqual([
      ["cash_held", "i-cash", 1],
      ["top_finding", "i-unc", 2],
    ]);
    expect(out[0]!.title).toBe("TCS hasn't paid for 40 delivered orders");
    expect(out[0]!.body).toBe("PKR 120,000\nCheck TCS's own statement, then chase the payout.");
    expect(out[0]!.url).toBe(`/insights/i-cash/open?to=${encodeURIComponent("/orders?days=30&awaitingPayout=tcs")}&from=push`);
  });

  it("names the store for a member with more than one", () => {
    expect(findingCandidates(store(visible, "Demo Store"), owner, "live", none)[0]!.body).toMatch(/^Demo Store · PKR 120,000\n/);
  });

  it("never sends money without finance:view: cash held goes, and the top row loses its figure", () => {
    const out = findingCandidates(store(visible), staff, "live", none);
    expect(out.map((c) => c.kind)).toEqual(["top_finding"]);
    expect(`${out[0]!.title} ${out[0]!.body}`).not.toMatch(/PKR|9,000/);
    expect(out[0]!.body).toMatch(/^30\.0%/);
  });

  it("sends a finding once per appearance, and again after it comes back", () => {
    const sent = new Set([findingKey("m1", "i-cash", seen, "live"), findingKey("m1", "i-unc", seen, "live")]);
    expect(findingCandidates(store(visible), owner, "live", (k) => sent.has(k))).toEqual([]);
    const back = { ...store(visible), appearedAt: new Map([["i-cash", new Date("2026-10-28T03:00:00Z")], ["i-unc", seen]]) };
    expect(findingCandidates(back, owner, "live", (k) => sent.has(k)).map((c) => c.insightId)).toEqual(["i-cash"]);
  });

  it("keeps dry runs and real sends apart", () => {
    const dry = new Set([findingKey("m1", "i-unc", seen, "dry_run")]);
    expect(findingCandidates(store(visible), owner, "live", (k) => dry.has(k)).map((c) => c.insightId)).toEqual(["i-cash", "i-unc"]);
  });

  it("sends at most one top row a day per store", () => {
    expect(findingCandidates(store(visible), owner, "live", none, true).map((c) => c.kind)).toEqual(["cash_held"]);
  });

  it("doesn't count a store-wide context card as a top row", () => {
    const context = [{ id: "i-ctx", insight: insight("margin_ceiling", { kind: "margin" }, 500, "context") }];
    expect(findingCandidates(store(context), owner, "live", none)).toEqual([]);
  });

  it("does not push a top row that is itself the cash-held one twice", () => {
    const payout = visible[1]!;
    expect(findingCandidates(store([payout]), owner, "live", none).map((c) => c.kind)).toEqual(["cash_held"]);
    const lower = [payout, { id: "i-unc", insight: insight("unconfirmed_returns", unconfirmed, 20) }];
    expect(findingCandidates(store(lower), owner, "live", none).map((c) => c.kind)).toEqual(["cash_held"]);
  });
});

describe("Books and the digest", () => {
  it("words Books as Home's row does", () => {
    expect(booksPush(1).title).toBe("1 entry is waiting for approval in Books");
    expect(booksPush(1_204)).toEqual({
      title: "1,204 entries are waiting for approval in Books",
      body: "Drafts aren't in your books until someone approves them.",
      url: "/books/drafts?from=push",
    });
  });
  it("points the digest's push at Home", () => {
    expect(digestPush("3 things need your attention at Demo Store")).toEqual({
      title: "3 things need your attention at Demo Store",
      body: "Your weekly digest is in your inbox.",
      url: "/home?from=push",
    });
  });
});
