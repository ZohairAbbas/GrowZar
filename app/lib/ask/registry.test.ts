import { beforeAll, describe, expect, it, vi } from "vitest";

import { inScope, type Scope } from "../metrics/scope";
import { tableSource } from "../metrics/fx";
import type { RollupOrder } from "../metrics/rollups";
import type { Section } from "../permissions";
import { FAKE_BUYER, fakeSummary, month, order, times } from "./test-fixtures";
import type { AskContext, ToolResult } from "./types";

// ── A made-up organization: a PKR store, an AED store, and a store outside the viewer's scope ──

const WORLD: Record<string, { currency: string; rows: RollupOrder[] }> = {
  s1: {
    currency: "PKR",
    rows: [
      ...month(),
      // The previous 30 days: 40 decided orders at 50%.
      ...times(20, () => order({ localDay: "2026-09-10", createdAt: new Date("2026-09-10T08:00:00Z") })),
      ...times(20, () => order({ localDay: "2026-09-10", createdAt: new Date("2026-09-10T08:00:00Z"), outcome: "returned", delivered: null })),
    ],
  },
  s2: { currency: "AED", rows: month("AED") },
  s3: { currency: "PKR", rows: month() },
};

const summaryOf = (storeId: string, from: string, to: string, scope?: Scope) => {
  const w = WORLD[storeId]!;
  const rows = w.rows.filter((o) => o.localDay! >= from && o.localDay! <= to && (!scope || inScope(o, scope)));
  return fakeSummary({ id: storeId, currency: w.currency }, rows, { from, to });
};

vi.mock("../db.server", () => ({
  prisma: {
    appConnection: { findMany: async () => [{ storeId: "s1", app: "COURIERIFY" }, { storeId: "s1", app: "FINANCIFY" }] },
    orderGrain: {
      aggregate: async () => ({ _min: { localDay: "2026-08-01" } }),
      groupBy: async () => [],
    },
  },
}));
vi.mock("../metrics/summaries.server", () => ({
  storeSummary: async (id: string, from: string, to: string, scope: Scope) => summaryOf(id, from, to, scope),
  loadSettledHistory: async (id: string) => WORLD[id]!.rows,
}));
vi.mock("../metrics/coverage.server", () => ({
  storeCoverage: async () => ({
    period: { from: "2026-09-20", to: "2026-10-19" },
    orders: 68,
    apps: [{ app: "FINANCIFY", state: "connected", gives: "orders and costs" }],
    items: [
      { key: "cogs", app: "FINANCIFY", label: "Product costs", phrase: "product costs", have: 30, of: 55, unit: "delivered orders", status: "partial", gap: "25 delivered orders have no product cost", effect: "profit is a ceiling", sections: ["home", "finance", "shipping", "marketing", "customers"] },
    ],
  }),
}));
vi.mock("../metrics/fx.server", () => ({
  loadFxSource: async () => ({ source: tableSource("financify", [{ from: "AED", to: "PKR", day: "2026-10-10", rate: "76.5", source: "financify" }, { from: "AED", to: "PKR", day: "2026-10-12", rate: "76.6", source: "financify" }]), ratesFrom: "2026-10-05" }),
}));
vi.mock("../metrics/campaigns.server", () => ({
  loadAttribution: async (_s: string, ids: string[]) => new Map(ids.map((id, i) => [id, { campaignKey: i % 2 ? "facebook:1" : null, platform: i % 2 ? "facebook" : null, method: i % 2 ? "utm_id" : "none" }])),
  loadCampaignNames: async () => new Map([["facebook:1", { name: "Eid Sale", platform: "facebook" }]]),
}));
vi.mock("../metrics/settlements.server", () => ({
  loadPayerHistories: async () => [{ payer: "leopards", payouts: 6, lastPaidDay: "2026-10-15", medianGapDays: 7, disputed: 0 }],
  loadStatements: async () => [{ payer: "leopards" }],
}));
vi.mock("../metrics/inventory.server", () => ({
  inventorySection: async () => ({
    currency: "PKR",
    variants: 2,
    selling: 2,
    outNow: 1,
    reorderNow: 1,
    untracked: 0,
    reordersInInventorify: true,
    rows: [
      { variantId: "11", title: "Lawn Suit", variantTitle: "Red", sku: "LS-R", stock: 0, soldInPeriod: 40, perDay: 1.3, daysOfCover: 0, netDaysOfCover: 0, onOrder: 0, reorderUnits: 50, deliveryRate: 75, state: "out", profit: { amount: "5000.00", currency: "PKR" } },
      { variantId: "22", title: "Dupatta", variantTitle: null, sku: null, stock: 90, soldInPeriod: 3, perDay: 0.1, daysOfCover: 900, netDaysOfCover: 1000, onOrder: 0, reorderUnits: null, deliveryRate: null, state: "slow", profit: null },
    ],
  }),
}));
vi.mock("../metrics/buyer-history.server", () => ({
  buyerHistorySection: async () => ({
    bands: [
      { band: "returned_before", orders: 10, delivered: 4, returned: 6, rate: 60 },
      { band: "delivered_before", orders: 20, delivered: 18, returned: 2, rate: 10 },
      { band: "first", orders: 38, delivered: 33, returned: 2, rate: 5.7 },
    ],
    returnsFromReturners: 60,
    otpEnabled: false,
    formShare: 40,
  }),
}));
vi.mock("../metrics/messaging.server", () => ({
  messagingSection: async () => ({
    messages: 100,
    matched: 90,
    channels: [{ channel: "whatsapp", sent: 100, reached: 95, opened: 60, clicked: 10, failed: 5, noDeliveryReport: 0 }],
    journeys: [{ journeyId: "j1", name: "Cart reminder", kind: "flow", sent: 100, reached: 95, opened: 60, clicked: 10, failed: 5, noDeliveryReport: 0, orders: 8, delivered: 6, returned: 1, open: 1, deliveredRevenue: [{ amount: "6000.00", currency: "PKR" }] }],
    followed: { orders: 8, delivered: 6, returned: 1, open: 1, deliveredRevenue: [], viaClick: 3, viaReach: 5, sameSession: 1 },
  }),
}));
const checkouts = { started: 50, abandoned: 30, abandonedValue: [{ amount: "30000.00", currency: "PKR" }], open: 5, settled: 25, followedUp: 10, notFollowedUp: 15, notFollowedUpValue: [{ amount: "15000.00", currency: "PKR" }], recovered: 4, recoveredValue: [{ amount: "4000.00", currency: "PKR" }], cameBack: 2, cartJourneys: [] };
vi.mock("../metrics/checkouts.server", () => ({ checkoutsSection: async () => checkouts, formAbandonmentsSection: async () => checkouts }));
vi.mock("../metrics/offers.server", () => ({
  offersSection: async () => ({
    currency: "PKR",
    formOrders: 20,
    byType: [{ key: "none", type: "none", label: "No offer", offerId: null, orders: 20, delivered: 15, returned: 5, returnRate: 25, avgPlaced: { amount: "1000.00", currency: "PKR" } }],
    byOffer: [{ key: "o1", type: "bundle", label: "Buy 2", offerId: "o1", orders: 20, delivered: 15, returned: 5, returnRate: 25, avgPlaced: { amount: "1000.00", currency: "PKR" } }],
    events: [],
  }),
}));
vi.mock("../insights/inbox.server", () => ({
  visibleInsights: async () => {
    const insight = { detector: "margin_ceiling", subject: "store", fingerprint: "margin_ceiling:store", rank: { group: "context", ordersAffected: 55 }, revealsMoney: true, finding: { kind: "margin" } };
    return { outcomes: [{ detector: "margin_ceiling", status: "found", insights: [insight] }], connected: new Set(), insights: [insight], row: new Map([["margin_ceiling:store", { id: "ins1" }]]), hiddenNow: () => false, visible: [insight], items: [{ id: "ins1", insight }] };
  },
}));
vi.mock("../outcomes/results.server", () => ({
  outcomeLinesOf: async () => [
    { watchId: "w1", insightId: "ins1", detector: "courier_for_city", status: "measured", since: "1 Oct", text: "Lahore by Leopards: 82% delivered before, 91% since; other routes moved 1 point", signal: null, money: null, moneyValue: null, internal: false, storeId: "s1", actedAt: "2026-10-01T00:00:00Z" },
    { watchId: "w2", insightId: "ins2", detector: "cash_held", status: "hidden", since: "2 Oct", text: "hidden", signal: null, money: null, moneyValue: null, internal: false, storeId: "s1", actedAt: "2026-10-02T00:00:00Z" },
  ],
}));
vi.mock("../insights/summary", async (orig) => ({
  ...(await orig<typeof import("../insights/summary")>()),
  // A finding that quotes a buyer, to prove the guard masks it.
  summaryOf: () => ({ headline: `Profit is a ceiling; ask ${FAKE_BUYER.phone}`, figure: "PKR 12,000", note: "25 orders lack a cost", affects: "55 orders" }),
}));
vi.mock("../metrics/screens.server", async (orig) => {
  const real = await orig<typeof import("../metrics/screens.server")>();
  const { profitTable } = await import("../metrics/profit-table");
  return {
    ...real,
    profitTables: async (_id: string, s: ReturnType<typeof summaryOf>) => {
      const input = { rows: s.rows, currency: s.store.currency!, ads: null, maxRows: Infinity };
      return { profitBy: { product: profitTable("product", input), city: profitTable("city", input), courier: profitTable("courier", input), campaign: profitTable("campaign", input) }, labels: {}, images: {} };
    },
    productProfit: async () => null,
    storePayoutAgeing: async () => ({
      currency: "PKR",
      buckets: [{ key: "0-7", label: "0–7 days" }],
      couriers: [{ courier: "leopards", paidBy: null, total: { amount: "9000.00", currency: "PKR" }, orders: 9, cells: { "0-7": { amount: { amount: "9000.00", currency: "PKR" }, orders: 9 } } }],
      total: { amount: "9000.00", currency: "PKR" },
      orders: 9,
      untracked: [],
      otherCurrencies: [],
    }),
    customersView: async () => ({
      customers: 7,
      buyersInPeriod: 7,
      repeatBuyers: 7,
      compare: { buyers: { delta: { current: 7, previous: 7, change: 0, direction: "flat", unit: "percent" }, trend: null, good: "up" }, repeatShare: { delta: { current: null, previous: null, change: null, direction: null, unit: "points" }, trend: null, good: "up" } },
      retention: { historyFrom: "2026-08-01", asOf: "2026-10-19", buyers: 7, cohorts: [{ month: "2026-08", buyers: 25, partialFirstMonth: true, cells: [{ offset: 1, buyers: 5, share: 20, partial: false }], money: null }], maxOffset: 1, repeat: [{ days: 30, eligible: 25, repeated: 5, share: 20 }], medianDaysToSecond: 21, secondOrders: 5, otherCurrencyOrders: 0, currency: "PKR", costedRevenueShare: null },
      // The screen's top buyers carry names and phone tails; the tool must leave them out.
      top: [{ customerId: "c1", name: FAKE_BUYER.name, phoneTail: "4567", orders: 3, deliveryRate: { rate: 1, delivered: 3, returned: 0, stillOpen: 0, partial: 0 }, deliveredRevenue: [] }],
    }),
    marketingView: async (_id: string, s: ReturnType<typeof summaryOf>) => ({
      currency: s.store.currency,
      products: [],
      storeReturnRate: 25,
      withAds: false,
      adDays: null,
      campaigns: null,
      campaignsCompared: false,
      outcomes: {
        campaigns: [{ key: "facebook:1", platform: "facebook", name: "Eid Sale", spend: { amount: "5000.00", currency: "PKR" }, orders: 34, delivered: 27, returned: 5, stillOpen: 2, notTrackable: 0, decided: 32, deliveredRevenue: { amount: "27000.00", currency: "PKR" }, returnRate: 15.6, roas: 5.4, costPerDelivered: { amount: "185.19", currency: "PKR" }, byId: 34, byName: 0 }],
        unattributed: { untracked: 34, affiliate: 0, noRecord: 0 },
        matched: 34,
        of: 68,
        storeReturnRate: 25,
      },
      catalog: {},
    }),
  };
});

const { runTool, TOOLS, toolSpecs, strictSchema } = await import("./registry.server");
const { IDENTITY, EMAIL, PHONE } = await import("./guard");

const STORES = [
  { id: "s1", name: "Lahore Lawn", currency: "PKR", timezone: "Asia/Karachi" },
  { id: "s2", name: "Dubai Abayas", currency: "AED", timezone: "Asia/Dubai" },
];

function ctx(o: { finance?: boolean; sections?: Section[]; stores?: typeof STORES } = {}): AskContext {
  const allowed = new Set<Section>(o.sections ?? ["home", "orders", "shipping", "finance", "customers", "inventory", "marketing", "inbox", "settings"]);
  if (o.finance === false) allowed.delete("finance");
  // An earlier table of the answer, for calculate.
  const tables: ToolResult[] = [{ tool: "summary", status: "ok", title: "t", columns: [{ key: "label", label: "Store", kind: "text" }, { key: "orders", label: "Orders", kind: "count" }], rows: [{ label: "Lahore Lawn", orders: 68 }, { label: "Dubai Abayas", orders: 68 }], meta: { stores: [], rules: [], gaps: [], notes: [] }, link: null }];
  return { organizationId: "org", userId: "u", baseCurrency: "PKR", stores: o.stores ?? STORES, can: (s) => allowed.has(s), now: new Date("2026-10-19T12:00:00Z"), memo: new Map(), tables };
}

const run = (name: string, args: Record<string, unknown>, c = ctx()) => runTool(name, args, c);
const PERIOD = null;
const FILTERS = null;

/** One call per tool and view, with every argument given (strict schemas). */
const CALLS: Array<[string, Record<string, unknown>]> = [
  ["list_stores", {}],
  ["summary", { store: null, period: PERIOD }],
  ["summary", { store: "s1", period: PERIOD }],
  ["breakdown", { store: "s1", metrics: ["orders", "delivery_rate"], by: "city", period: PERIOD, filters: FILTERS, variant: null, order: null, only: null, limit: null }],
  ["breakdown", { store: "s1", metrics: ["profit", "delivered_revenue"], by: "variant", period: PERIOD, filters: FILTERS, variant: null, order: "bottom", only: null, limit: null }],
  ["breakdown", { store: "s1", metrics: ["orders", "buyers"], by: "buyer_type", period: PERIOD, filters: FILTERS, variant: null, order: null, only: null, limit: null }],
  ["breakdown", { store: "s1", metrics: ["orders", "return_rate"], by: "campaign", period: PERIOD, filters: FILTERS, variant: null, order: null, only: null, limit: null }],
  ["compare_periods", { store: "s1", metrics: ["delivery_rate", "orders"], by: "none", period: PERIOD, against: null, filters: FILTERS, order: null, limit: null }],
  ["city_courier", { store: "s1", period: PERIOD, city: null, courier: null, limit: null }],
  ["cash", { store: "s1", view: "owed", period: null }],
  ["cash", { store: "s1", view: "payouts", period: null }],
  ["cash", { store: "s1", view: "stages", period: null }],
  ["stock", { store: "s1", state: null, search: null, sort: null, period: null, limit: null }],
  ["customers", { store: "s1", view: "repeat", period: null }],
  ["customers", { store: "s1", view: "repeat_curve", period: null }],
  ["customers", { store: "s1", view: "cohorts", period: null }],
  ["customers", { store: "s1", view: "returners", period: null }],
  ["marketing", { store: "s1", view: "campaigns", period: null, limit: null }],
  ["marketing", { store: "s1", view: "messages", period: null, limit: null }],
  ["marketing", { store: "s1", view: "checkouts", period: null, limit: null }],
  ["marketing", { store: "s1", view: "offers", period: null, limit: null }],
  ["insights", { store: "s1", insight: null, period: null }],
  ["coverage", { store: "s1", period: null, gaps_only: null }],
  ["outcomes", { store: "s1", detector: null, status: null }],
  ["calculate", { op: "share", values: [{ table: 1, row: "Lahore Lawn", column: "orders" }, { table: 1, row: "Dubai Abayas", column: "orders" }] }],
];

/** Every key and string anywhere in a result. */
function walk(v: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
  if (typeof v === "string") strings.push(v);
  else if (Array.isArray(v)) v.forEach((x) => walk(x, keys, strings));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      keys.push(k);
      walk(x, keys, strings);
    }
  }
  return { keys, strings };
}

describe("every tool", () => {
  let results: Array<{ name: string; args: Record<string, unknown>; finance: boolean; result: ToolResult }> = [];
  beforeAll(async () => {
    results = [];
    for (const finance of [true, false]) {
      for (const [name, args] of CALLS) results.push({ name, args, finance, result: await run(name, args, ctx({ finance })) });
    }
  });

  it("has a call here, and a strict schema the provider accepts", () => {
    expect(new Set(CALLS.map(([n]) => n))).toEqual(new Set(TOOLS.map((t) => t.name)));
    const specs = toolSpecs();
    expect(specs.map((s) => s.name)).toEqual(TOOLS.map((t) => t.name));
    // Byte-stable between requests, so the provider's prompt cache holds.
    expect(JSON.stringify(toolSpecs())).toBe(JSON.stringify(specs));
  });

  it("answers each call, or refuses it only for a role without the section", () => {
    for (const { name, args, finance, result } of results) {
      const needsFinance = TOOLS.find((t) => t.name === name)!.sections(args as never).includes("finance");
      const expected = !finance && needsFinance ? ["forbidden"] : ["ok", "no_data", "not_enough_data"];
      expect(expected, `${name} (finance: ${finance}): ${result.meta.notes.join("; ")}`).toContain(result.status);
    }
  });

  it("never returns a buyer's name, phone, email or id, in any field", () => {
    for (const { name, result } of results) {
      const { keys, strings } = walk(result);
      expect(keys.filter((k) => IDENTITY.test(k)), name).toEqual([]);
      for (const s of strings) {
        expect(s, name).not.toContain(FAKE_BUYER.name);
        expect(s, name).not.toContain(FAKE_BUYER.phone);
        expect(s.match(EMAIL) ?? [], name).toEqual([]);
        expect(s.match(PHONE) ?? [], name).toEqual([]);
      }
    }
  });

  it("never returns a money figure to a viewer without Finance", () => {
    for (const { name, result } of results.filter((r) => !r.finance)) {
      expect(result.columns.filter((c) => c.kind === "money" || c.money), name).toEqual([]);
      expect(result.meta.currency, name).toBeUndefined();
    }
  });

  it("states the rules, and links every answer to a screen", () => {
    // calculate rests on earlier tables, whose links stand for it.
    for (const { name, result } of results.filter((r) => r.result.status === "ok" && r.name !== "calculate")) {
      expect(result.link, name).not.toBeNull();
      expect(result.meta.stores.length, name).toBeGreaterThan(0);
    }
  });
});

describe("permissions", () => {
  it("refuses a money metric to a viewer without Finance, by any tool", async () => {
    const c = ctx({ finance: false });
    for (const [name, args] of [
      ["breakdown", { store: "s1", metrics: ["orders", "profit"], by: "none", period: null, filters: null, variant: null, order: null, only: null, limit: null }],
      ["compare_periods", { store: "s1", metrics: ["delivered_revenue"], by: "none", period: null, against: null, filters: null, order: null, limit: null }],
      ["cash", { store: "s1", view: "owed", period: null }],
      ["stock", { store: "s1", state: null, search: null, sort: "profit", period: null, limit: null }],
    ] as const) {
      const r = await run(name, args as Record<string, unknown>, c);
      expect(r.status, name).toBe("forbidden");
      expect(r.title, name).toMatch(/Finance/);
      expect(r.rows, name).toEqual([]);
    }
  });

  it("refuses everything to a role without Home", async () => {
    const r = await run("summary", { store: null, period: null }, ctx({ sections: ["orders"] }));
    expect(r.status).toBe("forbidden");
  });

  it("asks for the section a breakdown's view belongs to", async () => {
    const homeOnly = ctx({ sections: ["home"] });
    const byCity = await run("breakdown", { store: "s1", metrics: ["orders"], by: "city", period: null, filters: null, variant: null, order: null, only: null, limit: null }, homeOnly);
    expect(byCity.title).toMatch(/Shipping/);
    const byProduct = await run("breakdown", { store: "s1", metrics: ["orders"], by: "product", period: null, filters: null, variant: null, order: null, only: null, limit: null }, homeOnly);
    expect(byProduct.title).toMatch(/Orders/);
    const total = await run("breakdown", { store: "s1", metrics: ["orders"], by: "none", period: null, filters: null, variant: null, order: null, only: null, limit: null }, homeOnly);
    expect(total.status).toBe("ok");
  });

  it("refuses a section the role lacks (staff: no Customers)", async () => {
    const r = await run("customers", { store: "s1", view: "repeat", period: null }, ctx({ sections: ["home", "orders", "shipping"] }));
    expect(r.status).toBe("forbidden");
    expect(r.title).toMatch(/Customers/);
  });

  it("answers a store outside the viewer's scope as one that does not exist, by id or by name", async () => {
    const byId = await run("breakdown", { store: "s3", metrics: ["orders"], by: "none", period: null, filters: null, variant: null, order: null, only: null, limit: null });
    const byName = await run("summary", { store: "Hidden Store", period: null });
    const nowhere = await run("summary", { store: "nope", period: null });
    for (const r of [byId, byName, nowhere]) {
      expect(r.status).toBe("forbidden");
      expect(r.title).toBe("That store is not available to you.");
    }
  });

  it("never reads the store scope from the arguments: null means the viewer's stores only", async () => {
    const r = await run("summary", { store: null, period: null }, ctx({ stores: [STORES[0]!] }));
    expect(r.meta.stores.map((s) => s.id)).toEqual(["s1"]);
  });

  it("rejects arguments the schema does not allow, even if the model sends them", async () => {
    const extra = await run("summary", { store: null, period: null, organizationId: "other-org" });
    expect(extra.status).toBe("invalid");
    const bad = await run("breakdown", { store: "s1", metrics: ["orders; DROP TABLE"], by: "city", period: null, filters: null, variant: null, order: null, only: null, limit: null });
    expect(bad.status).toBe("invalid");
  });
});

describe("empty and thin data", () => {
  const EMPTY = { days: null, from: "2026-01-01", to: "2026-01-31" };

  it("says there were no orders, never a zero", async () => {
    const b = await run("breakdown", { store: "s1", metrics: ["delivery_rate"], by: "city", period: EMPTY, filters: null, variant: null, order: null, only: null, limit: null });
    expect(b.status).toBe("no_data");
    expect(b.rows).toEqual([]);
    const s = await run("summary", { store: "s1", period: EMPTY });
    expect(s.status).toBe("no_data");
    expect(s.rows[0]!.delivery_rate).toBeNull();
  });

  it("refuses an impossible period instead of falling back to 30 days", async () => {
    const r = await run("summary", { store: "s1", period: { days: null, from: "2026-02-30", to: "2026-03-10" } });
    expect(r.status).toBe("invalid");
  });

  it("refuses to compare a period with itself or an overlapping one", async () => {
    const r = await run("compare_periods", { store: "s1", metrics: ["orders"], by: "none", period: { days: 30, from: null, to: null }, against: { days: 30, from: null, to: null }, filters: null, order: null, limit: null });
    expect(r.status).toBe("invalid");
    expect(r.title).toMatch(/must end before this one starts/);
  });

  it("withdraws a comparison against days before the store's history", async () => {
    const r = await run("compare_periods", { store: "s1", metrics: ["orders"], by: "none", period: null, against: { days: null, from: "2026-07-01", to: "2026-07-30" }, filters: null, order: null, limit: null });
    expect(r.status).toBe("not_enough_data");
  });
});

describe("mixed-currency organization", () => {
  it("adds counts across stores but never money in two currencies", async () => {
    const counts = await run("breakdown", { store: null, metrics: ["orders", "delivery_rate"], by: "courier", period: null, filters: null, variant: null, order: null, only: null, limit: null });
    expect(counts.status).toBe("ok");
    expect(counts.rows.find((r) => r.key === "leopards")!.orders).toBe(86);
    const money = await run("breakdown", { store: null, metrics: ["delivered_revenue"], by: "courier", period: null, filters: null, variant: null, order: null, only: null, limit: null });
    expect(money.status).toBe("invalid");
    expect(money.title).toMatch(/different currencies/);
  });

  it("converts the other store's revenue to the base currency at each day's rate in the summary", async () => {
    const r = await run("summary", { store: null, period: null });
    const dubai = r.rows.find((x) => x.key === "s2")!;
    // 30 delivered on 10 Oct at 76.5 + 25 on 12 Oct at 76.6, each 1,000 AED.
    expect(dubai.delivered_revenue).toBe(30 * 76_500 + 25 * 76_600);
    expect(dubai.profit).toBeNull();
    const all = r.rows.find((x) => x.key === "all")!;
    expect(all.delivered_revenue).toBe(55_000 + 30 * 76_500 + 25 * 76_600);
    expect(all.profit).toBeNull();
    expect(r.columns.find((c) => c.key === "delivered_revenue")!.currency).toBe("PKR");
    expect(r.meta.rules.join(" ")).toMatch(/rule #4/);
  });
});

describe("answers", () => {
  it("answers 'did it work' from the Results page's lines, leaving out what the merchant hid", async () => {
    const r = await run("outcomes", { store: null, detector: "courier_for_city", status: null });
    expect(r.rows).toEqual([expect.objectContaining({ key: "ins1", status: "measured", outcome: expect.stringContaining("91% since") })]);
    expect(r.meta.notes.join(" ")).toMatch(/marked "this wasn't us" and left out/);
  });

  it("compares delivery rate in points against the previous period", async () => {
    const r = await run("compare_periods", { store: "s1", metrics: ["delivery_rate"], by: "none", period: null, against: null, filters: null, order: null, limit: null });
    expect(r.rows[0]).toMatchObject({ delivery_rate: 84.6, delivery_rate_before: 50, delivery_rate_change: 34.6 });
  });

  it("matches a filter to the period's own spelling and links the screen with it", async () => {
    const r = await run("breakdown", { store: "s1", metrics: ["orders"], by: "courier", period: null, filters: { city: "lahore", courier: null }, variant: null, order: null, only: null, limit: null });
    expect(r.rows.map((x) => x.key)).toEqual(["leopards"]);
    expect(r.link!.href).toContain("store=s1");
    expect(r.link!.href).toContain("days=30");
  });

  it("says when no screen shows the view", async () => {
    const r = await run("breakdown", { store: "s1", metrics: ["aov"], by: "day", period: null, filters: null, variant: null, order: null, only: null, limit: null });
    expect(r.link!.exact).toBe(false);
  });

  it("finds the best courier in a city from the shipping matrix", async () => {
    const r = await run("city_courier", { store: "s1", period: null, city: "Karachi", courier: null, limit: null });
    expect(r.rows).toEqual([expect.objectContaining({ city: "Karachi", courier: "TCS", orders: 25, delivery_rate: 100 })]);
  });

  it("keeps insights' own wording, with any phone masked", async () => {
    const r = await run("insights", { store: "s1", insight: null, period: null });
    expect(r.rows[0]!.headline).toBe("Profit is a ceiling; ask [phone removed]");
    expect(r.link!.href).toContain("/insights?");
  });

  it("builds a strict schema for every tool", () => {
    for (const t of TOOLS) expect(() => strictSchema(t.schema)).not.toThrow();
  });
});
