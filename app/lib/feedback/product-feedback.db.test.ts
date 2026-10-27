/**
 * "This looks wrong" saved against Postgres (pre-Wave-1 pack 2), in a private
 * schema with all of Growzar's migrations (test-db.ts). Synthetic data only.
 * Runs only with BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";
import { parseFeedback } from "./product-feedback";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("product feedback", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let F: typeof import("./product-feedback.server");
  const t = Date.now();
  const org = `fb-org-${t}`;
  const store = `fb-store-${t}`;

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    F = await import("./product-feedback.server");
    await prisma.organization.create({ data: { id: org, name: "Feedback Org", slug: org, baseCurrency: "PKR" } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("keeps what the member said, the figures as they stood, who, and the build", async () => {
    const inputs = { day: 27, daysInMonth: 31, current: { month: "2026-10", orders: { low: 272, likely: 340, high: 408 } } };
    const f = new FormData();
    for (const [k, v] of Object.entries({ tool: "month_end", kind: "wrong_amount", storeId: store, note: "We had a sale", inputs: JSON.stringify(inputs) })) f.append(k, v);
    const parsed = parseFeedback(f);
    if ("error" in parsed) throw new Error(parsed.error);
    const id = await F.saveFeedback(parsed, { organizationId: org, userId: "u1" }, "abc1234");
    expect(await prisma.productFeedback.findUnique({ where: { id }, omit: { createdAt: true } })).toEqual({
      id, organizationId: org, storeId: store, userId: "u1", tool: "month_end", kind: "wrong_amount", note: "We had a sale", subject: null, inputs, version: "abc1234",
    });
  });

  it("keeps the order a return-risk band was about", async () => {
    const id = await F.saveFeedback({ tool: "return_risk", kind: "wrong_band", storeId: store, note: null, subject: "order-9", inputs: { band: "high", reasons: ["first order"] } }, { organizationId: org, userId: "u2" }, "abc1234");
    expect(await prisma.productFeedback.findUnique({ where: { id }, select: { subject: true, inputs: true } })).toEqual({ subject: "order-9", inputs: { band: "high", reasons: ["first order"] } });
  });

  it("goes with its organization", async () => {
    await prisma.organization.delete({ where: { id: org } });
    expect(await prisma.productFeedback.count({ where: { organizationId: org } })).toBe(0);
  });
});
