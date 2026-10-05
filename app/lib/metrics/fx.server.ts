import { prisma } from "../db.server";
import { appRequest } from "../apps/client.server";
import { getAppCredentials } from "../apps/registry.server";
import { tableSource, type FxSource } from "./fx";
import type { RollupOrder } from "./rollups";

/**
 * Financify's daily rates (G-FIN2-1) into `fx_rates`, and back out as an
 * FxSource. Rates are not per shop, but every Financify request names one,
 * so any store with Financify connected carries the request.
 */

const SOURCE = "Financify daily rate";
/** Financify serves at most 92 days per request. */
const MAX_RANGE_DAYS = 92;
const DAY_MS = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** The bases Growzar converts into: every store's currency, and every organization's base. */
async function basesAndShop() {
  const stores = await prisma.store.findMany({
    where: { connections: { some: { app: "FINANCIFY", status: "CONNECTED" } } },
    select: { shopDomain: true, currency: true, organization: { select: { baseCurrency: true } } },
  });
  const bases = new Set<string>();
  for (const s of stores) {
    if (s.currency) bases.add(s.currency);
    if (s.organization.baseCurrency) bases.add(s.organization.baseCurrency);
  }
  return { bases: [...bases].filter((b) => /^[A-Z]{3}$/.test(b)).sort(), shop: stores[0]?.shopDomain ?? null };
}

type FxDay = { date?: unknown; rates?: unknown; source?: unknown; publishedAt?: unknown };

/**
 * Fetch every day not yet stored, up to today, for each base. Past days do
 * not change, so a stored day is never re-read; today's appears once the
 * provider publishes it (about 00:02 UTC).
 */
export async function refreshFxRates(now = new Date()): Promise<{ stored: number; bases: string[]; problems: string[] }> {
  const { bases, shop } = await basesAndShop();
  const credentials = getAppCredentials("FINANCIFY");
  if (!shop || !credentials) return { stored: 0, bases, problems: [] };
  const problems: string[] = [];
  let stored = 0;
  const to = utcDay(now);
  for (const base of bases) {
    const latest = await prisma.fxRate.findFirst({ where: { base }, orderBy: { day: "desc" }, select: { day: true } });
    const from = latest ? utcDay(new Date(Date.parse(`${latest.day}T00:00:00Z`) + DAY_MS)) : utcDay(new Date(now.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS));
    if (from > to) continue;
    const response = await appRequest<{ days?: FxDay[] }>("FINANCIFY", {
      pathWithQuery: `/api/v1/fx?date=${from}&to=${to}&base=${base}`,
      shopDomain: shop,
      credentials,
    });
    if (!response.ok) {
      problems.push(`${base}: ${response.reason} ${response.message}`);
      continue;
    }
    const rows = [];
    for (const d of response.data.days ?? []) {
      if (typeof d.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !d.rates || typeof d.rates !== "object") continue;
      for (const [currency, rate] of Object.entries(d.rates as Record<string, unknown>)) {
        // A rate is a positive decimal string; anything else is no rate.
        if (!/^[A-Z]{3}$/.test(currency) || currency === base || typeof rate !== "string" || !/^\d+(\.\d+)?$/.test(rate) || !/[1-9]/.test(rate)) continue;
        rows.push({
          base,
          currency,
          day: d.date,
          rate,
          source: typeof d.source === "string" ? d.source : SOURCE,
          publishedAt: typeof d.publishedAt === "string" ? new Date(d.publishedAt) : null,
        });
      }
    }
    if (rows.length) stored += (await prisma.fxRate.createMany({ data: rows, skipDuplicates: true })).count;
  }
  return { stored, bases, problems };
}

/**
 * The rates a set of orders could need, as a source: their currencies on
 * their own days. Amounts are dated by the store's local day and rates by
 * the provider's UTC day; at most a few hours apart, and stated here.
 */
export async function loadFxSource(base: string, rows: readonly RollupOrder[]): Promise<{ source: FxSource; ratesFrom: string | null }> {
  const currencies = new Set<string>();
  const days = new Set<string>();
  for (const o of rows) {
    for (const m of [o.placed, o.delivered, o.refunded, o.collected, o.uncollected, o.cogs, o.courierFee, ...o.lines.flatMap((l) => [l.value, l.cost])]) {
      if (m && m.currency !== base && o.localDay) {
        currencies.add(m.currency);
        days.add(o.localDay);
      }
    }
  }
  const first = await prisma.fxRate.findFirst({ where: { base }, orderBy: { day: "asc" }, select: { day: true } });
  if (!currencies.size) return { source: tableSource(SOURCE, []), ratesFrom: first?.day ?? null };
  const stored = await prisma.fxRate.findMany({
    where: { base, currency: { in: [...currencies] }, day: { in: [...days] } },
  });
  return {
    source: tableSource(
      SOURCE,
      stored.map((r) => ({ from: r.currency, to: r.base, day: r.day, rate: r.rate, source: SOURCE })),
    ),
    ratesFrom: first?.day ?? null,
  };
}
