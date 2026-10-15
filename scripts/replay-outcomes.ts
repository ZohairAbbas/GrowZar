/**
 * The outcome replay (G-GZR9-6): how the measurement engine judges findings
 * nobody acted on, so a claim of "improved" can be trusted (pack §10.2, §10.9).
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env scripts/replay-outcomes.ts [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--every-week] > report.md
 *
 * Read-only. Prints Markdown. Nothing buyer-identifying is printed.
 *
 * Method:
 *  - Every store's detectors are run weekly, as the data stood on each date
 *    (as-of.server.ts, the G-GZR3-9 backtest's method, 90-day lookback),
 *    from `--from` (default 180 days ago) to `--to` (default 60 days ago, so
 *    every watch can reach its day-60 cut-off).
 *  - A finding's first firing (absent the week before) becomes a placebo
 *    watch, acted on that date. No merchant acted on these: Growzar was not
 *    there. What the engine calls "improved" on them is improvement nobody
 *    caused (regression to the mean, seasonality, drift), the baseline a
 *    real claim must beat.
 *  - Each placebo watch is measured by the live engine (measureStore,
 *    write: false) on today's data, exactly as a real watch would be.
 *  - Only detectors whose inputs can be rebuilt as of a past date are
 *    replayed (Courierify and Financify data); the others are listed.
 *
 * `--every-week` makes every weekly firing a placebo, not only the first:
 * overlapping, so not independent and never used to pass a detector, but it
 * shows which way each detector drifts when there are few first firings.
 *
 * A detector passes when it has 20+ placebo watches and at most 5% of them
 * come out "improved" (pack §7). Money is shown with worked examples for
 * Zohair's approval (D-38); approved ids go in OUTCOME_MONEY_APPROVED later.
 */
import { prisma } from "../app/lib/db.server";
import { runDetectors, type Insight } from "../app/lib/insights/detectors";
import { evidenceOf } from "../app/lib/insights/detectors";
import { localDayOf } from "../app/lib/metrics/order-grain";
import { loadReturnCost } from "../app/lib/metrics/return-cost.server";
import { inputAsOf } from "../app/lib/outcomes/as-of.server";
import { measureStore, type Watch } from "../app/lib/outcomes/engine.server";
import { ORDER_BASED } from "../app/lib/outcomes/groups";
import { itemsOf } from "../app/lib/outcomes/items";
import { AFTER_DAYS, MIN_Z } from "../app/lib/outcomes/measure";
import { STATE_BASED } from "../app/lib/outcomes/state";

const DAY = 86_400_000;
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const today = new Date();
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const from = arg("from") ?? dayOf(new Date(today.getTime() - 180 * DAY));
const to = arg("to") ?? dayOf(new Date(today.getTime() - 60 * DAY));
const everyWeek = process.argv.includes("--every-week");

/** Detectors whose finding the rebuild reproduces (as backfill-watches.ts), and that have an outcome. */
const REPLAYED = new Set([
  "variant_returns", "unconfirmed_returns", "courier_for_city", "product_loss", "city_returns",
  "cash_held", "courierify_stopped", "missing_courier_fees",
]);
const MIN_PLACEBO = 20;
const MAX_FALSE_IMPROVED = 0.05;

type Placebo = { shop: string; watch: Watch; finding: Insight };
type Result = { shop: string; detector: string; subject: string; actedDay: string; verdict: string; effect: Record<string, unknown>; finding: Insight; observed: string | null };

const stores = await prisma.store.findMany({ select: { id: true, shopDomain: true, timezone: true, currency: true }, orderBy: { shopDomain: "asc" } });
const results: Result[] = [];
const runsPerStore: Record<string, number> = {};
const returnCosts = new Map<string, Awaited<ReturnType<typeof loadReturnCost>>>();

for (const s of stores) {
  const placebos: Placebo[] = [];
  let previous = new Set<string>();
  let runs = 0;
  for (let t = Date.parse(`${from}T10:00:00Z`); t <= Date.parse(`${to}T10:00:00Z`); t += 7 * DAY) {
    const T = new Date(t);
    const { input, connected } = await inputAsOf(s.id, T, 90);
    if (!input.rows.length) {
      previous = new Set();
      continue;
    }
    runs += 1;
    const found = runDetectors(input, connected).flatMap((o) => (o.status === "found" ? o.insights : []));
    const now = new Set(found.map((i) => i.fingerprint));
    for (const i of found) {
      if ((!everyWeek && previous.has(i.fingerprint)) || !REPLAYED.has(i.detector)) continue;
      const items = itemsOf(i, input);
      placebos.push({
        shop: s.shopDomain,
        finding: i,
        watch: {
          id: `placebo:${i.fingerprint}:${dayOf(T)}`,
          detector: i.detector,
          subject: i.subject,
          actedAt: T,
          baseline: { finding: i, ...(items ? { items } : {}), evidence: evidenceOf(i), evaluatedAt: T.toISOString() } as never,
          checkpoints: [],
        },
      });
    }
    previous = now;
  }
  runsPerStore[s.shopDomain] = runs;
  if (!placebos.length) continue;
  returnCosts.set(s.shopDomain, await loadReturnCost(s.id, s.currency));
  const m = await measureStore(s.id, today, { write: false, extra: placebos.map((p) => p.watch) });
  for (const r of m.results) {
    const p = placebos.find((x) => x.watch.id === r.id);
    if (!p) continue; // a stored (real) watch
    results.push({ shop: s.shopDomain, detector: p.watch.detector, subject: p.watch.subject, actedDay: localDayOf(p.watch.actedAt, s.timezone ?? "UTC"), verdict: r.verdict, effect: r.effect, finding: p.finding, observed: r.observed?.text ?? null });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

const out: string[] = [];
const say = (l = "") => out.push(l);
const pct = (a: number, b: number) => (b ? `${Math.round((1000 * a) / b) / 10}%` : "—");
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const VERDICTS = ["improved", "partly", "no_change", "worse", "not_enough_data", "too_early"];

say(`# Phase 9 outcome replay (G-GZR9-6)${everyWeek ? ": every weekly firing (sensitivity, overlapping watches)" : ""}`);
say();
say(`**Run:** ${dayOf(today)}, read-only, production data. **Act dates:** weekly ${from} → ${to}. **Stores and weekly runs with orders:** ${Object.entries(runsPerStore).map(([k, v]) => `${k.replace(".myshopify.com", "")} ${v}`).join(", ")}.`);
say();
say(`Each placebo watch is a finding's first firing in a simulated weekly run, measured by the live engine on today's data. Nobody acted on these findings, so every "improved" here is improvement nobody caused. A detector passes when it has ${MIN_PLACEBO}+ placebo watches and at most ${MAX_FALSE_IMPROVED * 100}% come out "improved" (pack §7, §10.2, §10.9). Until a detector passes, its verdicts stay count-only.`);
say();
say(`## 1. Verdicts per detector`);
say();
say(`| Detector | Placebo watches | ${VERDICTS.join(" | ")} | False "improved" | …with a "did it" signal | Passes |`);
say(`|---|---|${VERDICTS.map(() => "---").join("|")}|---|---|---|`);
const detectors = [...new Set([...REPLAYED, ...results.map((r) => r.detector)])].sort();
const passes = new Map<string, boolean>();
for (const d of detectors) {
  const rs = results.filter((r) => r.detector === d);
  const count = (v: string) => rs.filter((r) => r.verdict === v).length;
  const improved = count("improved");
  const pass = !everyWeek && rs.length >= MIN_PLACEBO && improved / rs.length <= MAX_FALSE_IMPROVED;
  const withSignal = rs.filter((r) => r.verdict === "improved" && r.observed).length;
  passes.set(d, pass);
  say(`| \`${d}\` | ${rs.length} | ${VERDICTS.map((v) => count(v) || "").join(" | ")} | ${pct(improved, rs.length)} | ${improved ? `${withSignal} of ${improved}` : ""} | ${everyWeek ? "not used" : rs.length < MIN_PLACEBO ? "can't validate yet" : pass ? "**yes**" : "**no**"} |`);
}
say();
say(`Not replayed (their inputs cannot be rebuilt as of a past date; they stay count-only until live placebo watches accumulate): ${[...ORDER_BASED, ...STATE_BASED].filter((d) => !REPLAYED.has(d)).map((d) => `\`${d}\``).join(", ")}.`);
say();

const improvedList = results.filter((r) => r.verdict === "improved");
if (improvedList.length && !everyWeek) {
  say(`**Every placebo "improved", and what the store did:**`);
  say();
  for (const r of improvedList) {
    const e = r.effect as Record<string, any>;
    say(`- \`${r.detector}\` ${r.shop.replace(".myshopify.com", "")} ${r.subject}, acted ${r.actedDay}: ${e.before?.subject ?? "—"}% → ${e.after?.subject ?? "—"}% (${e.effectPoints} pts, z ${e.z}). ${r.observed ? `"Did it" signal: ${r.observed}. The store made the change on its own, without Growzar.` : "No \"did it\" signal: drift."}`);
  }
  say();
}

say(`## 2. Effect sizes (rate detectors)`);
say();
say(`The measured change in the subject's rate beyond the comparison's, in points, on placebo watches that reached a verdict. Negative is fewer returns (or fewer missing fees, fewer orders outside Courierify). What a detector's placebo watches show on their own is the drift a real claim has to beat.`);
say();
say(`| Detector | Judged | Median effect | Middle half | Share with |z| ≥ ${MIN_Z} |`);
say(`|---|---|---|---|---|`);
for (const d of detectors) {
  const judged = results.filter((r) => r.detector === d && typeof r.effect.effectPoints === "number" && ["improved", "no_change", "worse"].includes(r.verdict));
  if (!judged.length) continue;
  const fx = judged.map((r) => r.effect.effectPoints as number).sort((a, b) => a - b);
  const q = (p: number) => fx[Math.min(fx.length - 1, Math.floor(p * fx.length))]!;
  const sig = judged.filter((r) => Math.abs(r.effect.z as number) >= MIN_Z).length;
  say(`| \`${d}\` | ${judged.length} | ${median(fx)!.toFixed(1)} | ${q(0.25).toFixed(1)} to ${q(0.75).toFixed(1)} | ${pct(sig, judged.length)} |`);
}
say();

say(`## 3. Money, with worked examples (for approval, D-38)`);
say();
say(`Formula v1 for return-rate detectors (I1, I12, I8, variant): **returns avoided per 30 days × the store's measured courier charge per return.** Returns avoided = the smaller of (a) the 95% interval's edge nearest zero and (b) the pessimistic bound with every open order counted against the claim, times the subject's after-window orders scaled to 30 days. Computed only for an "improved" verdict. I2: the product's loss reduction per 30 days as delivered, with open orders counted as returned. I4: the COD actually paid since (measured, not estimated). Courierify stopped and missing fees carry no money.`);
say();
say(`The examples below apply the formula to the placebo watches with the largest measured improvement, whatever their verdict, to show the arithmetic. They are not money anyone earned.`);
say();
for (const d of ["courier_for_city", "city_returns", "unconfirmed_returns", "variant_returns"]) {
  const rs = results.filter((r) => r.detector === d && typeof r.effect.effectPoints === "number").sort((a, b) => (a.effect.effectPoints as number) - (b.effect.effectPoints as number)).slice(0, 10);
  if (!rs.length) continue;
  say(`### \`${d}\``);
  say();
  say(`| Store | Subject | Acted | Before → after (subject) | Rest before → after | Effect (95% interval) | Pessimistic | Orders/30d | Returns avoided/30d | Per return | Money/30d | Verdict |`);
  say(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of rs) {
    const e = r.effect as Record<string, any>;
    const t = e.tallies.after.subject;
    const per30 = ((t.delivered + t.returned + t.open) * 30) / AFTER_DAYS;
    const fewer = Math.max(0, Math.min(-e.interval[1] / 100, -e.pessimistic.effect));
    const avoided = Math.round(fewer * per30 * 10) / 10;
    const rc = returnCosts.get(r.shop);
    const per = rc ? Number(rc.perReturn.amount) : null;
    say(
      `| ${r.shop.replace(".myshopify.com", "")} | ${r.subject} | ${r.actedDay} | ${e.before.subject ?? "—"}% → ${e.after.subject ?? "—"}% | ${e.before.rest ?? "—"}% → ${e.after.rest ?? "—"}% | ${e.effectPoints} (${e.interval[0]} to ${e.interval[1]}) | ${(e.pessimistic.effect * 100).toFixed(1)} | ${per30.toFixed(1)} | ${avoided} | ${per !== null ? `${Math.round(per)} ${rc!.perReturn.currency}` : "unknown"} | ${per !== null ? `${Math.round(avoided * per).toLocaleString("en")} ${rc!.perReturn.currency}` : "—"} | ${r.verdict} |`,
    );
  }
  say();
}
for (const d of ["product_loss", "cash_held"]) {
  const rs = results.filter((r) => r.detector === d).slice(0, 10);
  if (!rs.length) continue;
  say(`### \`${d}\``);
  say();
  for (const r of rs) {
    const e = r.effect as Record<string, any>;
    if (d === "product_loss") {
      say(`- ${r.shop.replace(".myshopify.com", "")} ${r.subject}, acted ${r.actedDay}: ${e.reason ?? `per 30 days before ${e.before?.per30?.asDelivered ?? "—"}, after ${e.after?.per30?.asDelivered ?? "—"} (if open orders deliver ${e.after?.per30?.ifOpenDeliver ?? "—"})`}; verdict ${r.verdict}.`);
    } else {
      say(`- ${r.shop.replace(".myshopify.com", "")} ${r.subject}, acted ${r.actedDay}: ${e.reason ?? `${e.items} owed orders followed, ${e.resolvedNow} paid by now`}; verdict ${r.verdict}.`);
    }
  }
  say();
}

// Live placebo watches: findings the worker saw firing that nobody clicked (approved 2026-10-15).
const live = await prisma.insightOutcome.findMany({ where: { trigger: "placebo" }, select: { detector: true, verdict: true, closedReason: true, observed: true } });
say(`## 4. Live placebo watches`);
say();
if (!live.length) say(`None yet.`);
else {
  say(`Findings the worker saw start firing (or already firing on the first evaluation after placebos were switched on) that nobody has clicked, measured by the same engine. A click closes a placebo as "clicked" and drops it from these counts. This is the sample the replay cannot reach; the same pass rule applies to judged ones.`);
  say();
  say(`| Detector | Open or judged | Still running | improved | partly | no_change | worse | not_enough_data | Closed by a click | False "improved" of judged |`);
  say(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const d of [...new Set(live.map((l) => l.detector))].sort()) {
    const rs = live.filter((l) => l.detector === d);
    const clean = rs.filter((l) => l.closedReason !== "clicked");
    const c = (v: string) => clean.filter((l) => l.verdict === v).length;
    const judged = clean.filter((l) => !["too_early", "closed"].includes(l.verdict)).length;
    say(`| \`${d}\` | ${clean.length} | ${c("too_early")} | ${c("improved") || ""} | ${c("partly") || ""} | ${c("no_change") || ""} | ${c("worse") || ""} | ${c("not_enough_data") || ""} | ${rs.length - clean.length || ""} | ${pct(c("improved"), judged)} |`);
  }
}
say();

say(`## 5. Approve or reject`);
say();
say(`| Detector | Replay | Recommendation |`);
say(`|---|---|---|`);
for (const d of detectors) {
  const n = results.filter((r) => r.detector === d).length;
  const p = passes.get(d);
  const rec =
    n < MIN_PLACEBO
      ? "Count-only: too few placebo watches to know how often it 'improves' on its own."
      : p
        ? "Verdicts may be shown; money formula for your approval."
        : "Count-only: un-acted findings already 'improve' too often for a claim to mean anything.";
  say(`| \`${d}\` | ${n} watches, ${pct(results.filter((r) => r.detector === d && r.verdict === "improved").length, n)} improved | ${rec} |`);
}
console.log(out.join("\n"));
await prisma.$disconnect();
