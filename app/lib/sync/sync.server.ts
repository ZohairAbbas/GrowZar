import type { Prisma, SuiteApp, SyncEntity } from "@prisma/client";

import { prisma } from "../db.server";
import { appRequest } from "../apps/client.server";
import { getAppCredentials } from "../apps/registry.server";
import { fetchAppStatus } from "../apps/status.server";
import {
  extractId,
  extractTombstones,
  extractUpdatedAt,
  feedOffered,
  feedsFor,
  reportsPurge,
  type EntityFeed,
} from "./entities";
import { recordOrderSnapshot } from "./snapshots.server";
import { buyerFromOrderPayload, resolveCustomer } from "../customers/resolve.server";
import { acceptReportedCountry } from "./shop-country";
import { countryFromTimezone } from "../customers/phone";
import { parseEvent, type ShipmentEventRecord } from "../shipments/events";

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
/**
 * How far before the high-water mark each run starts asking.
 *
 * `updatedSince` is already inclusive (§6.2), which covers rows sharing the
 * boundary timestamp but not a row that committed late with an earlier one.
 * Courierify's report (finding 11) recommends a five-minute overlap for every
 * feed; the event log already holds rows back two minutes for the same
 * reason, and this is the belt beside those braces. It is cheap because the
 * repeats are deduplicated, not written.
 */
const UPDATED_SINCE_OVERLAP_MS = 5 * 60 * 1000;

/**
 * How long a connection's declared capabilities are trusted before asking the
 * app again. Nothing refreshed them after the claim before Phase 5, so every
 * connection still holds what its app said at connect time — often `[]`.
 */
const CAPABILITY_REFRESH_MS = 60 * 60 * 1000;

type ContractPage = {
  shop?: string;
  shopTimezone?: string;
  shopCurrency?: string;
  /** Not in §6.1 today; read when an app sends it (see phone.ts). */
  shopCountry?: string;
  data?: unknown[];
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
  customers: number;
  unparseablePhones: number;
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
async function learnShopFacts(storeId: string, app: SuiteApp, page: ContractPage) {
  const data: Prisma.StoreUpdateInput = {};

  if (page.shopCurrency && /^[A-Z]{3}$/.test(page.shopCurrency)) {
    data.currency = page.shopCurrency;
  }
  if (page.shopTimezone && page.shopTimezone.includes("/")) {
    data.timezone = page.shopTimezone;
  }

  // The shop's country, for normalising locally-written phone numbers
  // (rule #19). A reported country always beats an inferred one, and an
  // inference is recorded as such so nobody later reads it as fact. When
  // apps report different countries, the higher-ranked app's wins (shop-country.ts).
  const reported = page.shopCountry && /^[A-Za-z]{2}$/.test(page.shopCountry) ? page.shopCountry.toUpperCase() : null;
  const connected = reported
    ? (await prisma.appConnection.findMany({ where: { storeId, status: "CONNECTED" }, select: { app: true } })).map((c) => c.app)
    : [];
  if (reported && acceptReportedCountry(app, connected)) {
    data.country = reported;
    data.countryInferred = false;
  } else if (!reported && page.shopTimezone) {
    const inferred = countryFromTimezone(page.shopTimezone);
    if (inferred) {
      const current = await prisma.store.findUnique({
        where: { id: storeId },
        select: { country: true, countryInferred: true },
      });
      // Never overwrite something an app actually told us.
      if (!current?.country || current.countryInferred) {
        data.country = inferred;
        data.countryInferred = true;
      }
    }
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
  defaultRegion: string | null;
}): Promise<{
  written: number;
  duplicates: number;
  skipped: number;
  tombstoned: number;
  snapshots: number;
  customers: number;
  unparseablePhones: number;
  maxUpdatedAt: Date | null;
}> {
  const { storeId, app, feed, page, defaultRegion } = options;

  let written = 0;
  let duplicates = 0;
  let skipped = 0;
  let snapshots = 0;
  let customers = 0;
  let unparseablePhones = 0;
  let maxUpdatedAt: Date | null = null;

  for (const row of page.data ?? []) {
    const externalId = extractId(row, feed);
    const sourceUpdatedAt = extractUpdatedAt(row, feed.updatedAtField);

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
      select: { id: true, sourceUpdatedAt: true, deletedAt: true },
    });

    if (existing && existing.sourceUpdatedAt.getTime() === sourceUpdatedAt.getTime()) {
      await prisma.rawRecord.update({
        where: { id: existing.id },
        // A row the app still serves is alive, even unchanged: a purge marked
        // everything deleted, and a re-sent row must undo that.
        data: { lastSeenAt: new Date(), ...(existing.deletedAt ? { deletedAt: null } : {}) },
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

    // Growzar's own customer record (rule #19), built from whichever feed
    // carries a buyer — not from any app's customer count, because Courierify
    // groups by the raw phone string and counts spellings rather than people.
    //
    // Parcels count as well as orders. Rule #1 says a parcel is never counted
    // AS an order, which is about counting, not about identity: a Courierify
    // parcel carries `customer: { name, phone, phoneRaw }` on every row, and
    // Courierify has no orders endpoint at all. Reading only orders left a
    // Courierify-only merchant — which is most of them today — with an empty
    // customer record forever, while the identity sat in the data unused.
    if (feed.entity === "ORDER" || feed.entity === "PARCEL") {
      const resolved = await resolveCustomer({
        storeId,
        buyer: buyerFromOrderPayload(row),
        defaultRegion,
        seenAt: sourceUpdatedAt,
      });

      if (resolved?.created) customers += 1;
      if (resolved?.phoneProblem) unparseablePhones += 1;
    }
  }

  let tombstoned = 0;
  const graves = extractTombstones(page as Record<string, unknown>, feed);

  for (const tombstoneId of graves.ids) {
    const { count } = await prisma.rawRecord.updateMany({
      where: {
        storeId,
        app,
        entity: feed.entity,
        deletedAt: null,
        ...(feed.tombstoneMatchField
          ? { payload: { path: [feed.tombstoneMatchField], equals: tombstoneId } }
          : { externalId: tombstoneId }),
      },
      data: { deletedAt: new Date(), lastSeenAt: new Date() },
    });
    tombstoned += count;
  }

  // The app had more deletions than it could return. "No tombstones" and "too
  // many tombstones" must not look alike: a mass delete would otherwise pass
  // as nothing happening, and §6.2 exists precisely so deletions are never
  // inferred from absence.
  if (graves.truncated) {
    console.warn(
      `[sync] ${app}/${feed.entity} truncated its tombstone list for store ${storeId}; a full resync is needed to see every deletion`,
    );
  }

  return {
    written,
    duplicates,
    skipped,
    tombstoned,
    snapshots,
    customers,
    unparseablePhones,
    maxUpdatedAt,
  };
}

type PageOutcome = Awaited<ReturnType<typeof writePage>>;

/**
 * Write one page of the shipment event log (G-GZR2-1).
 *
 * Events are immutable, so this is insert-or-ignore on the event key and
 * nothing else: no update path, no `lastSeenAt`, no tombstones. One statement
 * per page rather than one per row, because this feed is the largest thing
 * Growzar stores and the worker has two connections.
 *
 * `courierEventAt` is written exactly as parsed. A null stays null: it is
 * what makes a screen say "status as of" instead of "delivered on" (rule #9).
 */
async function writeShipmentEventsPage(options: {
  storeId: string;
  app: SuiteApp;
  page: ContractPage;
}): Promise<PageOutcome> {
  const { storeId, app, page } = options;
  const events: ShipmentEventRecord[] = [];
  const rejected = new Map<string, number>();
  let maxUpdatedAt: Date | null = null;

  for (const row of page.data ?? []) {
    const parsed = parseEvent(row);
    if (!parsed.ok) {
      rejected.set(parsed.reason, (rejected.get(parsed.reason) ?? 0) + 1);
      continue;
    }
    events.push(parsed.event);
    if (!maxUpdatedAt || parsed.event.sourceCreatedAt > maxUpdatedAt) {
      maxUpdatedAt = parsed.event.sourceCreatedAt;
    }
  }

  // Counted and named, never dropped quietly: a row the feed sends and we
  // refuse is a contract finding.
  if (rejected.size > 0) {
    const detail = [...rejected].map(([reason, n]) => `${reason}=${n}`).join(", ");
    console.warn(`[sync] ${app}/SHIPMENT_EVENT store=${storeId} rejected rows: ${detail}`);
  }

  const { count } = events.length
    ? await prisma.shipmentEvent.createMany({
        data: events.map((event) => ({ storeId, ...event })),
        skipDuplicates: true,
      })
    : { count: 0 };

  return {
    written: count,
    duplicates: events.length - count,
    skipped: [...rejected.values()].reduce((a, b) => a + b, 0),
    tombstoned: 0,
    snapshots: 0,
    customers: 0,
    unparseablePhones: 0,
    maxUpdatedAt,
  };
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
    customers: 0,
    unparseablePhones: 0,
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
  let purgeApplied = false;

  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const params = new URLSearchParams({ limit: String(feed.pageLimit ?? PAGE_LIMIT) });
      for (const [key, value] of Object.entries(feed.query ?? {})) {
        params.set(key, value);
      }
      if (cursor) {
        params.set("cursor", cursor);
      } else if (state.updatedSince) {
        const since = new Date(state.updatedSince.getTime() - UPDATED_SINCE_OVERLAP_MS);
        params.set("updatedSince", since.toISOString());
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
      await learnShopFacts(storeId, app, response.data);

      // The app wiped this shop's data while staying installed, so everything
      // Growzar holds from this feed is gone. Rows already re-read in this run
      // have a newer `lastSeenAt` and survive; any later row revives itself.
      if (!purgeApplied && feed.sink !== "shipment_events" && reportsPurge(response.data)) {
        purgeApplied = true;
        const { count } = await prisma.rawRecord.updateMany({
          where: { storeId, app, entity: feed.entity, deletedAt: null, lastSeenAt: { lt: now } },
          data: { deletedAt: new Date() },
        });
        base.tombstoned += count;
        console.warn(`[sync] ${app}/${feed.entity} reports a purge for store ${storeId}; ${count} rows marked deleted`);
      }

      // Re-read each page: `learnShopFacts` may have just taught us the
      // country, and the first page of the first feed is exactly when that
      // happens.
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { country: true },
      });

      const result =
        feed.sink === "shipment_events"
          ? await writeShipmentEventsPage({ storeId, app, page: response.data })
          : await writePage({
              storeId,
              app,
              feed,
              page: response.data,
              defaultRegion: store?.country ?? null,
            });
      base.written += result.written;
      base.duplicates += result.duplicates;
      base.skipped += result.skipped;
      base.tombstoned += result.tombstoned;
      base.snapshots += result.snapshots;
      base.customers += result.customers;
      base.unparseablePhones += result.unparseablePhones;

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

/**
 * The connection's capabilities, re-asked from the app at most hourly, and
 * only for apps with capability-gated feeds. A failed or "not installed"
 * answer keeps what is stored: deciding a disconnect is not the sync's job.
 */
async function currentCapabilities(
  connection: { id: string; app: SuiteApp; capabilities: string[]; updatedAt: Date },
  shopDomain: string,
  now = new Date(),
): Promise<string[]> {
  if (!feedsFor(connection.app).some((f) => f.capability)) return connection.capabilities;
  if (now.getTime() - connection.updatedAt.getTime() < CAPABILITY_REFRESH_MS) return connection.capabilities;

  const result = await fetchAppStatus(connection.app, shopDomain);
  if (!result.ok || !result.status.installed) return connection.capabilities;

  // Written even when unchanged: `updatedAt` is what spaces out the checks.
  await prisma.appConnection.update({
    where: { id: connection.id },
    data: { capabilities: result.status.capabilities },
  });
  return result.status.capabilities;
}

/** Every feed of every connected app that the app says it serves, for one store. */
export async function syncStore(storeId: string): Promise<FeedRunResult[]> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      shopDomain: true,
      connections: {
        where: { status: "CONNECTED" },
        select: { id: true, app: true, capabilities: true, updatedAt: true },
      },
    },
  });

  if (!store) return [];

  const results: FeedRunResult[] = [];

  // Apps are synced one after another rather than all at once. This box runs
  // four production apps on 2 vCPUs with swap already full (pack rule #1), and
  // Growzar's own pool is 2 connections in the worker.
  for (const connection of store.connections) {
    const capabilities = await currentCapabilities(connection, store.shopDomain);
    for (const feed of feedsFor(connection.app).filter((f) => feedOffered(f, capabilities))) {
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

export const SYNC_SETTINGS = {
  PAGE_LIMIT,
  MAX_PAGES_PER_RUN,
  LEASE_MS,
  UPDATED_SINCE_OVERLAP_MS,
  CAPABILITY_REFRESH_MS,
};
