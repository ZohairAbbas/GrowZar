/**
 * Re-read a store's ad spend for the last N days, replacing each day whole.
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env scripts/refetch-ad-spend.ts <shop> [days=90]
 *
 * Why it exists: the worker refreshes only the trailing 3 days and backfills
 * days it has never fetched, so a change to an older day never arrives. Two
 * did on 2026-10-05: Financify's G-FIN2-4 (pre-fee spend is now the
 * platform-reported amount, fees = total - spend), and an ad platform's own
 * restatement (0dscam-qn, TikTok 7 Sep: 10,003.11 stored, 10,028.32 served).
 * One request per day; prints what changed in total.
 */
import { prisma } from "../app/lib/db.server";
import { fetchDay } from "../app/lib/metrics/ad-spend.server";
import { localDayOf } from "../app/lib/metrics/order-grain";

const [shopArg, daysArg] = process.argv.slice(2);
if (!shopArg) throw new Error("usage: refetch-ad-spend.ts <shop> [days=90]");
const days = Number(daysArg ?? "90");
const store = await prisma.store.findUniqueOrThrow({
  where: { shopDomain: shopArg.toLowerCase() },
  select: { id: true, shopDomain: true, timezone: true, currency: true },
});
if (!store.timezone || !store.currency) throw new Error("store timezone or currency unknown");

const totals = async () =>
  (await prisma.adSpend.groupBy({ by: ["level"], where: { storeId: store.id, level: { in: ["day", "product"] } }, _sum: { spendAmount: true, feesAmount: true } }))
    .map((r) => `${r.level}: spend ${r._sum.spendAmount?.toFixed(2)} fees ${r._sum.feesAmount?.toFixed(2)}`)
    .join("; ");
console.log(`before: ${await totals()}`);
const problems: string[] = [];
for (let back = days - 1; back >= 0; back -= 1) {
  const day = localDayOf(new Date(Date.now() - back * 86_400_000), store.timezone);
  problems.push(...(await fetchDay(store.id, store.shopDomain, day, store.currency)));
}
console.log(`after:  ${await totals()}`);
console.log(`${days} day(s) re-read; ${problems.length} problem(s)${problems.length ? `: ${problems.slice(0, 5).join("; ")}` : ""}`);
await prisma.$disconnect();
