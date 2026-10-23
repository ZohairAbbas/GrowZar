import { prisma } from "../db.server";
import { daysBetween, FX_HISTORY_FROM, fxHistoryUrl, historyRows } from "./fx-history";

/** Days fetched per call, so one worker tick stays short; the rest follow on the next. */
const MAX_DAYS_PER_RUN = 40;

/**
 * Fill the days `fx_rates` lacks (D-98) from fawazahmed0's currency-api, for
 * every base Growzar converts into, from FX_HISTORY_FROM to yesterday.
 * Financify's daily rates (fx.server.ts) stay first: only days with no rate
 * at all for a base are filled, and today is left to Financify.
 */
export async function fillFxHistory(bases: readonly string[], now = new Date(), fetcher: typeof fetch = fetch): Promise<{ stored: number; days: number; problems: string[] }> {
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const problems: string[] = [];
  let stored = 0;
  let fetched = 0;
  for (const base of bases) {
    const have = new Set((await prisma.fxRate.findMany({ where: { base, day: { gte: FX_HISTORY_FROM } }, distinct: ["day"], select: { day: true } })).map((r) => r.day));
    for (const day of daysBetween(FX_HISTORY_FROM, yesterday).filter((d) => !have.has(d))) {
      if (fetched >= MAX_DAYS_PER_RUN) return { stored, days: fetched, problems };
      fetched++;
      try {
        const res = await fetcher(fxHistoryUrl(base, day), { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
          problems.push(`${base} ${day}: ${res.status}`);
          continue;
        }
        const rows = historyRows(base, day, await res.json());
        if (!rows.length) {
          problems.push(`${base} ${day}: no rates in the answer`);
          continue;
        }
        stored += (await prisma.fxRate.createMany({ data: rows, skipDuplicates: true })).count;
      } catch (e) {
        problems.push(`${base} ${day}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { stored, days: fetched, problems };
}
