import { describe, expect, it } from "vitest";

import { contactReturnTest, wroteAfterOrdering, type BuyerContact } from "./buyer-contact";

// Made-up numbers throughout; nothing here comes from a real store.
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const contactOf = (m: Record<string, string[]>): BuyerContact => ({
  since: d("2026-08-01"),
  byCustomer: new Map(Object.entries(m).map(([k, v]) => [k, v.map(d)])),
});

describe("wroteAfterOrdering", () => {
  const c = contactOf({ c1: ["2026-09-10", "2026-09-20"] });
  it("counts a message after the order's first day and before the cut-off", () => {
    expect(wroteAfterOrdering(c, "c1", d("2026-09-08"), d("2026-09-15"))).toBe(true);
  });
  it("ignores the first day (COD confirmation), later messages, and unknown buyers", () => {
    expect(wroteAfterOrdering(c, "c1", d("2026-09-09"), d("2026-09-15"))).toBe(false);
    expect(wroteAfterOrdering(c, "c1", d("2026-09-11"), d("2026-09-15"))).toBe(false);
    expect(wroteAfterOrdering(c, null, d("2026-09-08"), d("2026-09-15"))).toBe(false);
  });
});

describe("contactReturnTest", () => {
  const order = (customerId: string, outcome: string) => ({ customerId, createdAt: d("2026-09-01"), outcome, outcomeAt: d("2026-09-08") });
  const many = (k: number, customerId: string, outcome: string) => Array.from({ length: k }, () => order(customerId, outcome));

  it("finds buyers who wrote in coming back more often, when it is unlikely to be chance", () => {
    const c = contactOf({ w: ["2026-09-04"] });
    const t = contactReturnTest([...many(12, "w", "returned"), ...many(28, "w", "delivered"), ...many(40, "s", "returned"), ...many(360, "s", "delivered")], c);
    expect(t).toMatchObject({ wrote: { decided: 40, returned: 12, rate: 30 }, silent: { decided: 400, returned: 40, rate: 10 }, significant: true });
  });

  it("says nothing with too few orders on a side, and leaves out orders before the history and open ones", () => {
    const c = contactOf({ w: ["2026-09-04"] });
    const early = { customerId: "s", createdAt: d("2026-07-01"), outcome: "returned", outcomeAt: d("2026-07-08") };
    const t = contactReturnTest([...many(10, "w", "returned"), ...many(100, "s", "delivered"), early, order("s", "in_transit")], c);
    expect(t).toMatchObject({ wrote: { decided: 10 }, silent: { decided: 100, returned: 0 }, z: null, significant: false });
  });
});
