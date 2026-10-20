/**
 * The month-end projection backtest (G-GZR11-3, pack §5.4).
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env scripts/backtest-month-end.ts [--shop=0dscam-qn] > report.md
 *
 * Read-only. Prints Markdown. Nothing buyer-identifying is printed.
 *
 * The projection is run as the data stood at the start of day 11 and day 21
 * (10 and 20 days elapsed, store's local time) of each past month that has 8
 * weeks of orders before it and ended at least 21 days ago, so its orders are
 * mostly decided. It is compared with the month as it reads today: orders
 * placed, delivered revenue, and profit (when every day's ad spend was
 * fetched). Months with no delivery recorded at all, and projections the
 * model declines (no delivery in the 8 weeks before), are not scored on
 * revenue or profit. A figure passes when the actual is inside low–high; the bar is
 * 80% of the months tested, per measure (pack §5.4). Bias is
 * (Σ likely − Σ actual) / Σ actual.
 */
import { prisma } from "../app/lib/db.server";
import { compare, score, type BacktestRow } from "../app/lib/forecast/backtest";
import { loadForecastBase } from "../app/lib/forecast/base.server";
import { monthActual, projectMonth } from "../app/lib/forecast/month-end";
import { adSpendWithFees } from "../app/lib/forecast/month-end.server";
import { DAY_MS } from "../app/lib/forecast/stats";
import { localDayOf } from "../app/lib/metrics/order-grain";

const only = process.argv.find((a) => a.startsWith("--shop="))?.split("=")[1];
const now = new Date();
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The instant a local day starts in `timezone`. */
function localMidnight(day: string, timezone: string): Date {
  let t = Date.parse(`${day}T00:00:00Z`);
  // Step back by the zone's offset: find the earliest hour that reads as `day` locally.
  for (let h = -14; h <= 14; h++) {
    const c = new Date(t + h * 3_600_000);
    if (localDayOf(c, timezone) === day && localDayOf(new Date(c.getTime() - 1), timezone) !== day) return c;
  }
  return new Date(t);
}

const stores = await prisma.store.findMany({ where: { shopDomain: { not: { startsWith: "whatsapp" } } }, select: { id: true, shopDomain: true, timezone: true, currency: true }, orderBy: { shopDomain: "asc" } });
console.log(`# Month-end projection backtest\n\nRun ${now.toISOString().slice(0, 16)}Z. As of day 10 and day 20 of each past month with 8 weeks of history that ended 21+ days ago.\n`);

for (const store of stores) {
  const shop = store.shopDomain.replace(".myshopify.com", "");
  if (only && shop !== only) continue;
  const tz = store.timezone ?? "UTC";
  const first = await prisma.orderGrain.findFirst({ where: { storeId: store.id }, orderBy: { localDay: "asc" }, select: { localDay: true } });
  if (!first?.localDay || !store.currency) continue;
  const today = await loadForecastBase(store.id, now);
  const months: string[] = [];
  for (let m = addDays(first.localDay, 56).slice(0, 7); ; ) {
    const [y, mm] = m.split("-").map(Number) as [number, number];
    const end = new Date(Date.UTC(y, mm, 0));
    if (end.getTime() > now.getTime() - 21 * DAY_MS) break;
    months.push(m);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  }
  const rows: Record<"orders" | "revenue" | "profit", BacktestRow[]> = { orders: [], revenue: [], profit: [] };
  const lines: string[] = [];
  for (const month of months) {
    const [y, mm] = month.split("-").map(Number) as [number, number];
    const last = `${month}-${String(new Date(Date.UTC(y, mm, 0)).getUTCDate()).padStart(2, "0")}`;
    const fullAds = await adSpendWithFees(store.id, store.currency, `${month}-01`, last);
    const actual = monthActual(today.rows, month, store.currency, fullAds?.amount ?? null);
    for (const day of [10, 20]) {
      const localDay = `${month}-${String(day + 1).padStart(2, "0")}`;
      const asOf = localMidnight(localDay, tz);
      const base = await loadForecastBase(store.id, asOf);
      const p = projectMonth(
        { asOf, today: localDay, currency: base.currency, rows: base.rows, odds: base.odds, spreads: base.spreads, financifyOnly: base.parcels.length === 0, adSoFar: await adSpendWithFees(store.id, base.currency, `${month}-01`, addDays(localDay, -1)) },
        month,
      );
      const key = `${month}@${day}`;
      rows.orders.push(...compare(key, [{ key: "orders", range: p.orders.total }], new Map([["orders", actual.orders]])));
      // A month with no delivery recorded at all (yx4fu1-ax before Courierify) would pass trivially.
      const tracked = actual.deliveredRevenue > 0;
      if (tracked && p.deliveredRevenue) rows.revenue.push(...compare(key, [{ key: "revenue", range: p.deliveredRevenue }], new Map([["revenue", actual.deliveredRevenue]])));
      if (tracked && p.profit && actual.profit !== null) rows.profit.push(...compare(key, [{ key: "profit", range: p.profit }], new Map([["profit", actual.profit]])));
      const r = (x: { low: number; likely: number; high: number }) => `${fmt(x.low)} / ${fmt(x.likely)} / ${fmt(x.high)}`;
      lines.push(
        `| ${key} | ${r(p.orders.total)} | ${actual.orders} | ${p.deliveredRevenue ? r(p.deliveredRevenue) : "declined"} | ${fmt(actual.deliveredRevenue)} | ${p.profit ? r(p.profit) : "–"} | ${actual.profit === null ? "–" : fmt(actual.profit)} | ${p.trend.toFixed(2)} | ${pct(p.unresolvedAtMonthEnd)} |${tracked ? "" : " no delivery recorded: revenue and profit not scored"}${p.deliveredRevenue ? "" : " projection declined: no delivery in the 8 weeks before"}`,
      );
    }
  }
  console.log(`## ${shop}\n`);
  for (const [k, label] of [["orders", "Orders"], ["revenue", "Delivered revenue"], ["profit", "Profit"]] as const) {
    const s = score(rows[k]);
    console.log(`- **${label}:** ${s.tested} projections, inside low–high ${pct(s.coverage)} (bar 80%), bias ${pct(s.bias)}. ${s.tested === 0 ? "Nothing to test." : s.passes ? "**Passes.**" : "**Fails.**"}`);
  }
  console.log(`\n| Month @ day | Orders (low / likely / high) | Actual | Delivered revenue | Actual | Profit | Actual | Trend | Unresolved at month end |\n|---|---|---|---|---|---|---|---|---|`);
  console.log(lines.join("\n"));
  console.log("");
}
await prisma.$disconnect();
