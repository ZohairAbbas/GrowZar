/**
 * The return-risk backtest (G-GZR11-4, pack §5.5).
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env scripts/backtest-return-risk.ts [--shop=0dscam-qn] > report.md
 *
 * Read-only. Prints Markdown. Nothing buyer-identifying is printed: counts,
 * rates and category labels (couriers, cities, product titles) only.
 *
 * Every order is scored as it was placed, from outcomes known by then. The
 * decided, scored orders placed until 21 days ago (so outcomes are mostly
 * known) are split in time: band cut-offs are fitted on the older half and
 * judged on the newer half. Reported: the return rate per band against the
 * store's, and the share of returns "high" caught. The placebo gives every
 * order another order's signals (seeded shuffle): its bands should not
 * separate returns.
 */
import { prisma } from "../app/lib/db.server";
import { backtestRisk, K, riskPass, shuffled, type RiskBacktest } from "../app/lib/forecast/return-risk";
import { loadRiskOrders } from "../app/lib/forecast/return-risk.server";
import { rng } from "../app/lib/forecast/stats";

const only = process.argv.find((a) => a.startsWith("--shop="))?.split("=")[1];
const now = new Date();
const asOf = new Date(now.getTime() - 21 * 86_400_000);
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

const stores = await prisma.store.findMany({
  where: { connections: { some: { app: "COURIERIFY", status: "CONNECTED" } }, shopDomain: { not: { startsWith: "whatsapp" } } },
  select: { id: true, shopDomain: true },
  orderBy: { shopDomain: "asc" },
});
console.log(`# Return-risk backtest\n\nRun ${now.toISOString().slice(0, 16)}Z. Stores with Courierify (P11-8).\n`);

const table = (b: RiskBacktest) => {
  const lines = [`| Band | Orders | Returned | Return rate | × store |`, `|---|---|---|---|---|`];
  for (const x of b.test.bands) lines.push(`| ${x.band} | ${x.orders} | ${x.returned} | ${x.orders ? pct(x.rate) : "–"} | ${x.orders && b.test.storeRate ? (x.rate / b.test.storeRate).toFixed(2) : "–"} |`);
  return lines.join("\n");
};

for (const store of stores) {
  const shop = store.shopDomain.replace(".myshopify.com", "");
  if (only && shop !== only) continue;
  const orders = await loadRiskOrders(store.id, now);
  const real = backtestRisk(orders, asOf, { now });
  const placebo = backtestRisk(shuffled(orders, rng(11)), asOf, { now });
  const c = real.fit.cuts;
  console.log(`## ${shop}\n`);
  console.log(`- Fit on orders placed ${real.fit.from} to ${real.fit.to}: ${c.orders} decided, return rate ${pct(c.storeRate)}. Cut-offs: high ${c.high === null ? "none (no slice reached 2× the store's odds of a return)" : `score ≥ ${c.high.toFixed(2)}`}, low ${c.low === null ? "none" : `score ≤ ${c.low.toFixed(2)}`}.`);
  console.log(`- Test on orders placed ${real.test.from} to ${real.test.to}: ${real.test.orders} decided, return rate ${pct(real.test.storeRate)}. "High" caught ${pct(real.test.highCatches)} of returns.\n`);
  console.log(table(real));
  console.log(`\nReturn rate by tenth of the score, highest first (test half): ${real.test.tenths.map((t) => pct(t.rate)).join(" · ")}`);
  console.log(`\n**Placebo** (shuffled signals): cut-offs high ${placebo.fit.cuts.high === null ? "none" : placebo.fit.cuts.high.toFixed(2)}, low ${placebo.fit.cuts.low === null ? "none" : placebo.fit.cuts.low.toFixed(2)}; "high" caught ${pct(placebo.test.highCatches)} of returns.\n`);
  console.log(table(placebo));
  console.log(`\nPlacebo by tenth: ${placebo.test.tenths.map((t) => pct(t.rate)).join(" · ")}`);
  // What the score leans on today: the categories with the largest pull, 30+ decided orders.
  const state = riskPass(orders, now).state;
  const p = state.store.r / state.store.n;
  const pull = [...state.counts.entries()]
    .filter(([k, v]) => v.n >= 30 && !k.startsWith("buyer:"))
    .map(([k, v]) => {
      const signal = k.split(":")[0] as keyof typeof K;
      const shrunk = (v.r + K[signal] * p) / (v.n + K[signal]);
      return { k, n: v.n, rate: v.r / v.n, lo: Math.log(shrunk / (1 - shrunk)) - Math.log(p / (1 - p)) };
    })
    .sort((a, b) => Math.abs(b.lo) - Math.abs(a.lo))
    .slice(0, 12);
  console.log(`\nStrongest categories today (store return rate ${pct(p)}):\n\n| Category | Decided | Return rate | Log-odds |\n|---|---|---|---|`);
  for (const x of pull) console.log(`| ${x.k} | ${x.n} | ${pct(x.rate)} | ${x.lo >= 0 ? "+" : ""}${x.lo.toFixed(2)} |`);
  console.log("");
}
await prisma.$disconnect();
