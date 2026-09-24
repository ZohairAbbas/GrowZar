import type { Prisma, SuiteApp, SyncEntity } from "@prisma/client";

import { prisma } from "../db.server";
import { appRequest } from "../apps/client.server";
import { getAppCredentials } from "../apps/registry.server";
import { extractId, extractUpdatedAt, feedsFor, type EntityFeed } from "./entities";
import { recordOrderSnapshot } from "./snapshots.server";

/**
 * Incremental sync (API-CONTRACT §6.2).
 *
 * The shape of one run: ask for everything changed since the high-water mark,
 * walk the pages with the app's cursor, write each page, then advance the
 * cursor. The order matters — advancing first would skip a page if the process
 * died between the two — and it is why a killed worker resumes with repeats
 * rather than gaps.
 */

const PAGE_LIMIT = 200;
/** How many pages one run will walk before yielding to the next cycle. */
const MAX_PAGES_PER_RUN = 25;
/** A run still marked RUNNING after this long is a crashed worker. */
const LEASE_MS = 10 * 60 * 1000;

type ContractPage = {
  shop?: string;
  shopTimezone?: string;
  shopCurrency?: string;
  data?: unknown[];
  deletedIds?: unknown[];
  pagination?: {
    limit?: number;
    count?: number;
    hasMore?: boolean;
    nextCursor?: string | null;
  };
};

export type FeedRunResult = {
  app: SuiteApp;
  entity: SyncEntity;
  pages: number;
  written: number;
  duplicates: number;
  tombstoned: number;
  skipped: number;
  snapshots: number;
  finished: boolean;
  error?: string;
};

/**
 * Pakistan business hours, 05:00–15:00 UTC (pack rule #4).
 *
 * The five-minute incremental cycle runs regardless — it is small and the
 * merchant is watching. Backfills do not: a 90-day pull hitting an app while
 * its merchants are booking parcels is exactly the kind of neighbourliness
 * this box cannot afford to skip.
 */
export function isQuietHours(now = new Date()): boolean {
  const window = process.env.SYNC_QUIET_HOURS_UTC ?? "05:00-15:00";
  const [from, to] = window.split("-");
  if (!from || !to) return false;

  const minutes = (value: string) => {
    const [h, m] = value.trim().split(":");
    return Number(h) * 60 + Number(m ?? 0);
  };

  const start = minutes(from);
  const end = minutes(to);
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();

  // A window that wraps midnight is still one window.
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

async function ensureState(storeId: string, app: SuiteApp, entity: SyncEntity) {
  return prisma.syncState.upsert({
    where: { storeId_app_entity: { storeId, app, entity } },
    update: {},
    create: { storeId, app, entity },
  });
}

/**
 * Take the lease for this feed, or report that someone else holds it.
 *
 * The update is conditional on the state we just read, so two workers racing
 * for the same feed cannot both win: the second one's `updateMany` matches
 * nothing.
 */
async function claimLease(stateId: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - LEASE_MS);

  const { count } = await prisma.syncState.updateMany({
    where: {
      id: stateId,
      OR: [
        { status: { not: "RUNNING" } },
        { runStartedAt: { lt: staleBefore } },
        { runStartedAt: null },
      ],
    },
    data: { status: "RUNNING", runStartedAt: now },
  });

  return count === 1;
}

/**
 * Currency and timezone come from the source, never a default (rules #4, #5).
 *
 * Every §6.1 response echoes them, so the first successful page of any feed
 * teaches Growzar what this shop's money and days actually are. A store whose
 * apps have never answered keeps nulls, and every screen says "not reported
 * yet" rather than showing a guessed PKR.
 */
async function learnShopFacts(storeId: string, page: ContractPage) {
  const data: Prisma.StoreUpdateInput = {};

  if (page.shopCurrency && /^[A-Z]{3}$/.test(page.shopCurrency)) {
    data.currency = page.shopCurrency;
  }
  if (page.shopTimezone && page.shopTimezone.includes("/")) {
    data.timezone = page.shopTimezone;
  }

  if (Object.keys(data).length > 0) {
    await prisma.store.update({ where: { id: storeId }, data });
  }
}

/**
 * Write one page.
 *
 * Dedupe is by `(entity, id, updatedAt)` (§6.2). `updatedSince` is inclusive,
 * so the boundary row comes back every single run; writing it again would
 * churn the table and, worse, would make `lastSeenAt` meaningless. An
 * unchanged row only has its `lastSeenAt` touched.
 */
async function writePage(options: {
  storeId: string;
  app: SuiteApp;
  feed: EntityFeed;
  page: ContractPage;
}): Promise<{
  written: number;
  duplicates: number;
  skipped: number;
  tombstoned: number;
  snapshots: number;
  maxUpdatedAt: Date | null;
}> {
  const { storeId, app, feed, page } = options;

  let written = 0;
  let duplicates = 0;
  let skipped = 0;
  let snapshots = 0;
  let maxUpdatedAt: Date | null = null;

  for (const row of page.data ?? []) {
    const externalId = extractId(row, feed);
    const sourceUpdatedAt = extractUpdatedAt(row);

    // A row with no canonical id or no updatedAt cannot be stored safely: it
    // could not be deduplicated, so every run would add another copy. It is
    // counted and reported rather than dropped in silence — a feed producing
    // these is a contract violation worth naming in the Phase 1 report.
    if (!externalId || !sourceUpdatedAt) {
      skipped += 1;
      continue;
    }

    if (!maxUpdatedAt || sourceUpdatedAt > maxUpdatedAt) {
      maxUpdatedAt = sourceUpdatedAt;
    }

    const existing = await prisma.rawRecord.findUnique({
      where: {
        storeId_app_entity_externalId: {
          storeId,
          app,
          entity: feed.entity,
          externalId,
        },
      },
      select: { id: true, sourceUpdatedAt: true },
    });

    if (existing && existing.sourceUpdatedAt.getTime() === sourceUpdatedAt.getTime()) {
      await prisma.rawRecord.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });
      duplicates += 1;
      continue;
    }

    await prisma.rawRecord.upsert({
      where: {
        storeId_app_entity_externalId: {
          storeId,
          app,
          entity: feed.entity,
          externalId,
        },
      },
      update: {
        sourceUpdatedAt,
        payload: row as Prisma.InputJsonValue,
        lastSeenAt: new Date(),
        // A row that comes back after a tombstone is alive again. The app is
        // the authority on that, not the tombstone we wrote last week.
        deletedAt: null,
      },
      create: {
        storeId,
        app,
        entity: feed.entity,
        externalId,
        sourceUpdatedAt,
        payload: row as Prisma.InputJsonValue,
      },
    });

    written += 1;

    // Order-grain snapshots are what the late-settling COD money needs
    // (G-GZR-4). Only order rows produce them; a parcel is not an order
    // (rule #1).
    if (feed.entity === "ORDER") {
      const outcome = await recordOrderSnapshot({
        storeId,
        orderId: externalId,
        payload: row as Prisma.InputJsonValue,
        isFinal: (row as Record<string, unknown>)?.isFinal === true,
      });
      if (outcome.kind === "written") snapshots += 1;
    }
  }

  let tombstoned = 0;
  for (const deleted of page.deletedIds ?? []) {
    const externalId =
      typeof deleted === "string"
        ? deleted
        : typeof deleted === "number"
          ? String(deleted)
          : null;
    if (!externalId) continue;

    const { count } = await prisma.rawRecord.updateMany({
      where: { storeId, app, entity: feed.entity, externalId, deletedAt: null },
      data: { deletedAt: new Date(), lastSeenAt: new Date() },
    });
    tombstoned += count;
  }

  return { written, duplicates, skipped, tombstoned, snapshots, maxUpdatedAt };
}

/** Sync one feed for one store, resuming wherever the last run stopped. */
export async function syncFeed(options: {
  storeId: string;
  shopDomain: string;
  app: SuiteApp;
  feed: EntityFeed;
  now?: Date;
}): Promise<FeedRunResult> {
  const { storeId, shopDomain, app, feed } = options;
  const now = options.now ?? new Date();

  const base: FeedRunResult = {
    app,
    entity: feed.entity,
    pages: 0,
    written: 0,
    duplicates: 0,
    tombstoned: 0,
    skipped: 0,
    snapshots: 0,
    finished: false,
  };

  const credentials = getAppCredentials(app);
  if (!credentials) {
    return { ...base, error: "not_configured" };
  }

  const state = await ensureState(storeId, app, feed.entity);

  if (!(await claimLease(state.id, now))) {
    return { ...base, error: "already_running" };
  }

  let cursor = state.cursor;
  let highWater = state.updatedSince;

  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) {
        params.set("cursor", cursor);
      } else if (state.updatedSince) {
        params.set("updatedSince", state.updatedSince.toISOString());
      }

      const response = await appRequest<ContractPage>(app, {
        pathWithQuery: `${feed.path}?${params.toString()}`,
        shopDomain,
        credentials,
      });

      if (!response.ok) {
        await prisma.syncState.update({
          where: { id: state.id },
          data: {
            status: "FAILED",
            runStartedAt: null,
            lastError: `${response.reason}: ${response.message}`.slice(0, 500),
            consecutiveFailures: { increment: 1 },
          },
        });
        return { ...base, error: response.reason };
      }

      base.pages += 1;
      await learnShopFacts(storeId, response.data);

      const result = await writePage({ storeId, app, feed, page: response.data });
      base.written += result.written;
      base.duplicates += result.duplicates;
      base.skipped += result.skipped;
      base.tombstoned += result.tombstoned;
      base.snapshots += result.snapshots;

      if (result.maxUpdatedAt && (!highWater || result.maxUpdatedAt > highWater)) {
        highWater = result.maxUpdatedAt;
      }

      const hasMore = response.data.pagination?.hasMore === true;
      const nextCursor = response.data.pagination?.nextCursor ?? null;

      // The cursor is advanced only AFTER its page is written. Dying between
      // the write and this update repeats a page; dying after it would have
      // skipped one, and a skipped page is a hole nobody notices.
      cursor = hasMore ? nextCursor : null;

      await prisma.syncState.update({
        where: { id: state.id },
        data: { cursor, rowsWritten: { increment: result.written } },
      });

      if (!hasMore || !nextCursor) {
        base.finished = true;
        break;
      }
    }

    await prisma.syncState.update({
      where: { id: state.id },
      data: {
        status: "IDLE",
        runStartedAt: null,
        lastSuccessAt: now,
        lastError: null,
        consecutiveFailures: 0,
        // The high-water mark only moves when the walk finished. Moving it
        // mid-walk would mean a later resume asks for changes "since" a point
        // past rows it has not read yet.
        ...(base.finished && highWater ? { updatedSince: highWater } : {}),
      },
    });

    return base;
  } catch (error) {
    await prisma.syncState.update({
      where: { id: state.id },
      data: {
        status: "FAILED",
        runStartedAt: null,
        lastError: (error instanceof Error ? error.message : "unknown").slice(0, 500),
        consecutiveFailures: { increment: 1 },
      },
    });
    return { ...base, error: "exception" };
  }
}

/** Every feed of every connected app, for one store. */
export async function syncStore(storeId: string): Promise<FeedRunResult[]> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      shopDomain: true,
      connections: {
        where: { status: "CONNECTED" },
        select: { app: true },
      },
    },
  });

  if (!store) return [];

  const results: FeedRunResult[] = [];

  // Apps are synced one after another rather than all at once. This box runs
  // four production apps on 2 vCPUs with swap already full (pack rule #1), and
  // Growzar's own pool is 2 connections in the worker.
  for (const connection of store.connections) {
    for (const feed of feedsFor(connection.app)) {
      results.push(
        await syncFeed({
          storeId: store.id,
          shopDomain: store.shopDomain,
          app: connection.app,
          feed,
        }),
      );
    }
  }

  return results;
}

export const SYNC_SETTINGS = { PAGE_LIMIT, MAX_PAGES_PER_RUN, LEASE_MS };
