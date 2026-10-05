/**
 * Backtest every insight detector on one store (G-GZR3-9, PLAN.md §4).
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env scripts/backtest-insights.ts <shop-domain> \
 *     [--as-of=YYYY-MM-DD] [--lookback=30] [--follow=30] [--samples=10]
 *
 * Read-only, against Growzar's own database (no app is called). Prints
 * Markdown; nothing about the store is in this file, and nothing buyer-
 * identifying is printed (order names, days, outcomes, product titles only).
 *
 * Method:
 *  - The detectors run unchanged, on the `lookback` days before `as-of`, but
 *    see only what was known then, as near as the data allows. When an
 *    outcome became known is not recorded before Growzar's event log (late
 *    September): a "status as of" time is when it was last seen, often weeks
 *    after it happened. So an outcome counts as known at `as-of` if the
 *    courier timed it before then, or the order was placed at least
 *    KNOWN_AFTER_DAYS before it (courier-timed deliveries take a median of
 *    6 days, returns 10, on the pilot store); otherwise the order is still
 *    open, and Financify's view of it is unknown too. An approximation, and
 *    the report says so. Payouts are those dated before `as-of`; a parcel's
 *    payout counts only if it was settled before it.
 *  - A prediction (a product returning more, unconfirmed orders returning
 *    more, a better route, a losing product, a city) is checked on orders
 *    placed in the `follow` days from `as-of`, with their outcomes now.
 *  - Cash held (I4) is checked on the same parcels: how much of what was
 *    flagged as unpaid was paid afterwards.
 *  - Data-quality and context findings (fees missing, disagreements, the
 *    Courierify switch, the margin) are not predictions; they are reported
 *    as they would have read at `as-of`.
 *
 * Every result is a single-merchant result until more merchants enrol.
 */
import { prisma } from "../app/lib/db.server";
import { runDetectors, detectorLabel, type App, type DetectorOutcome, type Insight } from "../app/lib/insights/detectors";
import { decidedBy, type FindingsInput } from "../app/lib/metrics/findings";
import { formatAmount, parseAmount, readMoney, sumByCurrency, type Money } from "../app/lib/metrics/money";
import { bucketOf, profitAfterReturns, type RollupOrder } from "../app/lib/metrics/rollups";
import { loadAdSpend, toRollupOrder } from "../app/lib/metrics/rollups.server";
import { payerHistories, readPayout } from "../app/lib/metrics/settlements";

const shop = process.argv[2]?.toLowerCase();
if (!shop || shop.startsWith("--")) throw new Error("usage: backtest-insights.ts <shop-domain> [--as-of=YYYY-MM-DD] [--lookback=30] [--follow=30] [--samples=10]");
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const dayMs = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const asOfDay = arg("as-of", addDays(new Date().toISOString().slice(0, 10), -60));
const lookback = Number(arg("lookback", "30"));
const follow = Number(arg("follow", "30"));
const samples = Number(arg("samples", "10"));
const T = new Date(`${asOfDay}T00:00:00Z`);

const store = await prisma.store.findUniqueOrThrow({
  where: { shopDomain: shop },
  select: { id: true, currency: true, connections: { where: { status: "CONNECTED" }, select: { app: true } } },
});
const currency = store.currency;
if (!currency) throw new Error("store currency not reported");

const grain = await prisma.orderGrain.findMany({ where: { storeId: store.id } });
const names = new Map(grain.map((g) => [g.orderId, g.orderName ?? g.orderId]));
const all = grain.map(toRollupOrder);
const placedIn = (from: string, to: string) => all.filter((o) => o.localDay && o.localDay >= from && o.localDay <= to);

const DECIDED = new Set(["delivered", "returned", "partially_delivered"]);
const KNOWN_AFTER_DAYS = Number(arg("known-after", "14"));
/** Was this order's outcome known at T? See the method above. */
const outcomeKnownAt = (o: RollupOrder) =>
  (o.outcomeTiming?.basis === "happened_on" && o.outcomeTiming.at <= T) ||
  (!!o.createdAt && T.getTime() - o.createdAt.getTime() >= KNOWN_AFTER_DAYS * dayMs);
function knownAt(o: RollupOrder): RollupOrder {
  if (DECIDED.has(o.outcome) && !outcomeKnownAt(o)) {
    return { ...o, outcome: "in_transit", delivered: null, collected: null, uncollected: null, financifyOutcome: null };
  }
  return o;
}

const lbFrom = addDays(asOfDay, -lookback);
const lbTo = addDays(asOfDay, -1);
const fuFrom = asOfDay;
const fuTo = addDays(asOfDay, follow - 1);
const lbRows = placedIn(lbFrom, lbTo).map(knownAt);
const fuRows = placedIn(fuFrom, fuTo);

// ── Inputs as of T ───────────────────────────────────────────────────────────
const ads = await loadAdSpend(store.id, lbFrom, lbTo);
const adFees = (
  await prisma.adSpend.findMany({ where: { storeId: store.id, level: "day", day: { gte: lbFrom, lte: lbTo } }, select: { feesAmount: true, currency: true } })
).map((r) => ({ amount: r.feesAmount.toFixed(6), currency: r.currency }));
const adsComplete = ads.fetchedDays.size === lookback;
const spendWithFees = adsComplete ? sumByCurrency([...ads.total, ...adFees]) : null;
const orders = bucketOf("lookback", lbRows);

// Payouts dated before T, and each delivered parcel's payout as of T.
const raw = await prisma.rawRecord.findMany({
  where: { storeId: store.id, app: "COURIERIFY", entity: { in: ["SETTLEMENT", "PARCEL"] }, deletedAt: null },
  select: { entity: true, payload: true },
});
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const payouts = raw
  .filter((r) => r.entity === "SETTLEMENT")
  .map((r) => readPayout(obj(r.payload)))
  .filter((p): p is NonNullable<typeof p> => p !== null && p.day < asOfDay);
type ParcelPay = { orderId: string; cod: Money | null; settledAt: Date | null; delivered: boolean };
const parcels: ParcelPay[] = raw
  .filter((r) => r.entity === "PARCEL")
  .map((r) => {
    const p = obj(r.payload);
    const s = obj(p.settlement);
    return {
      orderId: String(p.orderId ?? ""),
      cod: readMoney(p.cod),
      settledAt: s.settled === true && typeof s.settledAt === "string" ? new Date(s.settledAt) : s.settled === true ? new Date(0) : null,
      delivered: p.status === "delivered",
    };
  });
const unpaidAtT = new Map<string, ParcelPay[]>();
for (const p of parcels) {
  if (!p.delivered || !p.cod || parseAmount(p.cod.amount)! <= 0n) continue;
  if (p.settledAt && p.settledAt <= T) continue;
  unpaidAtT.set(p.orderId, [...(unpaidAtT.get(p.orderId) ?? []), p]);
}
const awaiting = all
  .filter((o) => o.parcelCount > 0 && o.outcome === "delivered" && outcomeKnownAt(o) && unpaidAtT.has(o.orderId))
  .map((o) => ({ ...o, outcome: "delivered" as const, uncollected: sumByCurrency(unpaidAtT.get(o.orderId)!.map((p) => p.cod))[0] ?? null }));

const lastParcelDay = all.filter((o) => o.parcelCount > 0 && o.localDay && o.localDay < asOfDay).map((o) => o.localDay!).sort().at(-1) ?? null;
const connected = new Set(store.connections.map((c) => c.app).filter((a): a is App => a === "COURIERIFY" || a === "FINANCIFY"));

const input: FindingsInput = {
  currency,
  rows: lbRows,
  orders,
  profit: profitAfterReturns(orders, currency, spendWithFees),
  adSpend: spendWithFees,
  courierify: { connected: connected.has("COURIERIFY"), lastParcelDay },
  cash: { asOf: T, payers: payerHistories(payouts), awaiting },
  asOf: T,
  adByVariant: adsComplete ? Object.fromEntries(ads.byVariant) : undefined,
  periodDays: lookback,
};
const outcomes = runDetectors(input, connected);

// ── Follow-up checks ─────────────────────────────────────────────────────────
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const decidedOf = (rows: RollupOrder[]) => rows.filter((o) => o.outcome === "delivered" || o.outcome === "returned");
const rate = (rows: RollupOrder[]) => {
  const d = decidedOf(rows);
  const r = d.filter((o) => o.outcome === "returned").length;
  return { decided: d.length, returned: r, returnRate: pct(r, d.length) };
};
const domestic = (rows: RollupOrder[]) => rows.filter((o) => o.currency === currency);
const fuStore = rate(domestic(fuRows));
const fuOpen = domestic(fuRows).filter((o) => ["in_transit", "booked", "not_shipped"].includes(o.outcome)).length;
const money = (m: Money | null | undefined) => (m ? `${formatAmount(parseAmount(m.amount)!)} ${m.currency}` : "—");

type Verdict = { verdict: "held" | "partly held" | "did not hold" | "not enough later data" | "not a prediction"; detail: string };

function followUp(i: Insight): Verdict {
  const f = i.finding;
  switch (f.kind) {
    case "variant_returns": {
      const v = f.flagged[0]!;
      const later = rate(domestic(fuRows).filter((o) => o.lines.some((l) => l.variantId === v.variantId)));
      if (later.decided < 20) return { verdict: "not enough later data", detail: `${later.decided} decided later` };
      const gap = later.returnRate - fuStore.returnRate;
      return {
        verdict: gap >= 10 ? "held" : gap > 0 ? "partly held" : "did not hold",
        detail: `then ${v.returnRate}% vs store ${f.store.returnRate}%; later ${later.returnRate}% (${later.returned}/${later.decided}) vs store ${fuStore.returnRate}%`,
      };
    }
    case "unconfirmed_returns": {
      const c = rate(domestic(fuRows).filter((o) => o.confirmation === "confirmed"));
      const u = rate(domestic(fuRows).filter((o) => o.confirmation === "timed_out" || o.confirmation === "expired"));
      if (c.decided < 50 || u.decided < 50) return { verdict: "not enough later data", detail: `${c.decided} confirmed, ${u.decided} unanswered decided later` };
      const gap = u.returnRate - c.returnRate;
      return {
        verdict: gap >= 5 ? "held" : gap > 0 ? "partly held" : "did not hold",
        detail: `then ${f.unanswered.returnRate}% vs ${f.confirmed.returnRate}%; later ${u.returnRate}% (${u.returned}/${u.decided}) vs ${c.returnRate}% (${c.returned}/${c.decided})`,
      };
    }
    case "courier_for_city": {
      const route = (r: { courier: string; via: string }) =>
        rate(domestic(fuRows).filter((o) => o.parcelCount > 0 && o.city === f.city && o.courier === r.courier && (o.fulfilledVia ?? "direct") === r.via));
      const b = route(f.best);
      const w = route(f.worse[0]!);
      if (b.decided < 20 || w.decided < 20) return { verdict: "not enough later data", detail: `${b.decided} and ${w.decided} decided later on the two routes` };
      const gap = 100 - b.returnRate - (100 - w.returnRate);
      return {
        verdict: gap >= 3 ? "held" : gap > 0 ? "partly held" : "did not hold",
        detail: `then ${f.best.rate}% vs ${f.worse[0]!.rate}% delivered; later ${pct(b.decided - b.returned, b.decided)}% (${b.decided}) vs ${pct(w.decided - w.returned, w.decided)}% (${w.decided})`,
      };
    }
    case "product_loss":
    case "city_returns": {
      const later = f.kind === "city_returns"
        ? rate(domestic(fuRows).filter((o) => o.parcelCount > 0 && o.city === f.city))
        : rate(domestic(fuRows).filter((o) => o.lines.some((l) => l.variantId === f.variantId)));
      return {
        verdict: later.decided < 20 ? "not enough later data" : later.returnRate > fuStore.returnRate ? "held" : "did not hold",
        detail: `return rate later ${later.returnRate}% (${later.returned}/${later.decided}) vs store ${fuStore.returnRate}%`,
      };
    }
    case "cash_held": {
      const flagged = awaiting.filter((o) => (o.fulfilledVia ?? o.courier) === f.payer && o.uncollected);
      const ps = flagged.flatMap((o) => unpaidAtT.get(o.orderId) ?? []);
      const paid = ps.filter((p) => p.settledAt && p.settledAt > T);
      const sum = (l: ParcelPay[]) => sumByCurrency(l.map((p) => p.cod))[0] ?? null;
      return {
        verdict: paid.length === ps.length ? "did not hold" : paid.length ? "partly held" : "held",
        detail: `flagged ${ps.length} parcels (${money(sum(ps))}); paid afterwards ${paid.length} (${money(sum(paid))}); still unpaid today ${ps.length - paid.length}`,
      };
    }
    default:
      return { verdict: "not a prediction", detail: "a data-quality or context finding, reported as it would have read" };
  }
}

function sampleOrders(i: Insight): RollupOrder[] {
  const f = i.finding;
  const pool =
    f.kind === "variant_returns" ? lbRows.filter((o) => o.lines.some((l) => l.variantId === f.flagged[0]!.variantId))
    : f.kind === "product_loss" ? lbRows.filter((o) => o.lines.some((l) => l.variantId === f.variantId))
    : f.kind === "unconfirmed_returns" ? lbRows.filter((o) => o.confirmation === "timed_out" || o.confirmation === "expired")
    : f.kind === "courier_for_city" ? lbRows.filter((o) => o.city === f.city && o.courier === f.worse[0]!.courier && (o.fulfilledVia ?? "direct") === f.worse[0]!.via)
    : f.kind === "city_returns" ? lbRows.filter((o) => o.city === f.city)
    : f.kind === "cash_held" ? awaiting.filter((o) => (o.fulfilledVia ?? o.courier) === f.payer)
    : f.kind === "missing_fees" ? lbRows.filter((o) => o.parcelCount > 0 && !o.courierFee && o.outcome !== "not_shipped")
    : f.kind === "disagreements" ? lbRows.filter((o) => o.parcelCount > 0 && o.financifyOutcome && o.financifyOutcome !== o.outcome)
    : [];
  const sorted = [...pool].sort((a, b) => a.orderId.localeCompare(b.orderId));
  const step = Math.max(1, Math.floor(sorted.length / samples));
  return sorted.filter((_, k) => k % step === 0).slice(0, samples);
}

const finalOf = new Map(all.map((o) => [o.orderId, o]));
const line = (o: RollupOrder) => {
  const fin = finalOf.get(o.orderId)!;
  return `| ${names.get(o.orderId)} | ${o.localDay} | ${o.outcome} | ${fin.outcome} | ${o.confirmation ?? "—"} | ${o.courier ?? "—"}${o.fulfilledVia ? ` via ${o.fulfilledVia}` : ""} | ${o.city ?? "—"} | ${o.lines.map((l) => l.title ?? l.variantId).join("; ").slice(0, 60)} |`;
};

// ── Report ───────────────────────────────────────────────────────────────────
const out: string[] = [];
out.push(`# Insight backtest: ${shop}, as of ${asOfDay}`, "");
out.push(`**Single-merchant result.** One store with depth; nothing here generalises until more merchants enrol.`, "");
out.push(`- Detectors saw orders placed ${lbFrom} to ${lbTo} (${lbRows.length}). An outcome counts as known at ${asOfDay} if the courier timed it before then, or the order was placed ${KNOWN_AFTER_DAYS}+ days before (when outcomes became known is not recorded before late September, so this is an approximation; it lets in some late returns): ${decidedOf(lbRows).length} decided, ${lbRows.filter((o) => o.outcome === "in_transit").length} treated as still open.`);
out.push(`- Outcomes checked on orders placed ${fuFrom} to ${fuTo} (${fuRows.length}), as they stand today: ${fuStore.decided} decided (store return rate ${fuStore.returnRate}%), ${fuOpen} still open.`);
out.push(`- Ad spend fetched for ${ads.fetchedDays.size} of ${lookback} lookback day(s). Payouts known at the cut-off: ${payouts.length}. Delivery outcomes in the lookback decided by ${JSON.stringify(decidedBy(decidedOf(lbRows)))}.`, "");

const found = outcomes.flatMap((o) => (o.status === "found" ? o.insights : []));
out.push(`## Summary`, "", `| Detector | At ${asOfDay} | Afterwards |`, `|---|---|---|`);
for (const o of outcomes as DetectorOutcome[]) {
  if (o.status !== "found") {
    out.push(`| ${detectorLabel(o.detector)} | ${o.status.replace(/_/g, " ")}${"reason" in o ? `: ${o.reason}` : ""} | — |`);
    continue;
  }
  for (const i of o.insights) {
    const v = followUp(i);
    out.push(`| ${detectorLabel(o.detector)} (${i.subject}) | found | **${v.verdict}**: ${v.detail} |`);
  }
}
out.push("");
for (const i of found) {
  out.push(`## ${detectorLabel(i.detector)}: ${i.subject}`, "", "```json", JSON.stringify(i.finding, null, 1).slice(0, 2500), "```", "");
  const s = sampleOrders(i);
  if (s.length) {
    out.push(`Sample for review (${s.length}; outcome as known at ${asOfDay}, then today):`, "");
    out.push(`| Order | Placed | Then | Now | Confirmation | Courier | City | Lines |`, `|---|---|---|---|---|---|---|---|`);
    for (const o of s) out.push(line(o));
    out.push("");
  }
}
console.log(out.join("\n"));
await prisma.$disconnect();
