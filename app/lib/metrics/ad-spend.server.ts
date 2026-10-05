import { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { appRequest } from "../apps/client.server";
import { getAppCredentials } from "../apps/registry.server";
import { isQuietHours } from "../sync/sync.server";
import { localDayOf } from "./order-grain";
import { parseAdSpendDay } from "./ad-spend";

/**
 * Keep a store's ad spend current (G-GZR2-3).
 *
 * Ad spend is not an incremental feed: Financify answers a date range, and
 * ad platforms restate the last few days. So:
 *  - the **trailing 3 shop-local days** are refreshed at most once an hour;
 *  - **older days, back to 90**, are fetched once each, outside Pakistan
 *    business hours, a few per cycle. Product allocation costs Financify
 *    ≈0.6 s a day, so this is a courtesy to the box, not a necessity.
 *
 * One call per day, because product allocation over a wide range takes
 * ≈10 s for a month — the edge of the contract's read timeout — and a day
 * is also the unit that gets replaced.
 */

const TRAILING_DAYS = 3;
const BACKFILL_DAYS = 90;
const BACKFILL_DAYS_PER_CYCLE = 15;
const REFRESH_EVERY_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AdSpendRefresh = { fetched: string[]; problems: string[]; skipped?: string };

/** Fetch one ad-platform day and replace it whole. Also used by scripts/refetch-ad-spend.ts. */
export async function fetchDay(storeId: string, shopDomain: string, day: string, shopCurrency: string) {
  const credentials = getAppCredentials("FINANCIFY");
  if (!credentials) throw new Error("Financify is not configured");
  const response = await appRequest<unknown>("FINANCIFY", {
    pathWithQuery: `/api/v1/ad-spend?startDate=${day}&endDate=${day}&include=products`,
    shopDomain,
    credentials,
  });
  if (!response.ok) throw new Error(`ad-spend ${day}: ${response.reason} ${response.message}`);

  const { rows, problems } = parseAdSpendDay(day, response.data, shopCurrency);

  // Replace the day whole, so a campaign that disappears on restatement
  // disappears here too.
  await prisma.$transaction([
    prisma.adSpend.deleteMany({ where: { storeId, day } }),
    prisma.adSpend.createMany({
      data: rows.map((r) => ({
        storeId,
        day: r.day,
        level: r.level,
        key: r.key,
        platform: r.platform,
        spendAmount: new Prisma.Decimal(r.spend.amount),
        feesAmount: new Prisma.Decimal(r.fees.amount),
        currency: r.spend.currency,
        method: r.method,
        fxStatus: r.fxStatus,
        detail: r.detail as Prisma.InputJsonValue,
      })),
    }),
  ]);
  return problems;
}

export async function refreshAdSpend(storeId: string, now = new Date()): Promise<AdSpendRefresh> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: {
      shopDomain: true,
      timezone: true,
      currency: true,
      connections: { where: { app: "FINANCIFY", status: "CONNECTED" }, select: { app: true } },
    },
  });
  if (!store.connections.length) return { fetched: [], problems: [], skipped: "financify_not_connected" };
  if (!store.timezone || !store.currency) {
    // Days and money both need the store's own facts (rules #4, #5).
    return { fetched: [], problems: [], skipped: "timezone_or_currency_unknown" };
  }

  const days = (back: number) => localDayOf(new Date(now.getTime() - back * DAY_MS), store.timezone!);

  const fetchedRows = await prisma.adSpend.findMany({
    where: { storeId, level: "day" },
    select: { day: true, fetchedAt: true },
  });
  const fetchedAt = new Map(fetchedRows.map((r) => [r.day, r.fetchedAt]));

  const due: string[] = [];
  for (let back = 0; back < TRAILING_DAYS; back += 1) {
    const day = days(back);
    const at = fetchedAt.get(day);
    if (!at || now.getTime() - at.getTime() > REFRESH_EVERY_MS) due.push(day);
  }
  if (isQuietHours(now) === false) {
    for (let back = TRAILING_DAYS; back < BACKFILL_DAYS && due.length < TRAILING_DAYS + BACKFILL_DAYS_PER_CYCLE; back += 1) {
      const day = days(back);
      if (!fetchedAt.has(day)) due.push(day);
    }
  }

  const problems: string[] = [];
  const fetched: string[] = [];
  for (const day of due) {
    problems.push(...(await fetchDay(storeId, store.shopDomain, day, store.currency)));
    fetched.push(day);
  }
  return { fetched, problems };
}
