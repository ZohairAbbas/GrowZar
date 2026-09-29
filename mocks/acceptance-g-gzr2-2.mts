/**
 * G-GZR2-2 acceptance, storage half: the order grain as written equals the
 * order grain as computed, and a rebuild is repeatable.
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env mocks/acceptance-g-gzr2-2.mts <shop>
 *
 * The reconciliation half — the grain against Financify's /dashboard — is
 * scripts/reconcile-financify.ts, which needs a store with Financify.
 */
import { prisma } from "../app/lib/db.server.ts";
import { computeOrderGrain, rebuildOrderGrain } from "../app/lib/metrics/order-grain.server.ts";
import { sumByCurrency } from "../app/lib/metrics/money.ts";

const shopDomain = (process.argv[2] ?? "whatsapp-check.myshopify.com").toLowerCase();
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const store = await prisma.store.findUniqueOrThrow({ where: { shopDomain } });
console.log(`\nG-GZR2-2 storage against ${shopDomain}\n`);

const first = await rebuildOrderGrain(store.id);
console.log(`   rebuilt ${first.orders} orders in ${first.ms} ms (${first.fromParcelsOnly} known only from parcels)`);
const second = await rebuildOrderGrain(store.id);
const stored = await prisma.orderGrain.findMany({ where: { storeId: store.id } });
const { grain } = await computeOrderGrain(store.id);

check("a rebuild replaces rather than adds", stored.length === first.orders && second.orders === first.orders,
  `${stored.length} rows after two rebuilds`);
check("one row per order", new Set(stored.map((r) => r.orderId)).size === stored.length);

// Money survives the numeric column exactly: sum it in SQL and in bigint.
const sqlSums = await prisma.$queryRaw<Array<{ currency: string | null; total: string }>>`
  SELECT currency, SUM("placedAmount")::text AS total FROM order_grain
  WHERE "storeId" = ${store.id} AND "placedAmount" IS NOT NULL GROUP BY currency ORDER BY currency`;
const memSums = sumByCurrency(grain.map((g) => g.placed));
check("placed revenue round-trips to the cent", sqlSums.length === memSums.length &&
  sqlSums.every((s, i) => Number(s.total).toFixed(2) === Number(memSums[i]!.amount).toFixed(2)),
  sqlSums.map((s) => `${s.total} ${s.currency}`).join(", ") || "no placed revenue (Courierify-only store)");

const byId = new Map(grain.map((g) => [g.orderId, g]));
let outcomeMismatch = 0, dayMismatch = 0;
for (const row of stored) {
  const g = byId.get(row.orderId);
  if (!g || g.outcome !== row.outcome) outcomeMismatch += 1;
  if (!g || g.localDay !== row.localDay) dayMismatch += 1;
}
check("stored outcome equals computed outcome", outcomeMismatch === 0, `${outcomeMismatch} differ`);
check("stored local day equals computed local day", dayMismatch === 0, `${dayMismatch} differ`);

const sample = stored.find((r) => r.parcelCount > 0) ?? stored[0];
const explain = (sample?.explain ?? {}) as Record<string, { rule: string[]; inputs: string[] }>;
check("every row explains its outcome with rules and input rows",
  stored.every((r) => {
    const e = (r.explain as Record<string, { rule?: string[]; inputs?: string[] }>).outcome;
    return r.outcomeAuthority === "none" || (!!e?.rule?.length && !!e.inputs?.length);
  }),
  sample ? `e.g. ${sample.orderId}: ${explain.outcome?.rule.join(",")} from ${explain.outcome?.inputs[0]}` : "");

const [size] = await prisma.$queryRaw<Array<{ total: bigint }>>`
  SELECT pg_total_relation_size('order_grain')::bigint AS total`;
console.log(`   order_grain: ${stored.length} rows, ${size!.total} B`);

await prisma.$disconnect();
console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
