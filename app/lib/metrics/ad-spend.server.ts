import { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { appRequest } from "../apps/client.server";
import { getAppCredentials } from "../apps/registry.server";
import { isQuietHours } from "../sync/sync.server";
import { localDayOf } from "./order-grain";
import { adSpendDaysDue, parseAdSpendDay } from "./ad-spend";

/**
 * Keep a store's ad spend current (G-GZR2-3).
 *
 * Ad spend is not an incremental feed: Financify answers a date range, and
 * rewrites the last 30 days from the ad platforms every day (its V5 check,
 * 2026-10-21). So:
 *  - the **trailing 3 shop-local days** are refreshed at most once an hour;
 *  - **days 4–30** are read again once a day, outside Pakistan business
 *    hours, so a platform's correction reaches Finance (D-85);
 *  - **older days, back to 90**, are fetched once each, outside business
 *    hours, a few per cycle. Product allocation costs Financify ≈0.6 s a
 *    day, so this is a courtesy to the box, not a necessity.
 *
 * A re-read replaces the day with Financify's current values; it never
 * relies on Financify's `syncedAt`, which moves daily whether or not a
 * value changed.
 *
 * One call per day, because product allocation over a wide range takes
 * ≈10 s for a month — the edge of the contract's read timeout — and a day
 * is also the unit that gets replaced.
 */

const TRAILING_DAYS = 3;
const CORRECTION_WINDOW_DAYS = 30;
const BACKFILL_DAYS = 90;
const BACKFILL_DAYS_PER_CYCLE = 15;

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

  const due = adSpendDaysDue({
    days: Array.from({ length: BACKFILL_DAYS }, (_, back) => days(back)),
    fetchedAt,
    now,
    quiet: isQuietHours(now) !== false,
    trailing: TRAILING_DAYS,
    correctionWindow: CORRECTION_WINDOW_DAYS,
    backfill: BACKFILL_DAYS,
    perCycle: BACKFILL_DAYS_PER_CYCLE,
  });

  const problems: string[] = [];
  const fetched: string[] = [];
  for (const day of due) {
    problems.push(...(await fetchDay(storeId, store.shopDomain, day, store.currency)));
    fetched.push(day);
  }
  return { fetched, problems };
}
