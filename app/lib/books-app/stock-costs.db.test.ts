/**
 * Setting Shopify's cost per item through Inventorify (Books v1.1 V7, D-102)
 * against Postgres, with Inventorify's endpoints answered by a stand-in.
 * Synthetic data only, in a private schema with all of Growzar's migrations
 * (test-db.ts). Runs only with BOOKS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";

const calls: Array<{ path: string; body: unknown; headers?: Record<string, string>; maxAttempts?: number }> = [];
let reply: (path: string, body: any) => unknown = () => ({ ok: false, reason: "network", message: "no stand-in" });
vi.mock("../apps/client.server", () => ({
  appRequest: async (_app: string, o: { pathWithQuery: string; body: unknown; headers?: Record<string, string>; maxAttempts?: number }) => {
    calls.push({ path: o.pathWithQuery, body: o.body, headers: o.headers, maxAttempts: o.maxAttempts });
    return reply(o.pathWithQuery, o.body);
  },
}));

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("Costs to Shopify through Inventorify", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let prisma: import("@prisma/client").PrismaClient;
  let B: typeof import("../books/books.server");
  let C: typeof import("./stock-costs.server");
  let book: Awaited<ReturnType<typeof import("../books/books.server").setupBook>>;
  const t = Date.now();
  const org = `costs-org-${t}`;
  const store = `costs-store-${t}`;

  const raw = (entity: "INVENTORY_VARIANT" | "STOCK_LEVEL", id: string, payload: object) =>
    prisma.rawRecord.create({ data: { storeId: store, app: "INVENTORIFY", entity, externalId: id, sourceUpdatedAt: new Date(), payload: payload as never } });
  const ok = (data: unknown) => ({ ok: true, app: "INVENTORIFY", data });
  const fail = (errorType: string, reason = "client_error") => ({ ok: false, app: "INVENTORIFY", reason, errorType, message: errorType });
  const preview = (items: Array<{ variantId: string; cost: { amount: string } }>) =>
    ok({
      previewId: `p-${calls.length}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      currency: "PKR",
      items: items.map((i) => ({ variantId: i.variantId, title: "x", sku: null, current: null, proposed: { amount: i.cost.amount, currency: "PKR" }, change: i.variantId === "v3" ? "refused" : "set", ...(i.variantId === "v3" ? { reason: "archived" } : {}) })),
    });

  beforeAll(async () => {
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    B = await import("../books/books.server");
    C = await import("./stock-costs.server");
    const D = await import("../books/dates");
    await prisma.organization.create({ data: { id: org, name: "Costs Org", slug: org, baseCurrency: "PKR" } });
    await prisma.store.create({ data: { id: store, organizationId: org, shopDomain: `${store}.myshopify.com`, displayName: "Store One", currency: "PKR", timezone: "Asia/Karachi" } });
    await prisma.appConnection.create({ data: { storeId: store, app: "INVENTORIFY", status: "CONNECTED", capabilities: ["variants:read"] } });
    const day = D.todayIn("Asia/Karachi");
    book = await B.setupBook(org, { currency: "PKR", timeZone: "Asia/Karachi", fiscalYearStartMonth: 7, startDate: day, moneyAccounts: [{ subtype: "bank", name: "Meezan", opening: 0n }], settings: { startDate: day, storeIds: [store], codBasis: "delivery" } }, "owner");
    // v1 has a cost; v2 and v3 have stock and none; v4 has none but no stock.
    await raw("INVENTORY_VARIANT", "v1", { variantId: "v1", title: "Charger", sku: "CH-1", unitCost: { amount: "4.00", currency: "PKR" } });
    await raw("INVENTORY_VARIANT", "v2", { variantId: "v2", title: "Cable", sku: "CB-1", unitCost: null });
    await raw("INVENTORY_VARIANT", "v3", { variantId: "v3", title: "Case", unitCost: null });
    await raw("INVENTORY_VARIANT", "v4", { variantId: "v4", title: "Strap", unitCost: null });
    for (const [v, n] of [["v1", 10], ["v2", 5], ["v3", 8], ["v4", 0]] as const) await raw("STOCK_LEVEL", `${v}:l1`, { variantId: v, available: n, locationActive: true });
  });

  beforeEach(() => {
    calls.length = 0;
  });

  afterAll(async () => {
    if (B) await B.purgeBooks(org).catch(() => undefined);
    await prisma?.$disconnect();
    await dropSchema?.();
  });

  it("costs in the store's currency places: 450 → 450.00; refused when 0, negative, text or too many places", () => {
    expect(C.normaliseCost("450", "PKR")).toBe("450.00");
    expect(C.normaliseCost("1,250.5", "PKR")).toBe("1250.50");
    expect(C.normaliseCost("12.500", "PKR")).toBe("12.50");
    expect(C.normaliseCost("007", "JPY")).toBe("7");
    for (const bad of ["0", "0.00", "-5", "abc", "1.234", ""]) expect(C.normaliseCost(bad, "PKR")).toBeNull();
  });

  it("only where Inventorify says it can write costs", async () => {
    expect([...(await C.costsStoreIds(book))]).toEqual([]);
    await expect(C.previewCosts(book, store, [{ variantId: "v2", cost: "100" }], "u1")).rejects.toThrow(/can't set costs/);
    await expect(C.costsStore(book, "elsewhere")).rejects.toThrow(/isn't in these books/);
    await prisma.appConnection.update({ where: { storeId_app: { storeId: store, app: "INVENTORIFY" } }, data: { capabilities: ["variants:read", "costs:write"] } });
    expect([...(await C.costsStoreIds(book))]).toEqual([store]);
  });

  it("offers items with stock and no cost, most units first", async () => {
    expect((await C.itemsWithNoCost(book, store)).map((i) => [i.variantId, i.units])).toEqual([["v3", 8], ["v2", 5]]);
  });

  it("previews only the offered items with a cost typed, as the user, and keeps it for that user only", async () => {
    reply = (_p, body) => preview(body.items);
    await expect(C.previewCosts(book, store, [{ variantId: "v2", cost: "" }], "u1")).rejects.toThrow(/at least one/);
    await expect(C.previewCosts(book, store, [{ variantId: "v2", cost: "1.234" }], "u1")).rejects.toThrow(/Cable: enter a cost/);
    const p = await C.previewCosts(book, store, [{ variantId: "v2", cost: "120" }, { variantId: "v3", cost: "80.5" }, { variantId: "v1", cost: "9" }, { variantId: "zz", cost: "1" }], "u1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/v1/growzar/costs/preview", headers: { "X-Growzar-User": "u1" }, body: { items: [{ variantId: "v2", cost: { amount: "120.00", currency: "PKR" } }, { variantId: "v3", cost: { amount: "80.50", currency: "PKR" } }] } });
    expect(p.items.map((i) => [i.name, i.change, i.reason])).toEqual([["Cable", "set", null], ["Case", "refused", "archived in Shopify"]]);
    expect(await C.heldPreview(book, store, "u1")).toMatchObject({ previewId: p.previewId, key: p.key });
    expect(await C.heldPreview(book, store, "u2")).toBeNull();
    expect(await C.heldPreview(book, store, "u1", new Date(Date.now() + 16 * 60_000))).toBeNull();
    await expect(C.confirmCosts(book, store, "u2")).rejects.toThrow(/Preview the costs first/);
  });

  it("confirms once with the kept preview and key; a lost reply keeps it, so pressing again replays with the same key", async () => {
    const p = (await C.heldPreview(book, store, "u1"))!;
    reply = () => fail("", "timeout");
    await expect(C.confirmCosts(book, store, "u1")).rejects.toThrow(/may still be working/);
    expect(calls[0]).toMatchObject({ path: "/api/v1/growzar/costs/confirm", body: { previewId: p.previewId }, headers: { "X-Growzar-User": "u1", "Idempotency-Key": p.key }, maxAttempts: 1 });
    expect(await C.heldPreview(book, store, "u1")).not.toBeNull();

    reply = () => ok({ items: [{ variantId: "v2", result: "failed", reason: "shopify_rejected", message: "Cost is invalid" }], summary: { set: 0, failed: 1 } });
    const none = await C.confirmCosts(book, store, "u1");
    expect(none).toMatchObject({ set: 0, failed: 1, items: [{ name: "Cable", ok: false, reason: "Shopify didn't accept it: Cost is invalid" }] });
    expect(calls[1]!.headers!["Idempotency-Key"]).toBe(p.key);
    expect(await C.heldPreview(book, store, "u1")).toBeNull();
    expect(await prisma.bkAuditEvent.count({ where: { bookId: book.id, action: "stock.costs_set_in_shopify" } })).toBe(0);
  });

  it("a set cost is logged; an expired or already-confirmed preview is dropped", async () => {
    reply = (_p, body) => preview(body.items);
    await C.previewCosts(book, store, [{ variantId: "v2", cost: "120" }], "u1");
    reply = () => ok({ items: [{ variantId: "v2", result: "set" }], summary: { set: 1, failed: 0 } });
    expect(await C.confirmCosts(book, store, "u1")).toMatchObject({ set: 1, failed: 0 });
    expect((await prisma.bkAuditEvent.findFirstOrThrow({ where: { bookId: book.id, action: "stock.costs_set_in_shopify" } })).detail).toMatchObject({ items: 1, failed: 0, storeId: store });

    reply = (_p, body) => preview(body.items);
    await C.previewCosts(book, store, [{ variantId: "v2", cost: "130" }], "u1");
    reply = () => fail("preview_expired");
    await expect(C.confirmCosts(book, store, "u1")).rejects.toThrow(/more than 15 minutes old/);
    expect(await C.heldPreview(book, store, "u1")).toBeNull();
    reply = () => fail("forbidden");
    await expect(C.previewCosts(book, store, [{ variantId: "v2", cost: "130" }], "u1")).rejects.toThrow(/needs permission/);
  });
});
