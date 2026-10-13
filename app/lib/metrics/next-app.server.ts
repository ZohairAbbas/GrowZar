import { prisma } from "../db.server";
import { formatAmount, parseAmount, type Money } from "./money";
import { localDayOf } from "./order-grain";
import { nextAppPrompts, type AppPrompt, type StoreFacts } from "./next-app";

const DAY_MS = 86_400_000;
/** The window the prompts measure, as Home's default period. */
export const PROMPT_DAYS = 90;

/** The figures `nextAppPrompts` pitches on, in the store's own currency only (rule #4). */
export async function loadStoreFacts(storeId: string, currency: string | null, now = new Date()): Promise<StoreFacts | null> {
  if (!currency) return null;
  const since = new Date(now.getTime() - PROMPT_DAYS * DAY_MS);
  const [row] = await prisma.$queryRaw<
    Array<{
      returns: number; returnsValue: string | null;
      unconfirmed: number; unconfirmedValue: string | null;
      untracked: number; untrackedValue: string | null;
      delivered: number; deliveredValue: string | null;
    }>
  >`
    SELECT
      count(*) FILTER (WHERE outcome = 'returned')::int AS returns,
      sum("placedAmount") FILTER (WHERE outcome = 'returned')::text AS "returnsValue",
      count(*) FILTER (WHERE outcome = 'returned' AND confirmation IS NULL)::int AS unconfirmed,
      sum("placedAmount") FILTER (WHERE outcome = 'returned' AND confirmation IS NULL)::text AS "unconfirmedValue",
      count(*) FILTER (WHERE "parcelCount" = 0 AND outcome IN ('delivered', 'returned', 'in_transit', 'partially_delivered'))::int AS untracked,
      sum("placedAmount") FILTER (WHERE "parcelCount" = 0 AND outcome IN ('delivered', 'returned', 'in_transit', 'partially_delivered'))::text AS "untrackedValue",
      count(*) FILTER (WHERE outcome = 'delivered')::int AS delivered,
      sum(COALESCE("deliveredAmount", "placedAmount")) FILTER (WHERE outcome = 'delivered')::text AS "deliveredValue"
    FROM order_grain
    WHERE "storeId" = ${storeId} AND currency = ${currency} AND "createdAt" >= ${since}`;

  const [once] = await prisma.$queryRaw<Array<{ buyers: number; value: string | null }>>`
    WITH b AS (
      SELECT COALESCE(c."mergedIntoId", c.id) AS cust, count(*) AS orders, min(g."createdAt") AS first,
             bool_and(g.outcome = 'delivered') AS delivered, sum(g."placedAmount") AS value, bool_and(g.currency = ${currency}) AS same
      FROM order_grain g JOIN customers c ON c.id = g."customerId"
      WHERE g."storeId" = ${storeId}
      GROUP BY 1
    )
    SELECT count(*)::int AS buyers, sum(value)::text AS value FROM b
    WHERE orders = 1 AND delivered AND same
      AND first < ${new Date(now.getTime() - 45 * DAY_MS)} AND first >= ${new Date(now.getTime() - 180 * DAY_MS)}`;

  const [top] = await prisma.$queryRaw<Array<{ orders: number; withTop: number; variants: number }>>`
    WITH o AS (
      SELECT "orderId", lines FROM order_grain
      WHERE "storeId" = ${storeId} AND "createdAt" >= ${new Date(now.getTime() - 30 * DAY_MS)}
    ),
    v AS (
      SELECT l->>'variantId' AS variant, count(DISTINCT o."orderId") AS orders
      FROM o, jsonb_array_elements(o.lines) l WHERE l->>'variantId' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10
    )
    SELECT (SELECT count(*) FROM o)::int AS orders,
           (SELECT count(DISTINCT l->>'variantId') FROM o, jsonb_array_elements(o.lines) l)::int AS variants,
           (SELECT count(DISTINCT o."orderId") FROM o, jsonb_array_elements(o.lines) l WHERE l->>'variantId' IN (SELECT variant FROM v))::int AS "withTop"`;

  const m = (v: string | null): Money | null => {
    const units = v === null ? null : parseAmount(v);
    return units === null ? null : { amount: formatAmount(units), currency };
  };
  return {
    currency,
    days: PROMPT_DAYS,
    returns: { orders: row?.returns ?? 0, value: m(row?.returnsValue ?? null) },
    unconfirmedReturns: { orders: row?.unconfirmed ?? 0, value: m(row?.unconfirmedValue ?? null) },
    oneTimeBuyers: { buyers: once?.buyers ?? 0, value: m(once?.value ?? null) },
    untracked: { orders: row?.untracked ?? 0, value: m(row?.untrackedValue ?? null) },
    topSellers: { orders: top?.orders ?? 0, share: top?.orders ? (100 * top.withTop) / top.orders : null, variants: top?.variants ?? 0 },
    delivered: { orders: row?.delivered ?? 0, value: m(row?.deliveredValue ?? null) },
  };
}

/** At most this many prompts on Home: the lead and two more. */
export const PROMPTS_SHOWN = 3;

/**
 * Home's prompts for one store and viewer, with each one shown recorded once
 * per user, app and store-local day. Null when the store has every app, or
 * no figure is big enough to pitch on.
 */
export async function nextAppSection(
  store: { id: string; currency: string | null; timezone: string | null },
  connected: ReadonlySet<string>,
  viewer: { userId: string; canSeeMoney: boolean },
  now = new Date(),
): Promise<{ storeId: string; prompts: AppPrompt[] } | null> {
  const facts = await loadStoreFacts(store.id, store.currency, now);
  if (!facts) return null;
  const prompts = nextAppPrompts(facts, connected, viewer.canSeeMoney).slice(0, PROMPTS_SHOWN);
  if (!prompts.length) return null;
  const day = localDayOf(now, store.timezone ?? "UTC");
  await prisma.appPromptEvent.createMany({
    data: prompts.map((p, i) => ({ storeId: store.id, app: p.app, kind: "shown", userId: viewer.userId, day, detail: { lead: i === 0 } })),
    skipDuplicates: true,
  });
  return { storeId: store.id, prompts };
}
