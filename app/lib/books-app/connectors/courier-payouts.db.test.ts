/**
 * The courier-payout connector against Postgres (B3, D-86, D-87, D-92), with
 * Courierify stubbed. Runs only with BOOKS_TEST_DATABASE_URL, in a private
 * schema with all of Growzar's migrations (test-db.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../../books/__tests__/test-db";
import type { SettlementWire } from "./courier-payouts";

const run = TEST_DATABASE_URL ? describe : describe.skip;
const $ = (amount: number) => ({ amount: String(amount), currency: "PKR" });

run("Courier payout connector against Postgres", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../../books/books.server");
  let R: typeof import("./runs.server");
  let C: typeof import("./courier-payouts.server");
  let book: Awaited<ReturnType<typeof import("../../books/books.server").setupBook>>;
  const acc: Record<string, string> = {};
  const org = `cp-org-${Date.now()}`;
  const store = `cp-store-${Date.now()}`;
  const start = "2026-10-01";
  let served: SettlementWire[] = [];
  let deleted: Array<{ settlementId: string; settlementRef?: string }> = [];
  const asked: string[] = [];

  const payout = (id: string, patch: Partial<SettlementWire> = {}): SettlementWire => ({
    id,
    settlementId: id,
    courier: "postex",
    settlementRef: `CPR-${id}`,
    paymentReference: `CPR-${id}`,
    settlementDate: "2026-10-10T00:00:00.000Z",
    receivedAt: "2026-10-11T00:00:00.000Z",
    direction: "payout",
    netPaid: $(9_300),
    grossCollected: $(10_000),
    linesGross: $(10_000),
    unattributedGross: $(0),
    totalDeductions: $(700),
    shipmentsCount: 2,
    lines: [
      { orderId: "1", collectedAmount: $(6_000), deductions: [{ type: "delivery_fee", amount: $(300) }], netAmount: $(5_700) },
      { orderId: "2", collectedAmount: $(4_000), deductions: [{ type: "delivery_fee", amount: $(300) }], netAmount: $(3_700) },
    ],
    settlementDeductions: [{ type: "wht", amount: $(100) }],
    invariantOk: true,
    invariantReason: null,
    ...patch,
  });
  const fetchPage = async (_shop: string, q: URLSearchParams) => {
    asked.push(q.toString());
    const page = { shopCurrency: "PKR", data: served, deletedSettlements: q.has("updatedSince") ? deleted : [], pagination: { hasMore: false, nextCursor: null } };
    return page;
  };
  const runIt = () => R.runConnector(book, "courierify_payouts", "manual", (b, c) => C.runCourierPayouts(b, c, fetchPage));
  const docs = () => prisma.bkDocument.findMany({ where: { bookId: book.id, source: "courierify_payouts" }, orderBy: [{ sourceRef: "asc" }] });
  const sums = () => B.ledgerSums(book.id);
  const named = (n: string) => acc[n]!;

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../../books/books.server");
    R = await import("./runs.server");
    C = await import("./courier-payouts.server");
    await prisma.organization.create({ data: { id: org, name: "Payout Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, currency: "PKR", timezone: "Asia/Karachi" } });
    await prisma.appConnection.create({ data: { storeId: store, app: "COURIERIFY", status: "CONNECTED", capabilities: ["settlements:lines"] } });
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: start, moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: start, storeIds: [store], codBasis: "delivery" } }, "owner");
    for (const a of await B.listAccounts(book)) acc[a.name] = a.id;
    const mapping = await C.payoutDefaults(book);
    await R.saveConnector(book, "courierify_payouts", { enabled: true, mode: "draft", startDate: start, settings: { mapping } as never }, "owner");
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("a payout comes in as a draft on the day the money arrived, filed under its courier and store", async () => {
    served = [payout("s1")];
    expect(await runIt()).toMatchObject({ status: "ok", created: 1 });
    const [d] = await docs();
    expect(d).toMatchObject({ sourceRef: "s1", type: "courier_payout", status: "draft", storeId: store });
    expect(d!.date.toISOString().slice(0, 10)).toBe("2026-10-11");
    expect((await prisma.bkContact.findUnique({ where: { id: d!.contactId! } }))?.name).toBe("PostEx");
    // The first run reads everything; the next one only what changed since.
    expect(asked[0]).not.toMatch(/updatedSince/);
    await runIt();
    expect(asked.at(-1)).toMatch(/updatedSince=/);
  });

  it("saved automatically: the bank, the charges, the tax and what couriers owe", async () => {
    await R.saveConnector(book, "courierify_payouts", { enabled: true, mode: "auto", startDate: start, settings: (await R.getConnector(book, "courierify_payouts")).settings as never }, "owner");
    const s = await sums();
    expect(s.get(named("Meezan"))).toBe(930_000n);
    expect(s.get(named("Delivery charges"))).toBe(60_000n);
    expect(s.get(named("Tax withheld by others"))).toBe(10_000n);
    expect(s.get(named("Owed by couriers"))).toBe(-1_000_000n);
  });

  it("a re-run over the same data posts nothing new", async () => {
    const before = (await prisma.bkEntryLine.count({ where: { bookId: book.id } }));
    expect(await runIt()).toMatchObject({ created: 0, updated: 0 });
    expect(await prisma.bkEntryLine.count({ where: { bookId: book.id } })).toBe(before);
  });

  it("a saved payout Courierify later changes: the difference posts, once (rule 3)", async () => {
    // A parcel's charge re-split: 100 of delivery became a return charge.
    served = [payout("s1", { lines: [payout("s1").lines![0]!, { orderId: "2", collectedAmount: $(4_000), deductions: [{ type: "delivery_fee", amount: $(200) }, { type: "reversal_fee", amount: $(100) }], netAmount: $(3_700) }] })];
    expect(await runIt()).toMatchObject({ created: 1 });
    const c1 = (await docs()).find((d) => d.sourceRef === "s1:c1")!;
    expect(c1).toMatchObject({ type: "manual", status: "posted", storeId: store });
    expect(c1.date.toISOString().slice(0, 10)).toBe("2026-10-11");
    const s = await sums();
    expect(s.get(named("Delivery charges"))).toBe(50_000n);
    expect(s.get(named("Return charges"))).toBe(10_000n);
    expect(s.get(named("Meezan"))).toBe(930_000n);
    expect(await runIt()).toMatchObject({ created: 0, updated: 0 });
  });

  it("kept back money goes to Held by courier, and a shared batch keeps others' money apart", async () => {
    served = [
      payout("s2", { netPaid: $(8_300), totalDeductions: $(1_700), settlementDeductions: [{ type: "wht", amount: $(100) }, { type: "carry_forward", amount: $(1_000) }] }),
      payout("s3", {
        courier: "tcs",
        netPaid: $(8_800),
        grossCollected: $(10_000),
        linesGross: $(2_000),
        unattributedGross: $(8_000),
        totalDeductions: $(1_200),
        lines: [{ orderId: "9", collectedAmount: $(2_000), deductions: [{ type: "delivery_fee", amount: $(100) }], netAmount: $(1_900) }],
        settlementDeductions: [{ type: "wht", amount: $(500) }, { type: "unallocated", amount: $(600) }],
      }),
    ];
    expect(await runIt()).toMatchObject({ created: 2 });
    const all = await B.listAccounts(book);
    const id = (n: string) => all.find((a) => a.name === n)!.id;
    const s = await sums();
    expect(s.get(id("Held by courier"))).toBe(100_000n);
    expect(s.get(id("Courier money not for your orders"))).toBe(-700_000n);
    expect([...s.values()].reduce((t, v) => t + v, 0n)).toBe(0n);
  });

  it("flagged payouts post with the unexplained part, and say so; line-less and broken ones are left out (D-92)", async () => {
    served = [
      payout("s4", { netPaid: $(9_000), totalDeductions: $(1_000), settlementDeductions: [{ type: "wht", amount: $(100) }, { type: "unallocated", amount: $(300) }], invariantOk: false, invariantReason: "unallocated_gap" }),
      payout("s5", { lines: [] }),
      payout("s6", { invariantOk: false, invariantReason: "identity_broken" }),
    ];
    const r = await runIt();
    expect(r).toMatchObject({ status: "partial", created: 1 });
    expect(r!.notes.join(" ")).toMatch(/none of your parcels/);
    expect(r!.notes.join(" ")).toMatch(/don't add up/);
    expect(r!.notes.join(" ")).toMatch(/charges the courier didn't explain/);
    const unexplained = (await B.listAccounts(book)).find((a) => a.name === "Courier charges not explained")!;
    expect((await sums()).get(unexplained.id)).toBe(30_000n);
    expect((await docs()).find((d) => d.sourceRef === "s4")?.memo).toMatch(/check: charges not explained/);
  });

  it("removed in Courierify: a saved payout is flagged, never cancelled for you", async () => {
    served = [];
    deleted = [{ settlementId: "s2", settlementRef: "CPR-s2" }];
    const r = await runIt();
    expect(r!.notes.join(" ")).toMatch(/Courierify removed payout CPR-s2/);
    expect((await docs()).find((d) => d.sourceRef === "s2")?.status).toBe("posted");
  });
});
