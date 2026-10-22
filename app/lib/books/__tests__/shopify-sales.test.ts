import { describe, expect, it } from "vitest";
import { accountForGateway, applyStoredCosts, routeManualPayment, decimalToMinor, isCodGateway, isReturnedStatus, legacyOrderId, negateLines, parcelChanges, parcelReturnLines, summariseDays, trackingStatus, toShopOrder, type SalesMapping, type ShopOrder } from "../connectors/shopify-sales";
import { zonedDayStart } from "../dates";

const M: SalesMapping = { sales: "sales", shipping: "ship", discounts: "disc", returns: "ret", tax: "tax", gateways: {}, cod: "cod", prepaid: "pre", giftCards: "gift", cogs: "cogs", stock: "stock" };
const TZ = "Asia/Karachi";
const D = "2026-10-07";
const at = (h: number, day = D) => `${day}T${String(h).padStart(2, "0")}:00:00+05:00`;

function order(p: Partial<ShopOrder> & { id: string }): ShopOrder {
  return {
    name: `#${p.id}`,
    createdAt: at(10),
    cancelledAt: null,
    test: false,
    currency: "PKR",
    gateways: ["Cash on Delivery (COD)"],
    total: "0",
    received: "0",
    discounts: "0",
    shipping: "0",
    tax: "0",
    transactions: [],
    lines: [],
    refunds: [],
    ...p,
  };
}
const line = (qty: number, total: string, unitCost: string | null, giftCard = false) => ({ quantity: qty, total, unitCost, giftCard });
const sale = (gateway: string, amount: string) => ({ kind: "SALE", status: "SUCCESS", gateway, amount });
const net = (s: { debits: { accountId: string; amount: string }[]; credits: { accountId: string; amount: string }[] }) => {
  const m: Record<string, bigint> = {};
  for (const d of s.debits) m[d.accountId] = (m[d.accountId] ?? 0n) + BigInt(d.amount);
  for (const c of s.credits) m[c.accountId] = (m[c.accountId] ?? 0n) - BigInt(c.amount);
  return m;
};
const balanced = (s: Parameters<typeof net>[0]) => Object.values(net(s)).reduce((a, b) => a + b, 0n) === 0n;
const run = (placed: ShopOrder[], changed: ShopOrder[] = [], days = [D], startDate = "2026-10-01", mapping: SalesMapping = M) =>
  summariseDays({ days, timeZone: TZ, startDate, decimals: 2, mapping, placed, changed });
/** Profit effect of a day: sales − discounts + shipping − returns − cost. */
const profit = (n: Record<string, bigint>) => -(n.sales ?? 0n) - (n.disc ?? 0n) - (n.ship ?? 0n) - (n.ret ?? 0n) - (n.cogs ?? 0n);

describe("gateways", () => {
  it("only exact COD names are COD (GoKwik PPCOD is partly prepaid)", () => {
    expect(isCodGateway("Cash on Delivery (COD)")).toBe(true);
    expect(isCodGateway(" cod ")).toBe(true);
    expect(isCodGateway("Gokwik PPCOD")).toBe(false);
    expect(isCodGateway("Cash on Delivery - الدفع عند الإستلام")).toBe(true);
    expect(isCodGateway("cash on delivery ")).toBe(true);
    expect(isCodGateway("Half payment for order confirmation")).toBe(false);
    expect(isCodGateway("bank deposit")).toBe(false);
  });
  it("mapped gateways win; gift_card goes to the gift card liability", () => {
    expect(accountForGateway("JazzCash", { ...M, gateways: { JazzCash: "jazz" } })).toBe("jazz");
    expect(accountForGateway("gift_card", M)).toBe("gift");
    expect(accountForGateway("COD", M)).toBe("cod");
    expect(accountForGateway(undefined, M)).toBe("pre");
  });
});

describe("decimalToMinor", () => {
  it("parses Shopify money strings exactly", () => {
    expect(decimalToMinor("1500.0", 2)).toBe(150000n);
    expect(decimalToMinor("0.005", 2)).toBe(1n);
    expect(decimalToMinor("-12.34", 2)).toBe(-1234n);
    expect(() => decimalToMinor("abc", 2)).toThrow();
  });
});

describe("orders placed", () => {
  it("unpaid COD order: all owed by couriers; sales, shipping, discount, tax; cost from Shopify", () => {
    const [d] = run([order({ id: "1", total: "2200", discounts: "100", shipping: "200", lines: [line(2, "2100", "400")] })]);
    expect(net(d!)).toEqual({ cod: 220000n, disc: 10000n, sales: -210000n, ship: -20000n, cogs: 80000n, stock: -80000n });
    expect(balanced(d!)).toBe(true);
  });

  it("prepaid order is owed by the gateway that collected it", () => {
    const [d] = run([order({ id: "2", gateways: ["shopify_payments"], total: "1150", received: "1150", tax: "150", transactions: [sale("shopify_payments", "1150")] })]);
    expect(net(d!)).toEqual({ pre: 115000n, sales: -100000n, tax: -15000n });
  });

  it("part prepaid + COD (e.g. GoKwik PPCOD): each part owed by its own method", () => {
    const [d] = run([order({ id: "3", gateways: ["Gokwik PPCOD", "Cash on Delivery (COD)"], total: "3000", received: "500", transactions: [sale("Gokwik PPCOD", "500")] })], [], [D], "2026-10-01", { ...M, gateways: { "Gokwik PPCOD": "gokwik" } });
    expect(net(d!)).toEqual({ gokwik: 50000n, cod: 250000n, sales: -300000n });
  });

  it("gift card bought: money held as a liability, not a sale, and no cost", () => {
    const [d] = run([order({ id: "4", gateways: ["shopify_payments"], total: "5000", received: "5000", transactions: [sale("shopify_payments", "5000")], lines: [line(1, "5000", null, true)] })]);
    expect(net(d!)).toEqual({ pre: 500000n, gift: -500000n });
    expect(d!.missingCost).toBe(0);
  });

  it("paying with a gift card spends the liability; the rest is COD", () => {
    const [d] = run([order({ id: "5", gateways: ["gift_card", "Cash on Delivery (COD)"], total: "3000", received: "1000", transactions: [sale("gift_card", "1000")] })]);
    expect(net(d!)).toEqual({ gift: 100000n, cod: 200000n, sales: -300000n });
  });

  it("items with no cost are counted (left out), or estimated at a set %", () => {
    const o = order({ id: "6", total: "1000", lines: [line(2, "1000", null), line(1, "0", "100")] });
    const [left] = run([o]);
    expect(left!.missingCost).toBe(2);
    expect(net(left!).cogs).toBe(10000n);
    expect(left!.memo).toMatch(/2 items with no cost in Shopify \(left out\)/);
    const [est] = run([o], [], [D], "2026-10-01", { ...M, costFallbackPercent: 40 });
    expect(net(est!).cogs).toBe(10000n + 40000n);
    expect(est!.memo).toMatch(/\(estimated\)/);
  });

  it("cost tracking is off when no cost accounts are set", () => {
    const [d] = run([order({ id: "7", total: "100", lines: [line(1, "100", "60")] })], [], [D], "2026-10-01", { ...M, cogs: "", stock: "" });
    expect(net(d!).cogs).toBeUndefined();
  });

  it("tax-inclusive prices still balance (sales is the balancing figure)", () => {
    const [d] = run([order({ id: "8", total: "1180", tax: "180" })]);
    expect(net(d!)).toEqual({ cod: 118000n, sales: -100000n, tax: -18000n });
  });

  it("days follow the shop's time zone", () => {
    const out = run([order({ id: "a", createdAt: "2026-10-06T19:30:00Z", total: "100" }), order({ id: "b", createdAt: "2026-10-07T19:30:00Z", total: "100" })], [], [D, "2026-10-08"]);
    expect(out.map((d) => [d.day, d.orders])).toEqual([[D, 1], ["2026-10-08", 1]]);
  });
});

describe("cancellations (as Shopify really records them)", () => {
  it("unpaid COD order cancelled the same day, with Shopify's zero-amount restock refund: nets to zero, stock back", () => {
    const o = order({
      id: "c1",
      total: "1000",
      discounts: "50",
      shipping: "100",
      cancelledAt: at(15),
      lines: [line(1, "950", "300")],
      refunds: [{ createdAt: at(15), total: "0.0", tax: "0", transactions: [], lines: [{ quantity: 1, restock: true, giftCard: false, total: "0", unitCost: "300" }] }],
    });
    const [d] = run([o], [o]);
    const n = net(d!);
    expect(n.cod ?? 0n).toBe(0n);
    expect(n.stock ?? 0n).toBe(0n);
    expect(profit(n)).toBe(0n);
    expect(balanced(d!)).toBe(true);
    expect(d!.cancelled).toBe(1);
  });

  it("cancelled days later: the sale reverses on the cancel day, off couriers", () => {
    const o = order({ id: "c2", createdAt: at(10, "2026-10-03"), cancelledAt: at(9), total: "800", tax: "80" });
    const [d] = run([], [o]);
    expect(net(d!)).toEqual({ ret: 72000n, tax: 8000n, cod: -80000n });
  });

  it("partly paid then cancelled: only the unpaid part reverses at cancel; the paid part through its refund", () => {
    const o = order({
      id: "c3",
      createdAt: at(10, "2026-10-03"),
      cancelledAt: at(9),
      gateways: ["Gokwik PPCOD", "Cash on Delivery (COD)"],
      total: "3000",
      received: "500",
      transactions: [sale("Gokwik PPCOD", "500")],
      refunds: [{ createdAt: at(9), total: "500", tax: "0", transactions: [{ kind: "REFUND", status: "SUCCESS", gateway: "Gokwik PPCOD", amount: "500" }], lines: [] }],
    });
    const [d] = run([], [o], [D], "2026-10-01", { ...M, gateways: { "Gokwik PPCOD": "gokwik" } });
    expect(net(d!)).toEqual({ ret: 300000n, gokwik: -50000n, cod: -250000n });
  });

  it("fully paid then cancelled: nothing unpaid; money back via the refund only", () => {
    const o = order({ id: "c4", createdAt: at(10, "2026-10-03"), cancelledAt: at(9), gateways: ["shopify_payments"], total: "900", received: "900", transactions: [sale("shopify_payments", "900")], refunds: [{ createdAt: at(9, D), total: "900", tax: "0", transactions: [{ kind: "REFUND", status: "SUCCESS", gateway: "shopify_payments", amount: "900" }], lines: [] }] });
    const [d] = run([], [o]);
    expect(net(d!)).toEqual({ ret: 90000n, pre: -90000n });
    expect(d!.cancelled).toBe(0);
  });

  it("orders placed before the first day are left out", () => {
    const o = order({ id: "c5", createdAt: "2026-09-20T10:00:00+05:00", cancelledAt: at(10), total: "900" });
    expect(run([], [o])).toEqual([]);
  });
});

describe("refunds", () => {
  it("refund with its own tax, paid back by the gateway; restocked item reverses its cost", () => {
    const o = order({
      id: "r1",
      createdAt: at(10, "2026-10-03"),
      gateways: ["shopify_payments"],
      total: "1150",
      received: "1150",
      tax: "150",
      transactions: [sale("shopify_payments", "1150")],
      refunds: [{ createdAt: at(9), total: "575", tax: "75", transactions: [{ kind: "REFUND", status: "SUCCESS", gateway: "shopify_payments", amount: "575" }], lines: [{ quantity: 1, restock: true, giftCard: false, total: "500", unitCost: "200" }] }],
    });
    const [d] = run([], [o]);
    expect(net(d!)).toEqual({ ret: 50000n, tax: 7500n, pre: -57500n, stock: 20000n, cogs: -20000n });
    expect(d!.refunds).toBe(1);
  });

  it("refund without restock (damaged, kept by customer): the cost stays", () => {
    const o = order({ id: "r2", createdAt: at(10, "2026-10-03"), total: "500", refunds: [{ createdAt: at(9), total: "500", tax: "0", transactions: [], lines: [{ quantity: 1, restock: false, giftCard: false, total: "500", unitCost: "200" }] }] });
    const [d] = run([], [o]);
    expect(net(d!)).toEqual({ ret: 50000n, cod: -50000n });
  });

  it("a cancelled order that was paid and refunded is counted once (through its refund)", () => {
    const o = order({ id: "r3", createdAt: at(10, "2026-10-05"), cancelledAt: at(10), gateways: ["shopify_payments"], total: "800", received: "800", transactions: [sale("shopify_payments", "800")], refunds: [{ createdAt: at(10), total: "800", tax: "0", transactions: [{ kind: "REFUND", status: "SUCCESS", gateway: "shopify_payments", amount: "800" }], lines: [] }] });
    const [d] = run([], [o]);
    expect(net(d!)).toEqual({ ret: 80000n, pre: -80000n });
  });

  it("test orders and duplicates are ignored; empty days produce nothing", () => {
    const o = order({ id: "t1", total: "100" });
    const out = run([o, o, order({ id: "t2", total: "999", test: true })], [], ["2026-10-06", D]);
    expect(out).toHaveLength(1);
    expect(out[0]!.orders).toBe(1);
  });
});

describe("every random day balances", () => {
  it("300 random orders with partial payments, gift cards, cancels, refunds and restocks", () => {
    let seed = 11;
    const r = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const money = (n: number) => n.toFixed(2);
    const placed: ShopOrder[] = [];
    for (let i = 0; i < 300; i++) {
      const total = Math.floor(r() * 500000) / 100;
      const paid = r() < 0.4 ? total : r() < 0.5 ? Math.floor(total * r() * 100) / 100 : 0;
      const created = new Date(Date.parse("2026-10-05T00:00:00+05:00") + Math.floor(r() * 3 * 86400000)).toISOString();
      const restock = r() < 0.5;
      placed.push(
        order({
          id: `x${i}`,
          createdAt: created,
          gateways: paid > 0 ? ["shopify_payments", "Cash on Delivery (COD)"] : ["Cash on Delivery (COD)"],
          total: money(total),
          received: money(paid),
          discounts: money(total * 0.1),
          shipping: r() < 0.5 ? "200" : "0",
          tax: money(total * 0.05),
          transactions: paid > 0 ? [sale("shopify_payments", money(paid))] : [],
          lines: [line(1 + Math.floor(r() * 3), money(total * 0.8), r() < 0.8 ? money(total * 0.3) : null), ...(r() < 0.05 ? [line(1, "1000", null, true)] : [])],
          cancelledAt: r() < 0.15 ? "2026-10-07T20:00:00+05:00" : null,
          refunds:
            r() < 0.15
              ? [{ createdAt: "2026-10-07T21:00:00+05:00", total: money(paid * 0.5), tax: money(paid * 0.02), transactions: [{ kind: "REFUND", status: "SUCCESS", gateway: "shopify_payments", amount: money(paid * 0.5) }], lines: [{ quantity: 1, restock, giftCard: false, total: money(total * 0.4), unitCost: money(total * 0.1) }] }]
              : [],
        }),
      );
    }
    const out = run(placed, placed, ["2026-10-05", "2026-10-06", D], "2026-10-01", { ...M, costFallbackPercent: 35 });
    expect(out.length).toBe(3);
    for (const d of out) expect(balanced(d)).toBe(true);
  });
});

describe("toShopOrder (Shopify GraphQL → order)", () => {
  it("maps transactions, lines, refunds with exact tax and restock types", () => {
    const o = toShopOrder({
      id: "gid://shopify/Order/1",
      name: "#1001",
      createdAt: "2026-10-01T10:00:00Z",
      cancelledAt: null,
      test: false,
      paymentGatewayNames: ["shopify_payments"],
      totalPriceSet: { shopMoney: { amount: "1150.00", currencyCode: "PKR" } },
      totalReceivedSet: { shopMoney: { amount: "1150.00" } },
      totalDiscountsSet: { shopMoney: { amount: "0.0" } },
      totalShippingPriceSet: { shopMoney: { amount: "0.0" } },
      totalTaxSet: { shopMoney: { amount: "150.00" } },
      transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "1150.00" } } }],
      lineItems: { nodes: [{ id: "gid://shopify/LineItem/71", sku: "TEE-M", title: "Tee", variantTitle: "M", quantity: 2, isGiftCard: false, discountedTotalSet: { shopMoney: { amount: "1000.0" } }, variant: { id: "gid://shopify/ProductVariant/81", inventoryItem: { unitCost: { amount: "300.0" } } } }, { quantity: 1, isGiftCard: false, discountedTotalSet: { shopMoney: { amount: "0" } }, variant: null }] },
      refunds: [
        {
          createdAt: "2026-10-02T00:00:00Z",
          totalRefundedSet: { shopMoney: { amount: "575.00" } },
          transactions: { nodes: [{ kind: "REFUND", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "575.00" } } }] },
          refundLineItems: { nodes: [{ quantity: 1, restockType: "RETURN", subtotalSet: { shopMoney: { amount: "500.0" } }, totalTaxSet: { shopMoney: { amount: "37.5" } }, lineItem: { id: "gid://shopify/LineItem/71", isGiftCard: false, variant: { inventoryItem: { unitCost: { amount: "300.0" } } } } }, { quantity: 1, restockType: "NO_RESTOCK", subtotalSet: { shopMoney: { amount: "0" } }, totalTaxSet: { shopMoney: { amount: "37.5" } }, lineItem: { isGiftCard: false, variant: null } }] },
        },
      ],
    });
    expect(o.received).toBe("1150.00");
    expect(o.lines).toEqual([
      { quantity: 2, giftCard: false, total: "1000.0", unitCost: "300.0", lineId: "gid://shopify/LineItem/71", variantId: "gid://shopify/ProductVariant/81", sku: "TEE-M", title: "Tee / M" },
      { quantity: 1, giftCard: false, total: "0", unitCost: null, lineId: null, variantId: null, sku: null, title: null },
    ]);
    expect(o.refunds[0]!.lines[0]!.lineId).toBe("gid://shopify/LineItem/71");
    expect(o.refunds[0]!.tax).toBe("75.000000");
    expect(o.refunds[0]!.lines.map((l) => [l.restock, l.unitCost])).toEqual([[true, "300.0"], [false, null]]);
    expect(o.refunds[0]!.transactions[0]).toMatchObject({ kind: "REFUND", gateway: "shopify_payments", amount: "575.00" });
  });
});

describe("zonedDayStart", () => {
  it("finds local midnight in UTC", () => {
    expect(zonedDayStart(D, "Asia/Karachi").toISOString()).toBe("2026-10-06T19:00:00.000Z");
    expect(zonedDayStart("2026-03-30", "Europe/London").toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });
});

describe("cancelled before shipping", () => {
  const cancelRestock = (day: string, qty: number) => ({ createdAt: at(16, day), total: "0.00", tax: "0", transactions: [], lines: [{ quantity: qty, restock: true, giftCard: false, total: "0", unitCost: "300.00" }] });
  const sumAll = (days: ReturnType<typeof run>) => days.reduce((acc, d) => { for (const [k, v] of Object.entries(net(d))) acc[k] = (acc[k] ?? 0n) + v; return acc; }, {} as Record<string, bigint>);

  it("never shipped, not restocked in Shopify: all its cost goes back anyway", () => {
    const o = order({ id: "c1", total: "1000", shipped: false, cancelledAt: at(16, "2026-10-08"), lines: [line(2, "1000", "300.00")] });
    const all = sumAll(run([o], [o], ["2026-10-07", "2026-10-08"]));
    expect(all.cogs ?? 0n).toBe(0n);
    expect(all.stock ?? 0n).toBe(0n);
    expect(all.cod ?? 0n).toBe(0n);
  });

  it("never shipped, restocked in Shopify: the cost goes back once", () => {
    const o = order({ id: "c2", total: "1000", shipped: false, cancelledAt: at(16, "2026-10-08"), lines: [line(2, "1000", "300.00")], refunds: [cancelRestock("2026-10-08", 2)] });
    expect(sumAll(run([o], [o], ["2026-10-07", "2026-10-08"])).cogs ?? 0n).toBe(0n);
    const part = order({ id: "c3", total: "1000", shipped: false, cancelledAt: at(16, "2026-10-08"), lines: [line(2, "1000", "300.00")], refunds: [cancelRestock("2026-10-08", 1)] });
    expect(sumAll(run([part], [part], ["2026-10-07", "2026-10-08"])).cogs ?? 0n).toBe(0n);
  });

  it("shipped (or unknown) and cancelled without a restock keeps its cost, as before", () => {
    for (const shipped of [true, undefined]) {
      const o = order({ id: `c4${shipped}`, total: "1000", shipped, cancelledAt: at(16, "2026-10-08"), lines: [line(2, "1000", "300.00")] });
      expect(sumAll(run([o], [o], ["2026-10-07", "2026-10-08"])).cogs).toBe(60000n);
    }
  });

  it("a prepaid order cancelled before shipping still gets its cost back (the money comes back by refund)", () => {
    const o = order({ id: "c5", total: "1000", received: "1000", gateways: ["Shopify Payments"], transactions: [sale("Shopify Payments", "1000")], shipped: false, cancelledAt: at(16, "2026-10-08"), lines: [line(2, "1000", "300.00")] });
    const d = run([o], [o], ["2026-10-07", "2026-10-08"]);
    expect(sumAll(d).cogs ?? 0n).toBe(0n);
    expect(d[1]!.memo).toContain("1 cancelled");
  });

  it("reads 'shipped' from Shopify's fulfilments", () => {
    const base = { id: "x", name: "#x", createdAt: at(10), totalPriceSet: { shopMoney: { amount: "1" } }, lineItems: { nodes: [] }, refunds: [] };
    expect(toShopOrder({ ...base, fulfillments: [] }).shipped).toBe(false);
    expect(toShopOrder({ ...base, fulfillments: [{ status: "CANCELLED" }] }).shipped).toBe(false);
    expect(toShopOrder({ ...base, fulfillments: [{ status: "SUCCESS" }] }).shipped).toBe(true);
    expect(toShopOrder(base).shipped).toBeUndefined();
  });
});

describe("orders edited in Shopify", () => {
  // Shopify records items removed from an unpaid order as a refund of 0 that lists them.
  const edit = (day: string, value: string, tax = "0") => ({ createdAt: at(15, day), total: "0.00", tax, transactions: [], lines: [{ quantity: 1, restock: true, giftCard: false, total: value, unitCost: "800.00" }] });

  it("items removed from an unpaid order come off the sale and what the courier owes, on the edit day", () => {
    const o = order({ id: "e1", total: "7246", lines: [line(1, "1999", "1200"), line(1, "1499", "800"), line(1, "1999", "1200"), line(1, "1749", "800")], refunds: [edit("2026-10-08", "3498")] });
    const [placedDay, editDay] = run([o], [o], ["2026-10-07", "2026-10-08"]);
    expect(net(placedDay!).cod).toBe(724600n);
    expect(net(editDay!)).toMatchObject({ ret: 349800n, cod: -349800n, stock: 80000n, cogs: -80000n });
    expect(balanced(editDay!)).toBe(true);
  });

  it("an edited order cancelled later: the two together take off exactly the order, once", () => {
    const o = order({ id: "e2", total: "1000", cancelledAt: at(16, "2026-10-08"), lines: [line(1, "600", "100"), line(1, "400", "100")], refunds: [edit("2026-10-07", "400"), { ...edit("2026-10-08", "600"), createdAt: at(16, "2026-10-08") }] });
    const days = run([o], [o], ["2026-10-07", "2026-10-08"]);
    const all = days.reduce((acc, d) => { for (const [k, v] of Object.entries(net(d))) acc[k] = (acc[k] ?? 0n) + v; return acc; }, {} as Record<string, bigint>);
    expect(all.cod ?? 0n).toBe(0n);
    expect(all.ret).toBe(100000n);
  });

  it("paid orders aren't touched (a return with a restocking fee keeps its fee as a sale)", () => {
    const o = order({ id: "e3", total: "1000", received: "1000", gateways: ["Shopify Payments"], transactions: [sale("Shopify Payments", "1000")], lines: [line(1, "1000", "300")], refunds: [{ createdAt: at(12, "2026-10-08"), total: "900.00", tax: "0", transactions: [{ kind: "REFUND", status: "SUCCESS", gateway: "Shopify Payments", amount: "900.00" }], lines: [{ quantity: 1, restock: true, giftCard: false, total: "1000", unitCost: "300" }] }] });
    const [, refundDay] = run([o], [o], ["2026-10-07", "2026-10-08"]);
    expect(net(refundDay!)).toMatchObject({ ret: 90000n, pre: -90000n });
  });

  it("a returned parcel on an edited order takes off only what's left", () => {
    const o = order({ id: "e4", total: "7246", createdAt: at(10, "2026-10-03"), lines: [line(2, "3998", "1200"), line(2, "3248", "800")], refunds: [edit("2026-10-04", "3498")] });
    const ev = parcelChanges({ orders: [o], statusOf: new Map([["e4", "RETURNED"]]), active: new Map(), from: "2026-10-07", to: "2026-10-07", startDate: "2026-10-01", timeZone: TZ, decimals: 2, mapping: M });
    expect(ev[0]!.lines.cod).toBe("-374800");
  });
});

describe("parcels that come back", () => {
  const P = (o: Parameters<typeof parcelChanges>[0]) => parcelChanges(o);
  const base = { from: "2026-10-07", to: "2026-10-07", startDate: "2026-10-01", timeZone: TZ, decimals: 2, mapping: M };
  const cod = (id: string, extra: Partial<ShopOrder> = {}) =>
    order({ id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: at(10, "2026-10-03"), total: "1150.00", tax: "150.00", shipping: "0", lines: [line(2, "1000.00", "300.00")], ...extra });
  const status = (id: string, s: string) => new Map([[id, s]]);

  it("statuses match the dashboard's returned list, without cancelled", () => {
    for (const s of ["RETURNED", "failed_delivery", "RTO", "Return In Transit", "UNDELIVERED", "REFUSED"]) expect(isReturnedStatus(s)).toBe(true);
    for (const s of ["CANCELLED", "DELIVERED", "IN_TRANSIT", "", null]) expect(isReturnedStatus(s)).toBe(false);
    expect(legacyOrderId("gid://shopify/Order/123")).toBe("123");
  });

  it("a returned COD parcel takes the sale off the courier and puts the stock back", () => {
    const ev = P({ ...base, orders: [cod("1")], statusOf: status("1", "FAILED_DELIVERY"), active: new Map() });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "returned", day: "2026-10-07", orderName: "#1" });
    expect(ev[0]!.lines).toEqual({ ret: "100000", tax: "15000", cod: "-115000", stock: "60000", cogs: "-60000" });
    expect(Object.values(ev[0]!.lines).reduce((a, b) => a + BigInt(b), 0n)).toBe(0n);
  });

  it("a parcel placed inside the days goes on its own order day (matches the dashboard's month)", () => {
    const ev = P({ ...base, from: "2026-10-01", to: "2026-10-07", orders: [cod("1")], statusOf: status("1", "RETURNED"), active: new Map() });
    expect(ev[0]!.day).toBe("2026-10-03");
  });

  it("only the unpaid part comes back (advance paid stays); prepaid parcels are skipped", () => {
    const part = cod("2", { received: "150.00", transactions: [sale("JazzCash", "150.00")] });
    const ev = P({ ...base, orders: [part], statusOf: status("2", "RETURNED"), active: new Map() });
    expect(ev[0]!.lines.cod).toBe("-100000");
    const paid = cod("3", { received: "1150.00", gateways: ["Shopify Payments"], transactions: [sale("Shopify Payments", "1150.00")] });
    expect(P({ ...base, orders: [paid], statusOf: status("3", "RETURNED"), active: new Map() })).toEqual([{ orderId: paid.id, orderName: "#3", day: "2026-10-07", kind: "skip", lines: {} }]);
  });

  it("orders Shopify already cancelled or refunded are skipped (their own rules apply)", () => {
    const cancelled = cod("4", { cancelledAt: at(12, "2026-10-05") });
    expect(P({ ...base, orders: [cancelled], statusOf: status("4", "RETURNED"), active: new Map() })[0]!.kind).toBe("skip");
  });

  it("a later Shopify cancellation undoes the return on the cancellation day", () => {
    const later = cod("5", { cancelledAt: at(12, "2026-10-06") });
    const ev = P({ ...base, from: "2026-10-01", to: "2026-10-07", orders: [later], statusOf: status("5", "RETURNED"), active: new Map() });
    expect(ev.map((e) => [e.kind, e.day])).toEqual([["returned", "2026-10-03"], ["reinstated", "2026-10-06"], ["skip", "2026-10-07"]]);
    expect(ev[1]!.lines).toEqual(negateLines(ev[0]!.lines));
    // Cancelled after the days being brought in: return now, undo later.
    const ev2 = P({ ...base, from: "2026-10-01", to: "2026-10-05", orders: [later], statusOf: status("5", "RETURNED"), active: new Map() });
    expect(ev2.map((e) => e.kind)).toEqual(["returned"]);
    const active = new Map([[later.id, { lines: ev2[0]!.lines, orderName: "#5" }]]);
    const ev3 = P({ ...base, from: "2026-10-06", to: "2026-10-06", orders: [later], statusOf: status("5", "RETURNED"), active });
    expect(ev3).toEqual([{ orderId: later.id, orderName: "#5", day: "2026-10-06", kind: "reinstated", lines: negateLines(ev2[0]!.lines) }]);
  });

  it("delivered after all: undone without needing the order from Shopify", () => {
    const lines = { ret: "100", cod: "-100" };
    const ev = P({ ...base, orders: [], statusOf: status("6", "DELIVERED"), active: new Map([["gid://shopify/Order/6", { lines, orderName: "#6" }]]) });
    expect(ev).toEqual([{ orderId: "gid://shopify/Order/6", orderName: "#6", day: "2026-10-07", kind: "reinstated", lines: { ret: "-100", cod: "100" } }]);
    // Still returned, or in transit again: nothing changes.
    expect(P({ ...base, orders: [], statusOf: status("6", "IN_TRANSIT"), active: new Map([["gid://shopify/Order/6", { lines, orderName: "#6" }]]) })).toEqual([]);
  });

  it("already returned in the books: not returned twice", () => {
    const o = cod("7");
    expect(P({ ...base, orders: [o], statusOf: status("7", "RETURNED"), active: new Map([[o.id, { lines: { ret: "1", cod: "-1" }, orderName: "#7" }]]) })).toEqual([]);
  });

  it("orders before the first day, after the last day, and test orders are left alone", () => {
    const early = cod("8", { createdAt: at(10, "2026-09-20") });
    const late = cod("9", { createdAt: at(10, "2026-10-09") });
    const test = cod("10", { test: true });
    const statusOf = new Map([["8", "RETURNED"], ["9", "RETURNED"], ["10", "RETURNED"]]);
    // The early one is remembered as settled so it isn't fetched again; the later one waits.
    expect(P({ ...base, orders: [early, late, test], statusOf, active: new Map() })).toEqual([{ orderId: early.id, orderName: "#8", day: "2026-10-07", kind: "skip", lines: {} }]);
  });

  it("no cost tracking: only the sale comes back; fallback % estimates missing costs", () => {
    const o = cod("11", { lines: [line(1, "1000.00", null)] });
    expect(parcelReturnLines(o, { ...M, cogs: "", stock: "" }, 2)).toEqual({ ret: "100000", tax: "15000", cod: "-115000" });
    expect(parcelReturnLines(o, { ...M, costFallbackPercent: 40 }, 2)).toMatchObject({ stock: "40000", cogs: "-40000" });
  });

  it("a zero-amount restock refund (no cancel) leaves the sale owed: the parcel takes the sale off, not the cost again", () => {
    const restock = { createdAt: at(9, "2026-10-04"), total: "0.00", tax: "0", transactions: [], lines: [{ quantity: 2, restock: true, giftCard: false, total: "0", unitCost: "300.00" }] };
    const o = cod("20", { refunds: [restock] });
    const ev = P({ ...base, orders: [o], statusOf: status("20", "RETURNED"), active: new Map() });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.lines).toEqual({ ret: "100000", tax: "15000", cod: "-115000" });
  });

  it("a restock refund after the return: Books' restock is taken back, the sale stays off", () => {
    const o = cod("21", { refunds: [{ createdAt: at(9, "2026-10-07"), total: "0.00", tax: "0", transactions: [], lines: [{ quantity: 2, restock: true, giftCard: false, total: "0", unitCost: "300.00" }] }] });
    const was = { ret: "100000", tax: "15000", cod: "-115000", stock: "60000", cogs: "-60000" };
    const ev = P({ ...base, orders: [o], statusOf: status("21", "RETURNED"), active: new Map([[o.id, { lines: was, orderName: "#21" }]]) });
    expect(ev).toEqual([{ orderId: o.id, orderName: "#21", day: "2026-10-07", kind: "adjusted", lines: { stock: "-60000", cogs: "60000" } }]);
    // Shopify's restock refund puts the cost back once; with Books' part undone, the cost goes back exactly once.
    const s = summariseDays({ days: [D], timeZone: TZ, startDate: "2026-10-01", decimals: 2, mapping: M, placed: [], changed: [o], parcels: ev });
    expect(s.length === 0 || (net(s[0]!).stock ?? 0n) === 0n).toBe(true); // nets out to nothing: no entry that day
  });

  it("an unpaid refund after the return shrinks Books' part by what Shopify took off", () => {
    const o = cod("22", { refunds: [{ createdAt: at(9, "2026-10-07"), total: "460.00", tax: "60.00", transactions: [], lines: [] }] });
    const was = parcelReturnLines(cod("22"), M, 2)!;
    const ev = P({ ...base, orders: [o], statusOf: status("22", "RETURNED"), active: new Map([[o.id, { lines: was, orderName: "#22" }]]) });
    expect(ev[0]!.kind).toBe("adjusted");
    expect(BigInt(ev[0]!.lines.cod!)).toBe(46000n); // 1150 − 460 = 690 still Books' part
    const s = summariseDays({ days: [D], timeZone: TZ, startDate: "2026-10-01", decimals: 2, mapping: M, placed: [], changed: [o], parcels: ev });
    expect(s.length === 0 || (net(s[0]!).cod ?? 0n) === 0n).toBe(true); // Shopify's refund + Books' adjustment: the courier balance doesn't move twice
  });

  it("courier return tags count as returned, like the dashboard", () => {
    expect(trackingStatus("DELIVERED", "COD, Return to Shipper")).toBe("RETURNED");
    expect(trackingStatus("IN_TRANSIT", ["Refused to Accept"])).toBe("RETURNED");
    expect(trackingStatus("IN_TRANSIT", "")).toBe("IN_TRANSIT");
  });

  it("parcel events land in the day's summary, balanced, with a note", () => {
    const ev = P({ ...base, orders: [cod("12")], statusOf: status("12", "RETURNED"), active: new Map() });
    const s = summariseDays({ days: [D], timeZone: TZ, startDate: "2026-10-01", decimals: 2, mapping: M, placed: [], changed: [], parcels: ev });
    expect(s).toHaveLength(1);
    expect(balanced(s[0]!)).toBe(true);
    expect(net(s[0]!)).toMatchObject({ ret: 100000n, cod: -115000n, stock: 60000n });
    expect(s[0]!.memo).toContain("1 parcel came back");
    expect(s[0]!.parcelsBack).toBe(1);
    // Return then undo nets to nothing.
    const both = [...ev, { ...ev[0]!, kind: "reinstated" as const, lines: negateLines(ev[0]!.lines) }];
    expect(summariseDays({ days: [D], timeZone: TZ, startDate: "2026-10-01", decimals: 2, mapping: M, placed: [], changed: [], parcels: both })).toEqual([]);
  });
});

describe("holding COD sales until dispatched or delivered", () => {
  const MH: SalesMapping = { ...M, codBasis: "dispatch", held: "held" };
  const base = { from: "2026-10-01", to: "2026-10-07", startDate: "2026-10-01", timeZone: TZ, decimals: 2, mapping: MH };
  const cod = (id: string, extra: Partial<ShopOrder> = {}) =>
    order({ id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: at(10, "2026-10-03"), total: "1150.00", tax: "150.00", lines: [line(2, "1000.00", "300.00")], ...extra });
  const hold = (on: Record<string, string> = {}, allOut = false) => ({ account: "held", onDay: new Map(Object.entries(on)), allOut });
  const sum = (ls: Record<string, string>[]) => {
    const t: Record<string, bigint> = {};
    for (const l of ls) for (const [k, v] of Object.entries(l)) t[k] = (t[k] ?? 0n) + BigInt(v);
    return Object.fromEntries(Object.entries(t).filter(([, v]) => v !== 0n));
  };

  it("held on its order day, let in on its loadsheet's day — the sale moves, nothing else", () => {
    const ev = parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: hold({ "1": "2026-10-05" }) });
    expect(ev.map((e) => [e.kind, e.day])).toEqual([["held", "2026-10-03"], ["released", "2026-10-05"]]);
    expect(ev[0]!.lines).toEqual({ held: "100000", tax: "15000", cod: "-115000", stock: "60000", cogs: "-60000" });
    expect(ev[1]!.lines).toEqual(negateLines(ev[0]!.lines));
    // With the day's sale it nets to nothing on the order day: the sale lands on the 5th.
    const days = summariseDays({ days: ["2026-10-03", "2026-10-05"], timeZone: TZ, startDate: "2026-10-01", decimals: 2, mapping: MH, placed: [cod("1")], changed: [], parcels: ev });
    const n3 = net(days[0]!);
    expect(n3.sales! + n3.held!).toBe(0n);
    expect(n3.cod ?? 0n).toBe(0n);
    expect(n3.cogs ?? 0n).toBe(0n);
    expect(days[0]!.memo).toMatch(/1 COD order held until dispatched/);
    expect(net(days[1]!)).toMatchObject({ held: -100000n, cod: 115000n, cogs: 60000n });
    expect(days[1]!.memo).toMatch(/1 dispatched/);
  });

  it("dispatched the same day it was ordered: nothing held at all", () => {
    expect(parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: hold({ "1": "2026-10-03" }) })).toEqual([]);
  });

  it("not yet out by the last day brought in: stays held, and is let in by a later run", () => {
    const ev = parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: hold() });
    expect(ev.map((e) => e.kind)).toEqual(["held"]);
    const active = new Map([[cod("1").id, { lines: ev[0]!.lines, orderName: "#1" }]]);
    // A later run: the loadsheet (dated the 9th) arrived; no Shopify data needed to let it in.
    const later = parcelChanges({ ...base, from: "2026-10-08", to: "2026-10-12", orders: [], statusOf: new Map(), active, hold: hold({ "1": "2026-10-09" }) });
    expect(later).toEqual([{ orderId: cod("1").id, orderName: "#1", day: "2026-10-09", kind: "released", lines: negateLines(ev[0]!.lines) }]);
    // Loadsheet dated before the days being brought in (uploaded late): let in on the first new day.
    const late = parcelChanges({ ...base, from: "2026-10-08", to: "2026-10-12", orders: [], statusOf: new Map(), active, hold: hold({ "1": "2026-10-04" }) });
    expect(late[0]!.day).toBe("2026-10-08");
  });

  it("cancelled before it went out: taken off once (Shopify's cancellation), never counted", () => {
    const o = cod("1", { cancelledAt: at(12, "2026-10-05"), shipped: false });
    const ev = parcelChanges({ ...base, orders: [o], statusOf: new Map(), active: new Map(), hold: hold() });
    expect(ev.map((e) => [e.kind, e.day])).toEqual([["held", "2026-10-03"], ["adjusted", "2026-10-05"]]);
    const days = summariseDays({ days: ["2026-10-03", "2026-10-05"], timeZone: TZ, startDate: "2026-10-01", decimals: 2, mapping: MH, placed: [o], changed: [o], parcels: ev });
    const total = sum(days.flatMap((d) => [Object.fromEntries(Object.entries(net(d)).map(([k, v]) => [k, v.toString()]))]));
    // Nothing owed, no tax, no cost: the sale and its cancellation cancel out.
    expect(total.cod ?? 0n).toBe(0n);
    expect(total.tax ?? 0n).toBe(0n);
    expect(total.cogs ?? 0n).toBe(0n);
    expect(total.held ?? 0n).toBe(0n);
    expect((total.sales ?? 0n) + (total.ret ?? 0n)).toBe(0n);
  });

  it("returned after it went out: let in, then taken off as a return", () => {
    const ev = parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map([["1", "RETURNED"]]), active: new Map(), hold: hold({ "1": "2026-10-04" }) });
    // Returned status wins for every day looked at: it goes straight to returns (held never needed).
    expect(ev.map((e) => e.kind)).toEqual(["returned"]);
    expect(ev[0]!.lines.ret).toBe("100000");
  });

  it("held, then returned without ever being on a loadsheet: moved from held to returns", () => {
    const first = parcelChanges({ ...base, to: "2026-10-04", orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: hold() });
    const active = new Map([[cod("1").id, { lines: first[0]!.lines, orderName: "#1" }]]);
    const ev = parcelChanges({ ...base, from: "2026-10-05", to: "2026-10-07", orders: [cod("1")], statusOf: new Map([["1", "RETURNED"]]), active, hold: hold() });
    expect(ev.map((e) => e.kind)).toEqual(["adjusted"]);
    expect(sum([first[0]!.lines, ev[0]!.lines])).toEqual({ ret: 100000n, tax: 15000n, cod: -115000n, stock: 60000n, cogs: -60000n });
  });

  it("delivery basis: tracking that says delivered lets it in", () => {
    const ev = parcelChanges({ ...base, mapping: { ...MH, codBasis: "delivery" }, orders: [cod("1")], statusOf: new Map([["1", "DELIVERED"]]), active: new Map(), hold: hold() });
    expect(ev).toEqual([]);
  });

  it("prepaid orders are never held; an advance paid stays, only the COD part waits", () => {
    const paid = cod("2", { received: "1150.00", gateways: ["Shopify Payments"], transactions: [sale("Shopify Payments", "1150.00")] });
    expect(parcelChanges({ ...base, orders: [paid], statusOf: new Map(), active: new Map(), hold: hold() })).toEqual([]);
    const part = cod("3", { received: "150.00", transactions: [sale("JazzCash", "150.00")] });
    expect(parcelChanges({ ...base, orders: [part], statusOf: new Map(), active: new Map(), hold: hold() })[0]!.lines.cod).toBe("-100000");
  });

  it("switching back to 'when ordered' lets everything held in on the next day", () => {
    const first = parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: hold() });
    const active = new Map([[cod("1").id, { lines: first[0]!.lines, orderName: "#1" }]]);
    const ev = parcelChanges({ ...base, mapping: { ...MH, codBasis: "order" }, from: "2026-10-08", to: "2026-10-08", orders: [], statusOf: new Map(), active, hold: hold({}, true) });
    expect(ev).toEqual([{ orderId: cod("1").id, orderName: "#1", day: "2026-10-08", kind: "released", lines: negateLines(first[0]!.lines) }]);
  });
});

describe("holding sales until their money arrives", () => {
  const MM: SalesMapping = { ...M, codBasis: "money", held: "held", gateways: { manual: "bankRecv" } };
  const base = { from: "2026-10-01", to: "2026-10-07", startDate: "2026-10-01", timeZone: TZ, decimals: 2, mapping: MM };
  const cod = (id: string, extra: Partial<ShopOrder> = {}) =>
    order({ id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: at(10, "2026-10-03"), total: "1150.00", tax: "150.00", lines: [line(2, "1000.00", "300.00")], ...extra });
  const money = (on: Record<string, string> = {}) => ({ account: "held", onDay: new Map(Object.entries(on)), deliveredReleases: false });

  it("delivered isn't paid: tracking that says delivered doesn't let it in", () => {
    const ev = parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map([["1", "DELIVERED"]]), active: new Map(), hold: money() });
    expect(ev.map((e) => e.kind)).toEqual(["held"]);
    // …and a later run with tracking still delivered and no money: still held.
    const active = new Map([[cod("1").id, { lines: ev[0]!.lines, orderName: "#1" }]]);
    expect(parcelChanges({ ...base, from: "2026-10-08", to: "2026-10-12", orders: [cod("1")], statusOf: new Map([["1", "DELIVERED"]]), active, hold: money() })).toEqual([]);
    expect(parcelChanges({ ...base, from: "2026-10-08", to: "2026-10-12", orders: [], statusOf: new Map([["1", "DELIVERED"]]), active, hold: money() })).toEqual([]);
  });

  it("let in on the payment day, with Shopify data or without", () => {
    const ev = parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map([["1", "DELIVERED"]]), active: new Map(), hold: money({ "1": "2026-10-06" }) });
    expect(ev.map((e) => [e.kind, e.day])).toEqual([["held", "2026-10-03"], ["released", "2026-10-06"]]);
    const first = parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: money() });
    const active = new Map([[cod("1").id, { lines: first[0]!.lines, orderName: "#1" }]]);
    const later = parcelChanges({ ...base, from: "2026-10-08", to: "2026-10-20", orders: [], statusOf: new Map([["1", "DELIVERED"]]), active, hold: money({ "1": "2026-10-15" }) });
    expect(later).toEqual([{ orderId: cod("1").id, orderName: "#1", day: "2026-10-15", kind: "released", lines: negateLines(first[0]!.lines) }]);
    // Paid before the days being brought in (a settlement imported late): on the first new day.
    expect(parcelChanges({ ...base, from: "2026-10-08", to: "2026-10-20", orders: [], statusOf: new Map(), active, hold: money({ "1": "2026-10-02" }) })[0]!.day).toBe("2026-10-08");
  });

  it("paid the day it was ordered: never held", () => {
    expect(parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: money({ "1": "2026-10-03" }) })).toEqual([]);
  });

  it("held, then came back: moved from held to returns, never a sale", () => {
    const first = parcelChanges({ ...base, to: "2026-10-04", orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: money() });
    const active = new Map([[cod("1").id, { lines: first[0]!.lines, orderName: "#1" }]]);
    const ev = parcelChanges({ ...base, from: "2026-10-05", to: "2026-10-07", orders: [cod("1")], statusOf: new Map([["1", "RETURNED"]]), active, hold: money() });
    expect(ev.map((e) => e.kind)).toEqual(["adjusted"]);
  });

  it("paid in full at checkout counts when ordered; manual and bank-transfer orders wait like COD", () => {
    const prepaid = cod("2", { received: "1150.00", gateways: ["Shopify Payments"], transactions: [sale("Shopify Payments", "1150.00")] });
    expect(parcelChanges({ ...base, orders: [prepaid], statusOf: new Map(), active: new Map(), hold: money() })).toEqual([]);
    const manual = cod("3", { gateways: ["manual"] });
    const ev = parcelChanges({ ...base, orders: [manual], statusOf: new Map(), active: new Map(), hold: money() });
    expect(ev[0]!.kind).toBe("held");
    expect(ev[0]!.lines.bankRecv).toBe("-115000");
    // An advance paid upfront stays a sale; only the part still to pay waits.
    const part = cod("4", { received: "150.00", transactions: [sale("JazzCash", "150.00")] });
    expect(parcelChanges({ ...base, orders: [part], statusOf: new Map(), active: new Map(), hold: money() })[0]!.lines.cod).toBe("-100000");
  });

  it("the day's memo says paid, not dispatched", () => {
    const ev = parcelChanges({ ...base, orders: [cod("1")], statusOf: new Map(), active: new Map(), hold: money({ "1": "2026-10-05" }) });
    const days = summariseDays({ days: ["2026-10-03", "2026-10-05"], timeZone: TZ, startDate: "2026-10-01", decimals: 2, mapping: MM, placed: [cod("1")], changed: [], parcels: ev });
    expect(days[0]!.memo).toMatch(/1 unpaid order held until paid/);
    expect(days[1]!.memo).toMatch(/1 paid/);
  });

  it("dispatch and delivery bases still let a delivered parcel in (deliveredReleases unset)", () => {
    const MH: SalesMapping = { ...MM, codBasis: "delivery" };
    expect(parcelChanges({ ...base, mapping: MH, orders: [cod("1")], statusOf: new Map([["1", "DELIVERED"]]), active: new Map(), hold: { account: "held", onDay: new Map() } })).toEqual([]);
  });
});

describe("costs at sale (Financify's order records)", () => {
  const o = (lines: ShopOrder["lines"], refunds: ShopOrder["refunds"] = []) => order({ id: "1", total: "1000", lines, refunds });
  const L = (p: Partial<ShopOrder["lines"][number]>) => ({ quantity: 1, total: "500", unitCost: null, giftCard: false, ...p });

  it("matches by line id, then variant, SKU, title — each stored line used once", () => {
    const r = applyStoredCosts(
      o([L({ lineId: "gid://shopify/LineItem/11" }), L({ variantId: "gid://shopify/ProductVariant/22" }), L({ sku: "abc-1" }), L({ title: "Shirt / M" })]),
      [
        { title: "Shirt", variantTitle: "M", unitCost: 40, quantity: 1 },
        { sku: "ABC-1", unitCost: 30, quantity: 1 },
        { variantId: "gid://shopify/ProductVariant/22", unitCost: "20", quantity: 1 },
        { lineItemId: "11", unitCost: 10, quantity: 1 },
      ],
      "at_sale",
    );
    expect(r.order.lines.map((l) => l.unitCost)).toEqual(["10", "20", "30", "40"]);
    expect(r.filled).toBe(4);
  });
  it("the same variant twice takes two different stored lines", () => {
    const v = "gid://shopify/ProductVariant/5";
    const r = applyStoredCosts(o([L({ variantId: v }), L({ variantId: v })]), [{ variantId: "5", unitCost: 7 }, { variantId: "5", unitCost: 9 }], "at_sale");
    expect(r.order.lines.map((l) => l.unitCost)).toEqual(["7", "9"]);
  });
  it("by position only when both lists line up (a variant deleted and recreated)", () => {
    const lines = [L({ variantId: "gid://shopify/ProductVariant/900", quantity: 2 }), L({ variantId: "gid://shopify/ProductVariant/901" })];
    const same = applyStoredCosts(o(lines), [{ variantId: "100", quantity: 2, unitCost: 50 }, { variantId: "101", quantity: 1, unitCost: 60 }], "at_sale");
    expect(same.order.lines.map((l) => l.unitCost)).toEqual(["50", "60"]);
    const off = applyStoredCosts(o(lines), [{ variantId: "100", quantity: 3, unitCost: 50 }, { variantId: "101", quantity: 1, unitCost: 60 }], "at_sale");
    expect(off.order.lines.map((l) => l.unitCost)).toEqual([null, null]);
  });
  it("modes: at sale first, or Shopify first — each fills the other's gaps; zero means unknown", () => {
    const lines = [L({ lineId: "1", unitCost: "100" }), L({ lineId: "2", unitCost: null }), L({ lineId: "3", unitCost: "0" }), L({ lineId: "4", unitCost: "80" })];
    const stored = [{ lineItemId: "1", unitCost: 90 }, { lineItemId: "2", unitCost: 70 }, { lineItemId: "3", unitCost: 0 }, { lineItemId: "4", unitCost: null }];
    const atSale = applyStoredCosts(o(lines), stored, "at_sale");
    expect(atSale.order.lines.map((l) => l.unitCost)).toEqual(["90", "70", null, "80"]);
    expect(atSale.filled).toBe(2);
    const now = applyStoredCosts(o(lines), stored, "shopify_now");
    expect(now.order.lines.map((l) => l.unitCost)).toEqual(["100", "70", null, "80"]);
    expect(now.filled).toBe(1);
  });
  it("gift cards never take a cost; no records leaves the order as it is", () => {
    const g = applyStoredCosts(o([L({ giftCard: true, sku: "GC" })]), [{ sku: "GC", unitCost: 5 }], "at_sale");
    expect(g.order.lines[0]!.unitCost).toBeNull();
    const ord = o([L({ unitCost: "3" })]);
    expect(applyStoredCosts(ord, undefined, "at_sale").order).toBe(ord);
    expect(applyStoredCosts(ord, [], "at_sale").order).toBe(ord);
  });
  it("a refund line takes the cost of the line it refunds, so a restock reverses exactly the cost booked", () => {
    const ord = o([L({ lineId: "gid://shopify/LineItem/7", unitCost: "100" })], [{ createdAt: at(12), total: "500", tax: "0", transactions: [], lines: [{ quantity: 1, restock: true, giftCard: false, total: "500", unitCost: "100", lineId: "gid://shopify/LineItem/7" }] }]);
    const r = applyStoredCosts(ord, [{ lineItemId: "7", unitCost: 60 }], "at_sale");
    expect(r.order.refunds[0]!.lines[0]!.unitCost).toBe("60");
    const n = net(run([r.order])[0]!);
    expect(n.cogs ?? 0n).toBe(0n); // 60 out, 60 back
    expect(n.stock ?? 0n).toBe(0n);
  });
});

describe("manual payments read from delivery tracking", () => {
  const manual = (p: Partial<ShopOrder> = {}) => order({ id: "9", gateways: ["manual"], total: "1000", received: "1000", transactions: [sale("manual", "1000")], lines: [line(1, "1000", "400")], ...p });
  const Mm: SalesMapping = { ...M, gateways: { manual: "cash" }, selfDelivery: "riders" };

  it("a courier delivered it: cash on delivery, owed by the courier", () => {
    const r = routeManualPayment(manual(), "courier");
    expect(r.gateways).toEqual(["Cash on Delivery (COD)"]);
    expect(net(run([r], [], [D], "2026-10-01", Mm)[0]!).cod).toBe(100000n);
  });
  it("your own riders delivered it: the cash they collected", () => {
    const r = routeManualPayment(manual(), "self");
    expect(net(run([r], [], [D], "2026-10-01", Mm)[0]!).riders).toBe(100000n);
    // No self-delivery account set: falls back to where manual payments go.
    expect(net(run([r], [], [D], "2026-10-01", { ...Mm, selfDelivery: undefined })[0]!).cash).toBe(100000n);
  });
  it("unpaid and delivered by a courier: owed by the courier too", () => {
    const r = routeManualPayment(manual({ received: "0", transactions: [] }), "courier");
    expect(net(run([r], [], [D], "2026-10-01", Mm)[0]!).cod).toBe(100000n);
  });
  it("no tracking, mixed gateways, or nothing known: left as mapped", () => {
    expect(routeManualPayment(manual(), "none")).toEqual(manual());
    expect(routeManualPayment(manual(), undefined)).toEqual(manual());
    const mixed = manual({ gateways: ["manual", "Cash on Delivery (COD)"] });
    expect(routeManualPayment(mixed, "courier")).toBe(mixed);
    const withGift = routeManualPayment(manual({ gateways: ["gift_card", "manual"], transactions: [sale("gift_card", "200"), sale("manual", "800")] }), "courier");
    expect(withGift.gateways).toEqual(["gift_card", "Cash on Delivery (COD)"]);
    expect(withGift.transactions.map((t) => t.gateway)).toEqual(["gift_card", "Cash on Delivery (COD)"]);
  });
  it("its refunds move with it", () => {
    const r = routeManualPayment(manual({ refunds: [{ createdAt: at(12), total: "1000", tax: "0", transactions: [{ kind: "REFUND", status: "SUCCESS", gateway: "manual", amount: "1000" }], lines: [] }] }), "courier");
    expect(r.refunds[0]!.transactions[0]!.gateway).toBe("Cash on Delivery (COD)");
  });
});
