/**
 * G-GZR2-4 acceptance: store and organization grains.
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env mocks/acceptance-g-gzr2-4.mts <org-slug> <from> <to>
 *
 * Reads the stored order grain and ad spend; writes only the profit-settings
 * row the worker would write anyway. Needs migration 20260930120000.
 */
import { prisma } from "../app/lib/db.server.ts";
import { appRequest } from "../app/lib/apps/client.server.ts";
import { getAppCredentials } from "../app/lib/apps/registry.server.ts";
import { organizationSummary, refreshProfitSettings, storeSummary } from "../app/lib/metrics/summaries.server.ts";
import { sumByCurrency, type Money } from "../app/lib/metrics/money.ts";

const [slug = "pilot", from = "2026-07-01", to = "2026-09-22"] = process.argv.slice(2);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const fmt = (list: Money[]) => list.map((m) => `${m.amount} ${m.currency}`).join(" + ") || "0";

const org = await prisma.organization.findUniqueOrThrow({ where: { slug }, include: { stores: true } });
console.log(`\nG-GZR2-4 against organization "${org.name}" (${org.stores.length} stores, base ${org.baseCurrency}), ${from}…${to}\n`);

// ── Profit settings (rule #15) ─────────────────────────────────────────────
console.log("1. Profit settings");
for (const s of org.stores) {
  const outcome = await refreshProfitSettings(s.id, new Date(Date.now() + 2 * 60 * 60 * 1000)); // force past the hourly guard
  const stored = await prisma.storeProfitSettings.findUnique({ where: { storeId: s.id } });
  if (outcome === "no_financify") {
    check(`${s.shopDomain}: no Financify, so no settings row`, stored === null);
    continue;
  }
  const live = await appRequest<any>("FINANCIFY", { pathWithQuery: "/api/v1/settings/profit", shopDomain: s.shopDomain, credentials: getAppCredentials("FINANCIFY")! });
  check(`${s.shopDomain}: stored settings hash equals Financify's`, !!live.ok && stored?.settingsHash === live.data.settingsHash, stored?.settingsHash.slice(0, 20) ?? "none");
}

// ── Organization ────────────────────────────────────────────────────────────
console.log("\n2. Organization roll-up");
const summary = await organizationSummary(org.id, from, to);
const storeOrders = summary.stores.reduce((a, s) => a + s.orders.orders, 0);
check("organization orders = sum of its stores' orders", summary.orders.orders === storeOrders, `${summary.orders.orders} = ${summary.stores.map((s) => s.orders.orders).join(" + ")}`);
const perCurrency = sumByCurrency(summary.stores.flatMap((s) => s.orders.placed));
check("placed revenue per currency = sum of the stores', never mixed (rule #4)", fmt(perCurrency) === fmt(summary.orders.placed), fmt(summary.orders.placed));

const conv = summary.converted.placed;
const basePlaced = summary.orders.placed.find((m) => m.currency === org.baseCurrency)?.amount ?? "0.00";
check("with no rate source, the converted total is the base-currency part exactly", conv.total.amount === basePlaced && conv.ratesUsed.length === 0, `${conv.total.amount} ${conv.base}, source: ${conv.source}`);
const foreign = summary.orders.placed.filter((m) => m.currency !== org.baseCurrency);
check("every foreign amount is listed as unconverted, not dropped and not added at 1",
  fmt(conv.unconverted.map((u) => u.money)) === fmt(foreign) && conv.complete === (foreign.length === 0),
  conv.unconverted.map((u) => `${u.money.amount} ${u.money.currency} over ${u.days.length} day(s)`).join("; ") || "none");

const storeProfits = summary.stores.filter((s) => s.profit?.currency === org.baseCurrency).map((s) => s.profit!);
const expected = sumByCurrency(storeProfits.map((p) => ({ amount: p.amount, currency: p.currency })))[0]?.amount ?? null;
check("organization profit = sum of base-currency store profits, exactly", (summary.profit.total?.amount ?? null) === expected, `${summary.profit.total?.amount ?? "—"} ${org.baseCurrency}, complete: ${summary.profit.complete}`);
check("organization profit is incomplete whenever any store's is", summary.profit.complete === (storeProfits.every((p) => p.complete) && summary.profit.storesExcluded.length === 0));
check("stores with unknown settings are flagged, not treated as matching",
  summary.settings.unknown.every((shop) => summary.profit.flags.some((f) => f.includes(shop))),
  summary.profit.flags.join(" | ") || "no flags");

// ── Stores ──────────────────────────────────────────────────────────────────
console.log("\n3. Stores");
for (const s of summary.stores) {
  const r = s.orders.deliveryRate;
  console.log(`   ${s.store.shopDomain}`);
  console.log(`     ${s.orders.orders} orders, placed ${fmt(s.orders.placed)}; delivery ${r.rate === null ? "—" : (100 * r.rate).toFixed(1) + "%"} (+${r.stillOpen} open)`);
  console.log(`     profit after returns: ${s.profit ? `${s.profit.amount} ${s.profit.currency}${s.profit.complete ? "" : ` (incomplete: ${s.profit.missing.join("; ")})`}` : "—"}`);
  console.log(`     ad spend: ${s.adSpend ? `${fmt(s.adSpend.spend)} + fees ${fmt(s.adSpend.fees)}, ${s.adSpend.daysFetched}/${s.adSpend.daysInPeriod} days fetched (ad-platform days)` : "no Financify"}`);
  console.log(`     settings: ${s.settings.settingsHash ? s.settings.settingsHash.slice(0, 20) + "…" : "unknown"}; Courierify detail on ${s.courierifyCoverage.withParcel} of ${s.courierifyCoverage.shippedOrders} shipped orders`);
}

// The Courierify switch (report §7.3) must be visible at store grain.
const dscam = org.stores.find((s) => s.shopDomain.startsWith("0dscam-qn"));
if (dscam) {
  const aug = await storeSummary(dscam.id, "2026-08-01", "2026-08-31");
  const sep = await storeSummary(dscam.id, "2026-09-02", "2026-09-22");
  const share = (s: typeof aug) => s.courierifyCoverage.withParcel / Math.max(1, s.courierifyCoverage.shippedOrders);
  check("the Courierify switch shows in store coverage (August vs September)", share(aug) > 0.8 && share(sep) < 0.05,
    `August ${(100 * share(aug)).toFixed(1)}%, September ${(100 * share(sep)).toFixed(1)}%`);
}

await prisma.$disconnect();
console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
