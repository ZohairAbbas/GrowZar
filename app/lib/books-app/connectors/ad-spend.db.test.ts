/**
 * The ad-spend connector against Postgres (B3), in a private schema with all
 * of Growzar's migrations (test-db.ts). Runs only with BOOKS_TEST_DATABASE_URL.
 * Pack §3 asks each connector for: a re-run that posts nothing new, a late
 * change posting a difference, and a closed period.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../../books/__tests__/test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Ad spend connector against Postgres", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../../books/books.server");
  let R: typeof import("./runs.server");
  let A: typeof import("./ad-spend.server");
  let D: typeof import("../../books/dates");
  let P: typeof import("../../books/posting");
  let book: Awaited<ReturnType<typeof import("../../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const org = `ads-org-${Date.now()}`;
  const store = `ads-store-${Date.now()}`;
  let today = "";
  let d1 = "";
  let d2 = "";

  const spendRow = (day: string, key: string, spend: string, fees: string, extra: Record<string, unknown> = {}) =>
    prisma.adSpend.upsert({
      where: { storeId_day_level_key: { storeId: store, day, level: "platform", key } },
      create: { storeId: store, day, level: "platform", key, platform: key, spendAmount: spend, feesAmount: fees, currency: "PKR", method: "measured", fxStatus: "ok", detail: {}, ...extra },
      update: { spendAmount: spend, feesAmount: fees, ...extra },
    });
  const runIt = () => R.runConnector(book, "ad_spend", "manual", A.runAdSpend);
  const docs = () => prisma.bkDocument.findMany({ where: { bookId: book.id, source: "ad_spend" }, orderBy: [{ sourceRef: "asc" }] });
  const balance = async (name: string) => (await B.ledgerSums(book.id)).get(acc[name]!) ?? 0n;
  const save = (mode: "draft" | "auto", platforms = { facebook: { advertising: acc["Advertising"]!, fees: acc["Bank charges"]!, paidFrom: acc["Business card"]! } }) =>
    R.saveConnector(book, "ad_spend", { enabled: true, mode, startDate: d1, settings: { platforms } }, "owner");

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../../books/books.server");
    R = await import("./runs.server");
    A = await import("./ad-spend.server");
    D = await import("../../books/dates");
    P = await import("../../books/posting");
    today = D.todayIn("Asia/Karachi");
    d1 = P.addDays(today, -10);
    d2 = P.addDays(today, -9);
    await prisma.organization.create({ data: { id: org, name: "Ads Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, currency: "PKR", timezone: "Asia/Karachi" } });
    book = await B.setupBook(
      org,
      { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: d1, moneyAccounts: [{ subtype: "card", name: "Business card", opening: 0n }], settings: { startDate: d1, storeIds: [store], codBasis: "delivery" } },
      "owner",
    );
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("brings each platform-day in as a draft, with spend and charges against the card", async () => {
    await spendRow(d1, "facebook", "1000.50", "160.08");
    await spendRow(d2, "facebook", "2000", "320");
    await save("draft");
    const r = await runIt();
    expect(r).toMatchObject({ status: "ok", created: 2 });
    const [first] = await docs();
    expect(first).toMatchObject({ sourceRef: `${store}:facebook:${d1}`, status: "draft", storeId: store, type: "ad_spend" });
    expect(first!.data).toMatchObject({
      platform: "facebook",
      debits: expect.arrayContaining([{ accountId: acc["Advertising"], amount: "100050" }, { accountId: acc["Bank charges"], amount: "16008" }]),
      credits: [{ accountId: acc["Business card"], amount: "116058" }],
    });
  });

  it("a re-run over the same data brings in nothing new; a changed draft is refreshed in place", async () => {
    expect(await runIt()).toMatchObject({ created: 0, updated: 0 });
    await spendRow(d2, "facebook", "2100", "336");
    expect(await runIt()).toMatchObject({ created: 0, updated: 1 });
    expect((await docs()).length).toBe(2);
  });

  it("switching to automatic saves the waiting drafts", async () => {
    expect(await save("auto")).toEqual({ posted: 2, left: 0 });
    expect((await docs()).every((d) => d.status === "posted")).toBe(true);
    expect(await balance("Advertising")).toBe(100_050n + 210_000n);
  });

  it("a later correction posts the difference on the spend day, once (D-74, D-84)", async () => {
    await spendRow(d1, "facebook", "900.50", "144.08");
    expect(await runIt()).toMatchObject({ created: 1 });
    const c1 = (await docs()).find((d) => d.sourceRef === `${store}:facebook:${d1}:c1`)!;
    expect(c1).toMatchObject({ status: "posted", storeId: store });
    expect(c1.date.toISOString().slice(0, 10)).toBe(d1);
    expect(await balance("Advertising")).toBe(90_050n + 210_000n);
    expect(await balance("Bank charges")).toBe(14_408n + 33_600n);
    expect(await balance("Business card")).toBe(-(90_050n + 14_408n + 210_000n + 33_600n));
    // The original is untouched.
    const original = (await docs()).find((d) => d.sourceRef === `${store}:facebook:${d1}`)!;
    expect(original.data).toMatchObject({ debits: expect.arrayContaining([{ accountId: acc["Advertising"], amount: "100050" }]) });
    expect(await runIt()).toMatchObject({ created: 0, updated: 0 });
  });

  it("once the day's month is closed, a correction is dated on the day it's seen", async () => {
    await B.setClosedThrough(book, d1, today, "owner");
    book = (await B.getBook(org))!;
    await spendRow(d1, "facebook", "950.50", "152.08");
    expect(await runIt()).toMatchObject({ created: 1 });
    const c2 = (await docs()).find((d) => d.sourceRef === `${store}:facebook:${d1}:c2`)!;
    expect(c2.status).toBe("posted");
    expect(c2.date.toISOString().slice(0, 10)).toBe(today);
    expect(await balance("Advertising")).toBe(95_050n + 210_000n);
  });

  it("a correction the merchant cancelled isn't raised again", async () => {
    const c2 = (await docs()).find((d) => d.sourceRef === `${store}:facebook:${d1}:c2`)!;
    await B.cancelDocument(book, c2.id, "the platform got it wrong", "owner");
    expect(await runIt()).toMatchObject({ created: 0, updated: 0 });
    expect((await docs()).filter((d) => d.sourceRef?.startsWith(`${store}:facebook:${d1}:c`)).length).toBe(2);
  });

  it("a platform not set up, and a day Financify couldn't convert, are reported, not guessed", async () => {
    await spendRow(d2, "tiktok", "500", "0");
    await spendRow(d2, "facebook", "2100", "336", { fxStatus: "conversion_failed" });
    const r = await runIt();
    expect(r?.status).toBe("partial");
    expect(r?.notes.join(" ")).toMatch(/TikTok has spend but isn't set up/);
    expect(r?.notes.join(" ")).toMatch(/couldn't convert/);
    expect((await docs()).some((d) => d.sourceRef?.includes(":tiktok:"))).toBe(false);
  });

  it("the worker runs it only when Books is on for the organization, and only when due", async () => {
    const S = await import("./schedule.server");
    const old = process.env.BOOKS_ENABLED;
    try {
      await prisma.bkConnector.updateMany({ where: { bookId: book.id }, data: { lastRunAt: new Date(Date.now() - 7 * 3600_000) } });
      process.env.BOOKS_ENABLED = "on";
      expect(await S.runDueConnectors()).toEqual([]); // the organization's switch is off
      await prisma.booksSettings.create({ data: { organizationId: org, enabled: true } });
      expect(await S.runDueConnectors()).toEqual([{ key: "ad_spend", status: "partial" }]);
      expect(await S.runDueConnectors()).toEqual([]); // just ran
      process.env.BOOKS_ENABLED = "off";
      await prisma.bkConnector.updateMany({ where: { bookId: book.id }, data: { lastRunAt: null } });
      expect(await S.runDueConnectors()).toEqual([]); // the server's switch is off
    } finally {
      process.env.BOOKS_ENABLED = old;
    }
  });

  it("the run log and the connector record what happened", async () => {
    const runs = await R.listRuns(book, "ad_spend");
    expect(runs[0]).toMatchObject({ status: "partial", trigger: "auto" });
    const c = await R.getConnector(book, "ad_spend");
    expect(c).toMatchObject({ enabled: true, mode: "auto", running: false, lastStatus: "partial" });
  });
});
