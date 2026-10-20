/**
 * The cash forecast backtest (G-GZR11-2, pack §5.3 and §10 P11-6).
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env scripts/backtest-cash.ts [--weeks=12] [--shop=0dscam-qn] > report.md
 *
 * Read-only. Prints Markdown. Nothing buyer-identifying is printed.
 *
 * The forecast is run as the data stood on each Monday whose four forecast
 * weeks have fully passed (the last `--weeks` such Mondays), and compared
 * with what then happened to the same orders, read from today's parcels:
 *  - COD due: delivered COD per payer and week;
 *  - payouts: paid COD per payer and week, for payers whose cycle was
 *    measured on that Monday (the others were not forecast by week).
 * A payer-week passes when the actual is inside low–high; the bar is 80% of
 * payer-weeks (pack §5.3). Bias is (Σ likely − Σ actual) / Σ actual. The
 * same is reported for the store's weekly totals and each payer's 4-week
 * total, where COD landing a day either side of a week boundary is no miss.
 */
import { prisma } from "../app/lib/db.server";
import { compare, score, weekdaysBetween, type BacktestRow } from "../app/lib/forecast/backtest";
import { loadForecastBase } from "../app/lib/forecast/base.server";
import { cashActuals, cashFigures, forecastCash, rollUp, WEEKS, type CashGrain } from "../app/lib/forecast/cash";
import { DAY_MS } from "../app/lib/forecast/stats";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const weeksBack = Number(arg("weeks") ?? 12);
const only = arg("shop");

const now = new Date();
const lastStart = new Date(now.getTime() - WEEKS * 7 * DAY_MS);
const dates = weekdaysBetween(new Date(lastStart.getTime() - (weeksBack - 1) * 7 * DAY_MS), lastStart);

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

const stores = await prisma.store.findMany({
  where: { connections: { some: { app: "COURIERIFY", status: "CONNECTED" } } },
  select: { id: true, shopDomain: true },
  orderBy: { shopDomain: "asc" },
});

console.log(`# Cash forecast backtest\n\nRun ${now.toISOString().slice(0, 16)}Z. Mondays ${dates[0]!.toISOString().slice(0, 10)} to ${dates.at(-1)!.toISOString().slice(0, 10)}, ${WEEKS} weeks ahead each.\n`);

for (const store of stores) {
  const shop = store.shopDomain.replace(".myshopify.com", "");
  if (only && shop !== only) continue;
  const today = await loadForecastBase(store.id, now);
  const due: BacktestRow[] = [];
  const paid: BacktestRow[] = [];
  const coarse: Record<Exclude<CashGrain, "payer_week">, BacktestRow[]> = { store_week: [], payer_total: [] };
  const perDate: string[] = [];
  for (const T of dates) {
    const base = await loadForecastBase(store.id, T);
    const f = forecastCash(base);
    const actual = cashActuals(f, today, base.currency);
    const rows = compare(T.toISOString().slice(0, 10), cashFigures(f), actual);
    for (const g of ["store_week", "payer_total"] as const) coarse[g].push(...compare(T.toISOString().slice(0, 10), cashFigures(f, g), rollUp(actual, g)));
    due.push(...rows.filter((r) => r.key.startsWith("due|")));
    paid.push(...rows.filter((r) => r.key.startsWith("paid|")));
    const measured = f.paid.byPayer.filter((p) => p.basis === "measured").map((p) => p.payer);
    perDate.push(
      `| ${T.toISOString().slice(0, 10)} | ${f.basis.open.length} | ${fmt(f.due.total.low)} / ${fmt(f.due.total.likely)} / ${fmt(f.due.total.high)} | ${fmt(rows.filter((r) => r.key.startsWith("due|")).reduce((s, r) => s + r.actual, 0))} | ${measured.join(", ") || "none"} | ${f.notTracked.orders} |`,
    );
  }
  const d = score(due);
  const p = score(paid);
  console.log(`## ${shop}\n`);
  console.log(`- **COD due:** ${d.tested} payer-weeks, inside low–high ${pct(d.coverage)} (bar 80%), bias ${pct(d.bias)}. ${d.passes ? "**Passes.**" : "**Fails.**"}`);
  console.log(`- **Payouts (measured payers):** ${p.tested} payer-weeks, inside ${pct(p.coverage)}, bias ${pct(p.bias)}. ${p.tested === 0 ? "**Nothing to test.**" : p.passes ? "**Passes.**" : "**Fails.**"}`);
  for (const [g, label] of [["store_week", "store's weekly totals"], ["payer_total", "each payer's 4-week total"]] as const) {
    for (const part of ["due", "paid"]) {
      const s = score(coarse[g].filter((r) => r.key.startsWith(`${part}|`)));
      if (s.tested) console.log(`- ${part === "due" ? "COD due" : "Payouts"}, ${label}: ${s.tested} figures, inside ${pct(s.coverage)}, bias ${pct(s.bias)}.`);
    }
  }
  console.log("");
  console.log(`| Monday | Open orders forecast | Due in 4 weeks (low / likely / high) | Actual | Measured payers | Not tracked |\n|---|---|---|---|---|---|`);
  console.log(perDate.join("\n"));
  const byPayer = new Map<string, BacktestRow[]>();
  for (const r of [...due, ...paid]) {
    const k = r.key.split("|").slice(0, 2).join(" ");
    byPayer.set(k, [...(byPayer.get(k) ?? []), r]);
  }
  console.log(`\n| Part, payer | Payer-weeks | Inside | Σ likely | Σ actual |\n|---|---|---|---|---|`);
  for (const [k, rows] of [...byPayer.entries()].sort()) {
    const s = score(rows);
    console.log(`| ${k} | ${s.tested} | ${pct(s.coverage)} | ${fmt(rows.reduce((a, r) => a + r.range.likely, 0))} | ${fmt(rows.reduce((a, r) => a + r.actual, 0))} |`);
  }
  console.log("");
}

await prisma.$disconnect();
