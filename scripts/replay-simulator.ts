/**
 * The budget simulator's replay (G-GZR11-5, pack §5.2).
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env scripts/replay-simulator.ts [--shop=0dscam-qn] [--every=7] > report.md
 *
 * Read-only. Prints Markdown: campaign names, spend and profit per rupee,
 * nothing buyer-identifying.
 *
 * As of each date (every `--every` days) whose next 30 days ended at least 14
 * days ago, the ad lines are built as the data stood then, and each line that
 * then ran is predicted at the spend it actually had; the actual is what its
 * credited orders made, read today. Pass bar (pack §5.2): actual inside
 * low–high on 80% of lines, bias under 15% on totals. The gate is not
 * applied: a replay judges the engine, not the store.
 */
import { prisma } from "../app/lib/db.server";
import { REPLAY_DAYS, replayAt, scoreReplay, type ReplayLine } from "../app/lib/forecast/simulator/replay";
import { loadSimData } from "../app/lib/forecast/simulator/simulator.server";
import { DAY_MS } from "../app/lib/forecast/stats";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const only = arg("shop");
const every = Number(arg("every") ?? 7);
/** Pooling constants to compare (pack: k is set by the replay). */
const KS = (arg("k") ?? "30,100,300,1000").split(",").map(Number);
const now = new Date();
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const f2 = (x: number) => x.toFixed(2);

const stores = await prisma.store.findMany({
  where: { adSpend: { some: { level: "campaign" } }, shopDomain: { not: { startsWith: "whatsapp" } } },
  select: { id: true, shopDomain: true },
  orderBy: { shopDomain: "asc" },
});
console.log(`# Budget simulator replay\n\nRun ${now.toISOString().slice(0, 16)}Z. Each line: profit per rupee predicted at the spend it actually had (low / likely / high) against what it made over the next ${REPLAY_DAYS} days.\n`);

for (const store of stores) {
  const shop = store.shopDomain.replace(".myshopify.com", "");
  if (only && shop !== only) continue;
  const today = await loadSimData(store.id, now);
  const first = today.spend.map((s) => s.day).sort()[0];
  if (!first) continue;
  const last = new Date(now.getTime() - (REPLAY_DAYS + 14) * DAY_MS);
  // Start once the 90-day window (ending 21 days before) has four weeks of spend.
  const start = new Date(Date.parse(`${first}T00:00:00Z`) + (21 + 28) * DAY_MS);
  const all: ReplayLine[] = [];
  const out: string[] = [];
  const byK = new Map(KS.map((k) => [k, [] as ReplayLine[]]));
  for (let t = start.getTime(); t <= last.getTime(); t += every * DAY_MS) {
    const then = await loadSimData(store.id, new Date(t));
    for (const k of KS) byK.get(k)!.push(...replayAt(then, today, { k }));
    const lines = replayAt(then, today);
    all.push(...lines);
    const s = scoreReplay(lines);
    out.push(`\n### As of ${then.today}: ${lines.length} lines, inside ${pct(s.coverage)}, bias ${pct(s.bias)}\n\n| Line | Spend | Predicted (low / likely / high) | Actual | Inside | Still open |\n|---|---|---|---|---|---|`);
    for (const l of lines)
      out.push(`| ${l.label} | ${Math.round(l.spend).toLocaleString("en-US")} | ${f2(l.predicted.low)} / ${f2(l.predicted.likely)} / ${f2(l.predicted.high)} | ${f2(l.actual)} | ${l.actual >= l.predicted.low && l.actual <= l.predicted.high ? "yes" : "no"} | ${pct(l.openShare)} |`);
  }
  const s = scoreReplay(all);
  console.log(`## ${shop}\n\n- **${all.length} line-dates**: actual inside low–high ${pct(s.coverage)} (bar 80%), bias on totals ${pct(s.bias)} (bar ±15%). ${all.length ? (s.passes ? "**Passes.**" : "**Fails.**") : "Nothing to replay."}`);
  for (const kind of ["campaign", "platform_group"] as const) {
    const r = scoreReplay(all.filter((l) => l.kind === kind));
    console.log(`- ${kind === "campaign" ? "Campaign lines" : "Platform groups"}: ${r.tested} line-dates, inside ${pct(r.coverage)}, bias ${pct(r.bias)}.`);
  }
  console.log(`\n| Pooling k | Inside | Bias |\n|---|---|---|`);
  for (const [k, ls] of byK) {
    const r = scoreReplay(ls);
    console.log(`| ${k} | ${pct(r.coverage)} | ${pct(r.bias)} |`);
  }
  console.log(out.join("\n"));
  console.log("");
}
await prisma.$disconnect();
