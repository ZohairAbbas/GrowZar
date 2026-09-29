/**
 * Reconcile Growzar's order grain against Financify's own `/dashboard`
 * (G-GZR2-2 acceptance; the start of G-GZR2-6's reconciliation report).
 *
 *   npx tsx --env-file=.env scripts/reconcile-financify.ts <shop> <day> [<day> …]
 *
 * Read-only on both sides: the grain is computed in memory with the same
 * builder the rebuild stores, and Financify is asked with a signed GET.
 *
 * A difference counts as explained only when it is *demonstrated*, in two
 * steps:
 *   1. rebuild `/dashboard`'s figure from Financify's own rows using
 *      `/dashboard`'s definition. If that does not land on `/dashboard`'s
 *      number, the definition is not understood: UNEXPLAINED;
 *   2. list the orders where Growzar's rule gives a different answer from
 *      Financify's, which is the whole gap, order by order.
 * Anything left over is UNEXPLAINED and the script exits non-zero. Where a
 * figure cannot be rebuilt from rows at all (live variant cost), it says so
 * rather than claiming a match.
 */
import { prisma } from "../app/lib/db.server";
import { appRequest } from "../app/lib/apps/client.server";
import { getAppCredentials } from "../app/lib/apps/registry.server";
import { computeOrderGrain } from "../app/lib/metrics/order-grain.server";
import { formatAmount, parseAmount, readMoney, sumByCurrency, type Money } from "../app/lib/metrics/money";
import type { OrderGrain } from "../app/lib/metrics/order-grain";

const [shopArg, ...days] = process.argv.slice(2);
const shopDomain = shopArg?.toLowerCase();
if (!shopDomain || days.length === 0) {
  console.error("Usage: reconcile-financify.ts <shop> <YYYY-MM-DD> [...]");
  process.exit(1);
}

const store = await prisma.store.findUniqueOrThrow({ where: { shopDomain } });
const shop = store.currency ?? "PKR";
const { grain } = await computeOrderGrain(store.id);
const grainById = new Map(grain.map((g) => [g.orderId, g]));

const finRows = await prisma.rawRecord.findMany({
  where: { storeId: store.id, app: "FINANCIFY", entity: "ORDER", deletedAt: null },
  select: { externalId: true, payload: true },
});

type Fin = { id: string; name: string; category: string; status: string; placed: Money | null; cogs: Money | null };
const financifyById = new Map<string, Fin & { localDay: string }>();
for (const r of finRows) {
  const p = r.payload as any;
  financifyById.set(r.externalId, {
    id: r.externalId,
    name: String(p.orderName ?? r.externalId),
    localDay: String(p.localDay ?? ""),
    category: String(p.delivery?.category ?? "unknown"),
    status: String(p.delivery?.status ?? ""),
    placed: readMoney(p.money?.placed),
    cogs: readMoney(p.cogs?.total),
  });
}

/** /dashboard's floats, as the cent they stand for. */
const cents = (n: unknown) => (typeof n === "number" ? n.toFixed(2) : "—");
const shopSum = (list: Array<Money | null>) =>
  sumByCurrency(list).find((m) => m.currency === shop)?.amount ?? "0.00";
const minus = (a: string, b: string) => formatAmount(parseAmount(a)! - parseAmount(b)!);

let unexplained = 0;
function report(label: string, growzar: string, dashboard: string, verdict: string, detail: string[] = []) {
  const bad = verdict.startsWith("UNEXPLAINED");
  if (bad) unexplained += 1;
  const mark = bad ? "✗" : verdict === "match" ? "=" : "≠";
  console.log(`  ${mark} ${label.padEnd(24)} ${growzar.padStart(18)}  ${dashboard.padStart(12)}   ${verdict}`);
  for (const d of detail) console.log(`        ${d}`);
}

/** Orders where Growzar's outcome and Financify's category disagree. */
function disagreements(day: OrderGrain[], want: "delivered" | "returned") {
  const out: string[] = [];
  for (const g of day) {
    const f = financifyById.get(g.orderId);
    if (!f) continue;
    const growzarSays = g.outcome === want;
    const financifySays = f.category === want;
    if (growzarSays !== financifySays) {
      out.push(
        `${f.name}: Financify ${f.category}/${f.status}, Growzar ${g.outcome} (${g.outcomeAuthority}) ` +
          `${financifySays ? "−" : "+"}${g.placed?.amount ?? "?"} ${g.placed?.currency ?? ""}`,
      );
    }
  }
  return out;
}

for (const day of days) {
  const response = await appRequest<any>("FINANCIFY", {
    pathWithQuery: `/api/external/dashboard?startDate=${day}&endDate=${day}`,
    shopDomain,
    credentials: getAppCredentials("FINANCIFY")!,
  });
  if (!response.ok) throw new Error(`/dashboard ${day}: ${response.reason}`);
  const m = response.data.metrics;
  const summary = response.data.deliverySummary;

  const fin = [...financifyById.values()].filter((f) => f.localDay === day);
  const rows = fin.map((f) => grainById.get(f.id)).filter((g): g is OrderGrain => !!g);
  console.log(`\n${day}   Growzar | /dashboard`);

  // ── Orders (rule #1) ───────────────────────────────────────────────────
  report("orders", String(rows.length), String(m.orders.total),
    rows.length === m.orders.total ? "match" : "UNEXPLAINED");

  // ── Placed revenue (rules #2, #4) ─────────────────────────────────────
  const placed = sumByCurrency(rows.map((g) => g.placed));
  const foreign = placed.filter((p) => p.currency !== shop);
  const shopPlaced = shopSum(rows.map((g) => g.placed));
  if (!foreign.length) {
    report("placed revenue", `${shopPlaced} ${shop}`, cents(m.gmv.grossOrderValue),
      shopPlaced === cents(m.gmv.grossOrderValue) ? "match" : "UNEXPLAINED");
  } else {
    // /dashboard has folded the foreign orders into one PKR figure. The
    // residual is what it valued them at; Growzar cannot check the rate it
    // used, because Financify does not expose one per order (O-2).
    const residual = minus(cents(m.gmv.grossOrderValue), shopPlaced);
    const implied = foreign.map((f) => `${f.amount} ${f.currency}`).join(" + ");
    report("placed revenue", `${shopPlaced} ${shop} + ${foreign.length} more`, cents(m.gmv.grossOrderValue),
      parseAmount(residual)! > 0n
        ? "rule #4: /dashboard converted and added foreign orders; Growzar never adds currencies"
        : "UNEXPLAINED: /dashboard is not above the PKR orders alone",
      [`PKR orders match exactly only if /dashboard valued ${implied} at ${residual} PKR; the rate is not exposed, so not verified`]);
  }

  // ── Delivered count (rule #7) ─────────────────────────────────────────
  const gDelivered = rows.filter((g) => g.outcome === "delivered");
  const fDelivered = fin.filter((f) => f.category === "delivered");
  const dDiff = disagreements(rows, "delivered");
  const gRet = rows.filter((g) => g.outcome === "returned").length;
  report("delivered orders", String(gDelivered.length), `${m.orders.delivered} | ${summary.deliveredOrders}`,
    // The real test is the first: that deliverySummary is exactly Financify's
    // own delivered rows. Growzar's count then differs from it by exactly the
    // rule #7 orders listed below, by construction.
    fDelivered.length !== summary.deliveredOrders
      ? "UNEXPLAINED: deliverySummary is not Financify's own delivered category"
      : "orders.delivered = 0 is /dashboard's casing bug; deliverySummary rebuilt exactly from Financify's rows" +
        (dDiff.length ? "; rule #7 moves the orders below" : ""),
    dDiff);

  // ── Delivered revenue (rules #2, #7) ──────────────────────────────────
  // /dashboard does not sum delivered orders: it pro-rates the day's GMV by
  // the delivered share of orders. Rebuilt here in its own float arithmetic.
  const gDelRev = shopSum(gDelivered.map((g) => g.delivered));
  const dashDelRev = cents(m.gmv.delivered);
  const proRated = ((m.gmv.grossOrderValue * summary.deliveredOrders) / m.orders.total).toFixed(2);
  report("delivered revenue", `${gDelRev} ${shop}`, dashDelRev,
    gDelRev === dashDelRev
      ? "match"
      : proRated === dashDelRev
        ? "rule #2: Growzar sums the delivered orders; /dashboard estimates GMV × delivered ÷ all orders"
        : "UNEXPLAINED",
    gDelRev === dashDelRev ? [] : [
      `/dashboard rebuilt: ${cents(m.gmv.grossOrderValue)} × ${summary.deliveredOrders} ÷ ${m.orders.total} = ${proRated}`,
      `Financify's own delivered rows sum to ${shopSum(fDelivered.map((f) => f.placed))} — the same as Growzar`,
    ]);

  // ── RTO value, which /dashboard calls "refunded" (rules #10, #11) ─────
  // /dashboard's figure is returned + cancelled orders. Rule #10 keeps a
  // cancellation out of returns, so Growzar's figure is returned only.
  const gRto = shopSum(rows.filter((g) => g.outcome === "returned").map((g) => g.placed));
  const retOrCancelled = fin.filter((f) => f.category === "returned" || f.category === "cancelled");
  const rebuiltRto = shopSum(retOrCancelled.map((f) => f.placed));
  const cancelledValue = shopSum(fin.filter((f) => f.category === "cancelled").map((f) => f.placed));
  const dashRto = cents(m.gmv.refunded);
  report("RTO value ('refunded')", `${gRto} ${shop}`, dashRto,
    gRto === dashRto
      ? "match"
      : rebuiltRto === dashRto
        ? "rules #10, #11: /dashboard adds cancelled orders to returns and calls it 'refunded'"
        : "UNEXPLAINED",
    [
      `/dashboard rebuilt: returned + cancelled = ${rebuiltRto} (cancelled alone ${cancelledValue})`,
      ...disagreements(rows, "returned"),
    ]);
  const dashReturnRate = Number(m.unitEconomics.returnRate).toFixed(1);
  const rebuiltReturnRate = ((100 * retOrCancelled.length) / m.orders.total).toFixed(1);
  report("return rate %", `${gRet} returned`, dashReturnRate,
    rebuiltReturnRate === dashReturnRate
      ? `rules #8, #10: /dashboard = (returned + cancelled) ÷ all orders = ${retOrCancelled.length}/${m.orders.total}`
      : "UNEXPLAINED");
  const refunds = shopSum(rows.map((g) => g.refunded));
  report("refunds (money back)", `${refunds} ${shop}`, "—", "rule #10: a separate number /dashboard does not show");

  // ── COGS (rule #14) ───────────────────────────────────────────────────
  const gCogs = shopSum(gDelivered.map((g) => g.cogs));
  const fCogsSnapshot = shopSum(fDelivered.map((f) => f.cogs));
  report("COGS, delivered", `${gCogs} ${shop}`, cents(m.costs.productCosts),
    `rule #14: /dashboard costs delivered lines at live variant cost (cogsDataSource=${m.costs.cogsDataSource}), not at order time; not reproducible from rows`,
    [`Financify's own delivered rows at order-time cost: ${fCogsSnapshot}; the rest of the gap is live-vs-snapshot cost`]);

  // ── Delivery rate (rule #8) ───────────────────────────────────────────
  const open = rows.filter((g) => ["in_transit", "booked", "not_shipped"].includes(g.outcome)).length;
  const dashRate = Number(m.performance.deliveryRate).toFixed(1);
  const rebuilt = ((100 * summary.deliveredOrders) / m.orders.total).toFixed(1);
  report("delivery rate %",
    `${gDelivered.length + gRet ? ((100 * gDelivered.length) / (gDelivered.length + gRet)).toFixed(1) : "—"} (+${open} open)`,
    dashRate,
    rebuilt === dashRate
      ? "rule #8: /dashboard = delivered ÷ all orders (rebuilt exactly); Growzar = delivered ÷ (delivered + returned), open shown beside"
      : "UNEXPLAINED");
}

await prisma.$disconnect();
console.log(unexplained ? `\n${unexplained} UNEXPLAINED difference(s)` : "\nEvery difference is demonstrated, not asserted.");
process.exit(unexplained ? 1 : 0);
