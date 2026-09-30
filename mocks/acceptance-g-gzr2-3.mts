/**
 * G-GZR2-3 acceptance: product, city and courier grains, ad spend, profit.
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env mocks/acceptance-g-gzr2-3.mts <shop> <from> <to>
 *
 * Read-only. The grain is computed in memory with the builder the worker
 * stores; ad spend is fetched and parsed exactly as the refresh does, but not
 * written. So it can run before the migration is deployed.
 */
import { prisma } from "../app/lib/db.server.ts";
import { appRequest } from "../app/lib/apps/client.server.ts";
import { getAppCredentials } from "../app/lib/apps/registry.server.ts";
import { computeOrderGrain } from "../app/lib/metrics/order-grain.server.ts";
import { parseAdSpendDay, type AdSpendRow } from "../app/lib/metrics/ad-spend.ts";
import { sumByCurrency, type Money } from "../app/lib/metrics/money.ts";
import {
  bucketOf,
  byCity,
  byCourier,
  byDay,
  courierTiming,
  productLines,
  profitAfterReturns,
  roas,
  rollup,
} from "../app/lib/metrics/rollups.ts";

const [shopArg, from = "2026-09-01", to = "2026-09-22"] = process.argv.slice(2);
const shopDomain = (shopArg ?? "0dscam-qn.myshopify.com").toLowerCase();

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const pct = (x: number | null) => (x === null ? "—" : `${(100 * x).toFixed(1)}%`);
const fmt = (list: Money[]) => list.map((m) => `${m.amount} ${m.currency}`).join(" + ") || "0";

const store = await prisma.store.findUniqueOrThrow({ where: { shopDomain } });
const shop = store.currency!;
const { grain } = await computeOrderGrain(store.id);
const orders = grain.filter((g) => g.localDay && g.localDay >= from && g.localDay <= to);
console.log(`\nG-GZR2-3 against ${shopDomain}, ${from}…${to}: ${orders.length} orders\n`);

// ── Conservation: every breakdown adds back up to the whole ────────────────
console.log("1. Every breakdown adds back up to the whole");
const whole = bucketOf("all", orders);
for (const [name, key] of [["day", byDay], ["city", byCity], ["courier", byCourier]] as const) {
  const parts = rollup(orders, key);
  const n = parts.reduce((a, b) => a + b.orders, 0);
  const placed = sumByCurrency(parts.flatMap((b) => b.placed));
  check(`by ${name}: orders and placed revenue conserved`, n === whole.orders && fmt(placed) === fmt(whole.placed),
    `${parts.length} buckets, ${n} orders, ${fmt(placed)}`);
}
const products = productLines(orders);
const units = orders.flatMap((o) => o.lines).reduce((a, l) => a + l.quantity, 0);
check("by product: units conserved", products.reduce((a, p) => a + p.units, 0) === units, `${products.length} variants, ${units} units`);

// ── Ad spend, fetched and parsed as the refresh does ────────────────────────
console.log("\n2. Ad spend against Financify's own /dashboard");
const days: string[] = [];
for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
  days.push(d.toISOString().slice(0, 10));
}
const credentials = getAppCredentials("FINANCIFY")!;
const adRows: AdSpendRow[] = [];
const dashMismatch: string[] = [];
const dashOriginalSpend: string[] = [];
const allocMismatch: string[] = [];
const allocRounding: string[] = [];
const cents = (x: string | number) => Math.round(Number(x) * 100);
for (const day of days) {
  const r = await appRequest<any>("FINANCIFY", { pathWithQuery: `/api/v1/ad-spend?startDate=${day}&endDate=${day}&include=products`, shopDomain, credentials });
  if (!r.ok) throw new Error(`ad-spend ${day}: ${r.reason}`);
  const { rows, problems } = parseAdSpendDay(day, r.data, shop);
  if (problems.length) console.log(`     ${day}: ${problems.join("; ")}`);
  adRows.push(...rows);

  const dayRow = rows.find((x) => x.level === "day")!;
  const dash = await appRequest<any>("FINANCIFY", { pathWithQuery: `/api/external/dashboard?startDate=${day}&endDate=${day}`, shopDomain, credentials });
  if (dash.ok) {
    const c = dash.data.metrics.costs;
    // /dashboard's adSpend is pre-fee (originalAdSpend), fees separate.
    const feesMatch = Number(c.adFees).toFixed(2) === dayRow.fees.amount;
    if (Number(c.originalAdSpend).toFixed(2) !== dayRow.spend.amount || !feesMatch) {
      // Demonstrate per platform: /dashboard sums the stored originalSpend,
      // /ad-spend computes spend − fees (Financify G-FIN-3). Explained only
      // if every platform gap is that, within the cent, and the fees agree.
      const ours = new Map(rows.filter((x) => x.level === "platform").map((x) => [x.key, x.spend.amount]));
      const gaps = (c.platformBreakdown as any[]).map((p) => cents(ours.get(p.platform) ?? 0) - cents(p.originalSpend));
      if (feesMatch && gaps.every((g) => Math.abs(g) <= 1)) {
        dashOriginalSpend.push(`${day} (${(c.platformBreakdown as any[]).map((p, i) => gaps[i] ? `${p.platform} ${p.originalSpend} vs ${ours.get(p.platform)}` : null).filter(Boolean).join(", ")})`);
      } else {
        dashMismatch.push(`${day}: Growzar ${dayRow.spend.amount}+${dayRow.fees.amount} fees, /dashboard ${Number(c.originalAdSpend).toFixed(2)}+${Number(c.adFees).toFixed(2)}`);
      }
    }
  }
  // Financify's allocation reconciles to its own total.
  const totals = (r.data as any).products?.totals;
  if (totals) {
    const items = rows.filter((x) => x.level === "product");
    const allocated = sumByCurrency(items.map((x) => x.spend));
    const gap = Math.abs(cents(allocated[0]?.amount ?? 0) - cents(totals.allocatedSpend.amount));
    // Each item is rounded to the cent on its own, so the items may miss the
    // unrounded total by at most half a cent per item.
    if (gap > Math.ceil(items.length / 2)) {
      allocMismatch.push(`${day}: items ${allocated[0]?.amount} vs totals ${totals.allocatedSpend.amount}`);
    } else if (gap) {
      allocRounding.push(`${day} ${gap}¢/${items.length} items`);
    }
  }
}
check("day ad spend equals /dashboard's, or differs only by /dashboard's originalSpend path", dashMismatch.length === 0,
  dashMismatch.length ? dashMismatch.slice(0, 3).join(" | ") : `${days.length - dashOriginalSpend.length} days exact, ${dashOriginalSpend.length} one cent apart on a platform`);
if (dashOriginalSpend.length) console.log(`     originalSpend vs spend − fees: ${dashOriginalSpend.join("; ")}`);
check("product allocation adds up to Financify's total within per-item rounding", allocMismatch.length === 0,
  allocMismatch.slice(0, 3).join(" | ") || `${days.length - allocRounding.length} days exact; rounding on ${allocRounding.join(", ") || "none"}`);
const productRows = adRows.filter((r) => r.level === "product");
check("every product ad-spend row is labelled allocated, every platform row measured",
  productRows.every((r) => r.method === "allocated") && adRows.filter((r) => r.level === "platform").every((r) => r.method === "measured"),
  `${productRows.length} product rows`);
const adTotal = sumByCurrency(adRows.filter((r) => r.level === "day").map((r) => r.spend));
const adFees = sumByCurrency(adRows.filter((r) => r.level === "day").map((r) => r.fees));

// ── Profit, ROAS ────────────────────────────────────────────────────────────
console.log("\n3. Profit after returns and ROAS, whole period");
const spendWithFees = sumByCurrency([...adTotal, ...adFees]);
const profit = profitAfterReturns(whole, shop, spendWithFees);
console.log(`     delivered revenue ${profit.parts.deliveredRevenue} − COGS ${profit.parts.cogsDelivered} − courier fees ${profit.parts.courierFees} − ads ${profit.parts.adSpend} = ${profit.amount} ${shop}`);
console.log(`     complete: ${profit.complete}${profit.missing.length ? ` — ${profit.missing.join("; ")}` : ""}`);
console.log(`     ROAS (delivered revenue ÷ ad spend incl. fees): ${roas(whole, spendWithFees, shop)?.toFixed(2)}`);
console.log(`     delivery rate ${pct(whole.deliveryRate.rate)} (${whole.deliveryRate.delivered} delivered, ${whole.deliveryRate.returned} returned, ${whole.deliveryRate.stillOpen} still open)`);
check("profit is marked incomplete when courier fees are missing", whole.shippedOrdersWithoutFee === 0 || !profit.complete,
  `${whole.shippedOrdersWithoutFee} of ${whole.shippedOrders} shipped orders lack a fee`);

// ── City (rule #12) ─────────────────────────────────────────────────────────
console.log("\n4. Cities (canonical, or 'unmapped')");
const cities = rollup(orders, byCity);
for (const c of cities.slice(0, 6)) {
  console.log(`     ${c.key.padEnd(12)} ${String(c.orders).padStart(5)} orders  delivery ${pct(c.deliveryRate.rate).padStart(6)}  (+${c.deliveryRate.stillOpen} open)`);
}
const rawSpellings = new Set(orders.filter((o) => o.city).map((o) => o.cityRaw)).size;
check("cities are canonical names, not raw spellings", cities.length < rawSpellings + 3,
  `${cities.length} buckets from ${rawSpellings} raw spellings; unmapped ${cities.find((c) => c.key === "unmapped")?.orders ?? 0}`);

// ── Courier (rules #8, #9, #12) ─────────────────────────────────────────────
console.log("\n5. Couriers");
const timing = new Map(courierTiming(orders).map((t) => [t.courier, t]));
for (const c of rollup(orders, byCourier)) {
  const t = timing.get(c.key);
  const days = t?.verdict === "ok" ? `${t.medianDaysToDeliver.toFixed(1)} d median` : t ? `not enough data (${t.reason})` : "—";
  console.log(`     ${c.key.padEnd(14)} ${String(c.orders).padStart(5)}  delivery ${pct(c.deliveryRate.rate).padStart(6)} (+${c.deliveryRate.stillOpen} open)  to deliver: ${days}`);
}
const noHistory = [...timing.values()].filter((t) => t.verdict === "not_enough_data" && t.reason === "no_courier_history");
check("couriers with no courier-timed history get no timing number", noHistory.every((t) => !("medianDaysToDeliver" in t)),
  noHistory.map((t) => t.courier).join(", ") || "none in this window");

// ── Products (rules #28, #29, #30) ──────────────────────────────────────────
console.log("\n6. Top variants");
const allocByVariant = new Map<string, Money[]>();
for (const r of productRows) allocByVariant.set(r.key, sumByCurrency([...(allocByVariant.get(r.key) ?? []), r.spend]));
for (const p of products.slice(0, 5)) {
  console.log(`     ${p.variantId.padEnd(16)} ${String(p.units).padStart(5)} units  ${String(p.orders).padStart(4)} orders  return rate ${pct(p.deliveryRate.rate === null ? null : 1 - p.deliveryRate.rate).padStart(6)}  ads (allocated) ${fmt(allocByVariant.get(p.variantId) ?? [])}`);
}

await prisma.$disconnect();
console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
