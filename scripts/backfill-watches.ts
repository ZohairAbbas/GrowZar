/**
 * Open the watches that clicks and app links before G-GZR9-1 would have
 * opened (Phase 9 pack §3.3 and §10).
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env scripts/backfill-watches.ts [--apply]
 *
 * A dry run by default: prints what it would open and changes nothing.
 * `--apply` writes the watches; running it again adds nothing (a watch is
 * unique per insight and moment).
 *
 * Replays each insight's events in order with the live rules (watch.ts): the
 * first click or app link opens a watch, a `reappeared` finding's next click
 * opens another, a dismissal as wrong closes it. Baselines:
 * - order-based detectors and cash held: the detectors are run again on the
 *   90 days before the click, as known then (as-of.server.ts), and the
 *   finding with the same fingerprint is kept, marked `reconstructed`;
 * - anything else, or a finding the rebuild does not find: `unavailable`,
 *   with the evidence the insight row holds now.
 * Watches by INTERNAL_EMAILS accounts are marked internal.
 *
 * Nothing buyer-identifying is printed.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../app/lib/db.server";
import { env } from "../app/lib/env.server";
import { evidenceOf, runDetectors, type DetectorId } from "../app/lib/insights/detectors";
import { EVALUATION_DAYS } from "../app/lib/insights/inbox.server";
import { inputAsOf, KNOWN_AFTER_DAYS } from "../app/lib/outcomes/as-of.server";
import { itemsOf } from "../app/lib/outcomes/items";
import { closesWatch, internalEmails, isInternal, opensWatch, type Baseline, type BaselineSource, type LatestWatch } from "../app/lib/outcomes/watch";

const apply = process.argv.includes("--apply");

/** Detectors whose finding the rebuild reproduces; the rest read state no history keeps. */
const REBUILDABLE = new Set<DetectorId>([
  "variant_returns",
  "unconfirmed_returns",
  "courier_for_city",
  "product_loss",
  "city_returns",
  "cash_held",
  "courierify_stopped",
]);

const internal = internalEmails(env.INTERNAL_EMAILS);
const events = await prisma.insightEvent.findMany({
  where: { kind: { in: ["clicked", "app_link", "dismissed", "reappeared"] } },
  orderBy: { at: "asc" },
  select: { insightId: true, kind: true, userId: true, detail: true, at: true },
});
const insightIds = [...new Set(events.filter((e) => e.kind === "clicked" || e.kind === "app_link").map((e) => e.insightId))];
const insights = await prisma.insight.findMany({
  where: { id: { in: insightIds } },
  select: { id: true, storeId: true, detector: true, subject: true, fingerprint: true, lastEvidence: true, store: { select: { shopDomain: true } } },
});
const users = await prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.userId).filter((u): u is string => !!u))] } }, select: { id: true, email: true } });
const emailOf = new Map(users.map((u) => [u.id, u.email]));

type Planned = Prisma.InsightOutcomeCreateManyInput & { shop: string };
const planned: Planned[] = [];

for (const ins of insights) {
  let latest: LatestWatch = null;
  let reappearedAt: Date | null = null;
  const mine: Planned[] = [];
  for (const e of events.filter((x) => x.insightId === ins.id)) {
    if (e.kind === "reappeared") reappearedAt = e.at;
    else if (e.kind === "dismissed") {
      if (latest && !latest.closedAt && closesWatch(e.detail as { intent: string; reason?: string })) {
        latest = { actedAt: latest.actedAt, closedAt: e.at };
        Object.assign(mine.at(-1)!, { closedAt: e.at, closedReason: "dismissed_wrong", verdict: "closed" });
      }
    } else if (opensWatch(ins.detector, latest, reappearedAt)) {
      const { baseline, source } = await rebuild(ins, e.at);
      latest = { actedAt: e.at, closedAt: null };
      mine.push({
        shop: ins.store.shopDomain,
        insightId: ins.id,
        storeId: ins.storeId,
        detector: ins.detector,
        subject: ins.subject,
        trigger: e.kind,
        actedAt: e.at,
        actedByUserId: e.userId,
        internal: isInternal(e.userId ? emailOf.get(e.userId) : null, internal),
        baseline: baseline as unknown as Prisma.InputJsonValue,
        baselineSource: source,
      });
    }
  }
  planned.push(...mine);
}

async function rebuild(ins: (typeof insights)[number], at: Date): Promise<{ baseline: Baseline; source: BaselineSource }> {
  const evidence = (ins.lastEvidence ?? {}) as Record<string, unknown>;
  const unavailable = (note: string) => ({ baseline: { finding: null, evidence, evaluatedAt: null, note }, source: "unavailable" as const });
  if (!REBUILDABLE.has(ins.detector as DetectorId)) return unavailable("its state at the time is not kept in Growzar; evidence is as of the backfill");
  const { input, connected } = await inputAsOf(ins.storeId, at, EVALUATION_DAYS);
  const found = runDetectors(input, connected).flatMap((o) => (o.status === "found" ? o.insights : []));
  const i = found.find((x) => x.fingerprint === ins.fingerprint);
  if (!i) return unavailable("the rebuild from order history did not find this finding at the time; evidence is as of the backfill");
  const items = itemsOf(i, input);
  return {
    baseline: {
      finding: i,
      ...(items ? { items } : {}),
      evidence,
      evaluatedAt: at.toISOString(),
      note: `rebuilt from order history as known at the time (outcomes known once courier-timed or ${KNOWN_AFTER_DAYS} days old)`,
    },
    source: "reconstructed",
  };
}

console.log(`${apply ? "Opening" : "Would open (dry run)"} ${planned.length} watch(es) on ${insightIds.length} clicked insight(s):`);
for (const p of planned) {
  const b = p.baseline as unknown as Baseline;
  console.log(
    `- ${p.shop} ${p.detector}:${p.subject} ${p.trigger} at ${(p.actedAt as Date).toISOString()} ` +
      `baseline=${p.baselineSource}${b.items ? ` items=${b.items.length}` : ""}${p.internal ? " internal" : ""}${p.closedAt ? " closed(wrong)" : ""}` +
      (b.finding ? `\n    then: ${JSON.stringify(evidenceOf(b.finding))}` : ""),
  );
}
const skipped = insights.filter((i) => !planned.some((p) => p.insightId === i.id));
for (const i of skipped) console.log(`- ${i.store.shopDomain} ${i.fingerprint}: no watch (${opensWatch(i.detector, null, null) ? "rules" : "no outcome to measure"})`);

if (apply) {
  const r = await prisma.insightOutcome.createMany({ data: planned.map(({ shop: _, ...p }) => p), skipDuplicates: true });
  console.log(`Wrote ${r.count} (already there: ${planned.length - r.count}).`);
}
await prisma.$disconnect();
