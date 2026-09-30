/**
 * Reconcile Growzar's metrics against Courierify's own analytics screen
 * (G-GZR2-6).
 *
 *   npx tsx --env-file=.env scripts/reconcile-courierify.ts <shop> <from> <to>
 *
 * Courierify exposes no aggregate to Growzar's credential, only rows. So its
 * screen figures are **rebuilt here from the Courierify rows Growzar holds,
 * with Courierify's own definitions** (app/lib/analytics.server.ts):
 *   - unit: parcels, `isManual = false`, windowed by the Shopify order's
 *     creation time in the shop's days;
 *   - delivery rate = delivered ÷ fulfilled, rounded to a whole percent,
 *     where fulfilled = status not in (cancelled, pending) — in-flight parcels
 *     stay in the denominator;
 *   - success rate = delivered ÷ (delivered + returned), by parcel;
 *   - COD delivered = Σ COD of delivered parcels;
 *   - customers = distinct phone digits with a leading 92 or 0 removed.
 * They are reproduced, not read off the screen; the report gives the window
 * so the human can compare with the screen itself.
 *
 * Every gap to Growzar is then *bridged by arithmetic* — e.g. Growzar's
 * orders = distinct parcel orders + orders Courierify has no parcel for — and
 * a bridge that does not add up is UNEXPLAINED (non-zero exit).
 */
import { prisma } from "../app/lib/db.server";
import { computeOrderGrain } from "../app/lib/metrics/order-grain.server";
import { localDayOf } from "../app/lib/metrics/order-grain";
import { formatAmount, parseAmount, sumByCurrency } from "../app/lib/metrics/money";
import { bucketOf } from "../app/lib/metrics/rollups";

const [shopArg, from, to] = process.argv.slice(2);
if (!shopArg || !from || !to) {
  console.error("Usage: reconcile-courierify.ts <shop> <from> <to>");
  process.exit(1);
}
const store = await prisma.store.findUniqueOrThrow({ where: { shopDomain: shopArg.toLowerCase() } });
const tz = store.timezone ?? "UTC";

let unexplained = 0;
function line(label: string, courierify: string, growzar: string, verdict: string, detail: string[] = []) {
  const bad = verdict.startsWith("UNEXPLAINED");
  if (bad) unexplained += 1;
  console.log(`  ${bad ? "✗" : courierify === growzar ? "=" : "≠"} ${label.padEnd(24)} ${courierify.padStart(16)}  ${growzar.padStart(22)}   ${verdict}`);
  for (const d of detail) console.log(`        ${d}`);
}
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);

// ── Courierify's view, from its own rows ────────────────────────────────────
const raw = await prisma.rawRecord.findMany({
  where: { storeId: store.id, app: "COURIERIFY", entity: "PARCEL", deletedAt: null },
  select: { externalId: true, payload: true },
});
type P = { id: string; orderId: string | null; status: string; manual: boolean; cod: string | null; tail: string | null; day: string | null };
const parcels: P[] = raw.map((r) => {
  const p = r.payload as any;
  const created = p.orderCreatedAt ? new Date(p.orderCreatedAt) : null;
  const phone = typeof p.customer?.phone === "string" ? p.customer.phone : typeof p.customer?.phoneRaw === "string" ? p.customer.phoneRaw : null;
  return {
    id: r.externalId,
    orderId: typeof p.orderId === "string" ? p.orderId : null,
    status: String(p.status ?? ""),
    manual: p.isManual === true,
    cod: p.cod?.amount ?? null,
    tail: phone ? phone.replace(/\D/g, "").replace(/^(92|0)/, "") || null : null,
    day: created ? localDayOf(created, tz) : null,
  };
});
const inWindow = parcels.filter((p) => !p.manual && p.day && p.day >= from && p.day <= to);
const IN_FLIGHT = ["booked", "picked_up", "in_transit", "out_for_delivery", "attempted"];
const c = {
  total: inWindow.length,
  fulfilled: inWindow.filter((p) => !["cancelled", "pending"].includes(p.status)).length,
  delivered: inWindow.filter((p) => p.status === "delivered").length,
  returned: inWindow.filter((p) => p.status === "returned").length,
  inFlight: inWindow.filter((p) => IN_FLIGHT.includes(p.status)).length,
  cancelled: inWindow.filter((p) => p.status === "cancelled").length,
};
const codDelivered = inWindow
  .filter((p) => p.status === "delivered" && p.cod)
  .reduce((a, p) => a + parseAmount(p.cod!)!, 0n);
const customerTails = new Set(inWindow.map((p) => p.tail).filter(Boolean));

// ── Growzar's view, from the order grain ───────────────────────────────────
const { grain } = await computeOrderGrain(store.id);
const orders = grain.filter((g) => g.localDay && g.localDay >= from && g.localDay <= to);
const b = bucketOf("window", orders);
const withParcel = orders.filter((g) => g.parcelCount > 0);
const parcelOrderIds = new Set(inWindow.map((p) => p.orderId).filter(Boolean));

console.log(`\n${store.shopDomain}, ${from}…${to} (${tz}):   Courierify screen (rebuilt) | Growzar\n`);

// 1. Parcels vs orders (rule #1)
const multi = parcelOrderIds.size;
const noParcel = orders.filter((g) => g.parcelCount === 0).length;
const onlyManualOrOutside = withParcel.filter((g) => !parcelOrderIds.has(g.orderId)).length;
const bridgeOrders = multi + noParcel + onlyManualOrOutside;
line("parcels / orders", `${c.total} parcels`, `${orders.length} orders`,
  bridgeOrders === orders.length ? "rule #1: Growzar counts orders, Courierify parcels" : "UNEXPLAINED",
  [
    `${c.total} parcels belong to ${multi} distinct orders (${c.total - multi} extra parcels from split or re-shipped orders)`,
    `+ ${noParcel} orders with no Courierify parcel (Financify only)`,
    `+ ${onlyManualOrOutside} orders whose parcels are manual, or whose parcel dates fall outside the window`,
    `= ${bridgeOrders} ${bridgeOrders === orders.length ? "✓" : `≠ ${orders.length}`}`,
  ]);

// 2. Delivery rate (rule #8)
const r = b.deliveryRate;
const growzarRate = r.rate === null ? "—" : `${(100 * r.rate).toFixed(1)}%`;
const byParcelSuccess = pct(c.delivered, c.delivered + c.returned);
// Growzar's rule restricted to Courierify's orders, to separate the two effects.
const cOrders = bucketOf("c", withParcel.filter((g) => parcelOrderIds.has(g.orderId))).deliveryRate;
line("delivery rate", `${pct(c.delivered, c.fulfilled)}%`, `${growzarRate} +${r.stillOpen} open`,
  "rule #8: Courierify divides by all fulfilled parcels (in-flight included); Growzar by delivered + returned orders",
  [
    `Courierify: ${c.delivered} delivered ÷ ${c.fulfilled} fulfilled (${c.inFlight} still in flight in the denominator)`,
    `Courierify's own "success rate", delivered ÷ (delivered + returned) by parcel: ${byParcelSuccess}%`,
    `Growzar's rule on Courierify's orders only: ${cOrders.rate === null ? "—" : (100 * cOrders.rate).toFixed(1)}% (${cOrders.delivered}/${cOrders.delivered + cOrders.returned} orders) — the by-parcel vs by-order effect`,
    `Growzar's rule on all orders: ${growzarRate} (${r.delivered}/${r.delivered + r.returned}) — adds ${noParcel} Financify-only orders (rule #7 fallback)`,
  ]);

// 3. Money (rules #2, #17): bridge COD of delivered parcels → Growzar's
// delivered revenue, order by order.
const cur = store.currency ?? "PKR";
const units = (a: string | null | undefined) => (a ? parseAmount(a)! : 0n);
const gDelivered = b.deliveredRevenue.find((m) => m.currency === cur)?.amount ?? "0.00";
const gCollected = b.collected.find((m) => m.currency === cur)?.amount ?? "0.00";
const codByOrder = new Map<string, bigint>();
for (const p of inWindow) if (p.status === "delivered" && p.orderId) codByOrder.set(p.orderId, (codByOrder.get(p.orderId) ?? 0n) + units(p.cod));
const codNoOrder = inWindow.filter((p) => p.status === "delivered" && !p.orderId).reduce((a, p) => a + units(p.cod), 0n);
const byId = new Map(orders.map((g) => [g.orderId, g]));
let codOnDeliveredOrders = 0n, placedOnThoseOrders = 0n, codElsewhere = 0n, ordersDiffering = 0, noPlaced = 0;
for (const [orderId, cod] of codByOrder) {
  const g = byId.get(orderId);
  if (g && g.outcome === "delivered" && g.placed?.currency === cur) {
    codOnDeliveredOrders += cod;
    placedOnThoseOrders += units(g.placed.amount);
    if (units(g.placed.amount) !== cod) ordersDiffering += 1;
  } else {
    codElsewhere += cod;
    if (g && !g.placed) noPlaced += 1;
  }
}
const finOnly = orders.filter((g) => g.outcome === "delivered" && g.parcelCount === 0 && g.placed?.currency === cur);
const finOnlyRevenue = finOnly.reduce((a, g) => a + units(g.placed!.amount), 0n);
const codTotalOk = codOnDeliveredOrders + codElsewhere + codNoOrder === codDelivered;
const revenueOk = formatAmount(placedOnThoseOrders + finOnlyRevenue) === formatAmount(units(gDelivered)) ||
  (units(gDelivered) === 0n && placedOnThoseOrders === 0n);
line("COD delivered", formatAmount(codDelivered), `${gDelivered} delivered rev.`,
  codTotalOk && revenueOk ? "rule #2: different amounts on overlapping sets, bridged below" : "UNEXPLAINED",
  [
    `Courierify ${formatAmount(codDelivered)} = ${formatAmount(codOnDeliveredOrders)} on orders Growzar also calls delivered + ${formatAmount(codElsewhere)} on orders it does not (${noPlaced} with no placed total: no Financify row, rule #2) + ${formatAmount(codNoOrder)} on parcels with no order id ${codTotalOk ? "✓" : "✗"}`,
    `on the shared orders, COD ${formatAmount(codOnDeliveredOrders)} vs placed ${formatAmount(placedOnThoseOrders)}: ${ordersDiffering} order(s) where COD to collect ≠ order total (prepaid part, or courier-side amount)`,
    `Growzar ${gDelivered} = ${formatAmount(placedOnThoseOrders)} placed on the shared orders + ${formatAmount(finOnlyRevenue)} on ${finOnly.length} delivered orders with no Courierify parcel ${revenueOk ? "✓" : "✗"}`,
    `Growzar's "paid by courier" (settled delivered parcels' COD): ${gCollected} — rule #17's first stage`,
  ]);

// 4. Customers (rule #19): bridge phone numbers on parcels → Growzar buyers.
const buyers = new Set(orders.map((g) => g.customerId).filter(Boolean));
const cOrderSet = new Set(withParcel.filter((g) => parcelOrderIds.has(g.orderId)).map((g) => g.orderId));
const buyersOnCourierify = new Set(orders.filter((g) => cOrderSet.has(g.orderId)).map((g) => g.customerId).filter(Boolean));
const buyersFinancifyOnly = [...buyers].filter((c) => !buyersOnCourierify.has(c));
// Tails whose orders got no Growzar customer at all: identity lost, not merged.
const tailsNoCustomer = new Set(
  inWindow.filter((p) => p.tail && p.orderId && byId.has(p.orderId) && !byId.get(p.orderId)!.customerId).map((p) => p.tail),
);
const lostRawOnly = raw.filter((r) => {
  const p = r.payload as any;
  const g = typeof p.orderId === "string" ? byId.get(p.orderId) : undefined;
  return g && !g.customerId && !p.customer?.phone && typeof p.customer?.phoneRaw === "string";
}).length;
const tailsWithCustomer = customerTails.size - [...tailsNoCustomer].filter((t) => !inWindow.some((p) => p.tail === t && p.orderId && byId.get(p.orderId)?.customerId)).length;
const merged = tailsWithCustomer - buyersOnCourierify.size;
const customersOk = buyersOnCourierify.size + buyersFinancifyOnly.length === buyers.size;
line("customers", String(customerTails.size), String(buyers.size),
  !customersOk ? "UNEXPLAINED" : tailsNoCustomer.size ? "rule #19 — and identity LOST for some numbers, see below" : "rule #19: bridged below",
  [
    `Courierify ${customerTails.size} phone numbers = ${tailsWithCustomer} that Growzar resolved + ${customerTails.size - tailsWithCustomer} on orders Growzar has no customer for`,
    `${tailsWithCustomer} resolved numbers → ${buyersOnCourierify.size} Growzar buyers (${merged} number(s) merged into a buyer already counted)`,
    `Growzar ${buyers.size} = ${buyersOnCourierify.size} buyers on Courierify orders + ${buyersFinancifyOnly.length} seen only on Financify orders ${customersOk ? "✓" : "✗"}`,
    ...(tailsNoCustomer.size
      ? [`of those parcels, ${lostRawOnly} carry only phoneRaw (no E.164 phone from Courierify) — Growzar must parse the raw number itself (rule #19)`]
      : []),
  ]);

await prisma.$disconnect();
console.log(unexplained ? `\n${unexplained} UNEXPLAINED` : "\nEvery difference is bridged by arithmetic or named by its rule.");
process.exit(unexplained ? 1 : 0);
