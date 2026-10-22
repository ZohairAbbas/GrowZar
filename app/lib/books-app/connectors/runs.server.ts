import type { BkConnector, Prisma } from "@prisma/client";

import { prisma } from "../../db.server";
import { fromDbDate, getBook, postDocument, toDbDate, type BookView } from "../../books/books.server";
import type { ConnectorKey } from "../../books/connectors/registry";

/**
 * Connector runs (B3), as Financify's Books runs them (porting guide §4.10):
 * one run at a time per connector, taken with a lock on its row (a run older
 * than 15 minutes is treated as dead); every run is logged with what it did
 * and why anything was left out, as plain words. Growzar's worker awaits runs
 * one after another rather than starting them in the background, because the
 * box has two worker connections to spend.
 */
const STALE_MINUTES = 15;

export type RunStatus = "ok" | "partial" | "error";

export interface RunResult {
  status: RunStatus;
  created: number;
  updated: number;
  skipped: number;
  /** Plain-words notes; the first few become the run's message. */
  notes: string[];
  from: string | null;
  to: string | null;
}

export type Runner = (book: BookView, connector: BkConnector) => Promise<RunResult>;

export interface ConnectorView {
  key: ConnectorKey;
  exists: boolean;
  enabled: boolean;
  mode: "draft" | "auto";
  startDate: string | null;
  syncedThrough: string | null;
  running: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  settings: Record<string, unknown>;
}

export function toView(key: ConnectorKey, c: BkConnector | null): ConnectorView {
  return {
    key,
    exists: !!c,
    enabled: !!c?.enabled,
    mode: c?.mode === "auto" ? "auto" : "draft",
    startDate: fromDbDate(c?.startDate),
    syncedThrough: fromDbDate(c?.syncedThrough),
    running: !!c?.runningSince && Date.now() - c.runningSince.getTime() < STALE_MINUTES * 60_000,
    lastRunAt: c?.lastRunAt?.toISOString() ?? null,
    lastStatus: c?.lastStatus ?? null,
    lastMessage: c?.lastMessage ?? null,
    settings: (c?.settings ?? {}) as Record<string, unknown>,
  };
}

export async function getConnector(book: BookView, key: ConnectorKey): Promise<ConnectorView> {
  return toView(key, await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId: book.id, key } } }));
}

export async function listRuns(book: BookView, key: ConnectorKey, take = 10) {
  return prisma.bkConnectorRun.findMany({ where: { bookId: book.id, connector: { key } }, orderBy: { startedAt: "desc" }, take });
}

export function runMessage(r: Pick<RunResult, "created" | "updated" | "notes">): string {
  const counts = r.created || r.updated ? `${r.created} new, ${r.updated} refreshed` : null;
  return [counts, ...r.notes.slice(0, 8), r.notes.length > 8 ? `and ${r.notes.length - 8} more` : null].filter(Boolean).join(". ") || "Nothing new";
}

/**
 * Run a connector now: take its lock, run, record the run, release the lock.
 * Returns null when it's off or another run holds the lock.
 */
export async function runConnector(book: BookView, key: ConnectorKey, trigger: "manual" | "auto", runner: Runner): Promise<RunResult | null> {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE bk_connectors SET "runningSince" = now()
     WHERE "bookId" = ${book.id} AND key = ${key} AND enabled = true
       AND ("runningSince" IS NULL OR "runningSince" < now() - make_interval(mins => ${STALE_MINUTES}))
     RETURNING id`;
  const id = locked[0]?.id;
  if (!id) return null;
  const run = await prisma.bkConnectorRun.create({ data: { connectorId: id, bookId: book.id, trigger } });
  let result: RunResult;
  try {
    // Re-read the book and the connector under the lock: settings may have changed since the caller looked.
    const [fresh, connector] = await Promise.all([getBook(book.organizationId), prisma.bkConnector.findUniqueOrThrow({ where: { id } })]);
    result = await runner(fresh ?? book, connector);
  } catch (e) {
    console.error(`[books] ${key} run failed`, { bookId: book.id, error: e instanceof Error ? e.message : String(e) });
    result = { status: "error", created: 0, updated: 0, skipped: 0, notes: ["Something went wrong. Books will try again on the next run."], from: null, to: null };
  }
  const message = runMessage(result);
  await prisma.bkConnectorRun.update({
    where: { id: run.id },
    data: { status: result.status, created: result.created, updated: result.updated, skipped: result.skipped, message, fromDate: result.from ? toDbDate(result.from) : null, toDate: result.to ? toDbDate(result.to) : null, finishedAt: new Date() },
  });
  await prisma.bkConnector.update({ where: { id }, data: { runningSince: null, lastRunAt: new Date(), lastStatus: result.status, lastMessage: message } });
  return result;
}

/**
 * Save a connector's switch, mode, first day and settings. Switching from
 * drafts to automatic saves the drafts it already made, oldest first; a
 * new first day starts it over from that day.
 */
export async function saveConnector(
  book: BookView,
  key: ConnectorKey,
  input: { enabled: boolean; mode: "draft" | "auto"; startDate: string; settings: Prisma.InputJsonValue },
  actor: string | null,
): Promise<{ posted: number; left: number } | null> {
  const before = await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId: book.id, key } } });
  const restart = !before || fromDbDate(before.startDate) !== input.startDate;
  await prisma.$transaction(async (tx) => {
    await tx.bkConnector.upsert({
      where: { bookId_key: { bookId: book.id, key } },
      create: { bookId: book.id, key, enabled: input.enabled, mode: input.mode, startDate: toDbDate(input.startDate), settings: input.settings },
      update: { enabled: input.enabled, mode: input.mode, startDate: toDbDate(input.startDate), settings: input.settings, ...(restart ? { syncedThrough: null } : {}) },
    });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "connector.saved", detail: { key, enabled: input.enabled, mode: input.mode, startDate: input.startDate, restart } } });
  });
  if (input.enabled && input.mode === "auto" && before?.mode !== "auto") return postConnectorDrafts(book, key, actor);
  return null;
}

/** Save a connector's waiting drafts, oldest first; one that can't be saved stays a draft. */
export async function postConnectorDrafts(book: BookView, key: ConnectorKey, actor: string | null): Promise<{ posted: number; left: number }> {
  const drafts = await prisma.bkDocument.findMany({ where: { bookId: book.id, source: key, status: "draft" }, select: { id: true }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] });
  let posted = 0;
  for (const d of drafts) {
    try {
      await postDocument(book, d.id, actor);
      posted++;
    } catch {
      // Stays a draft; the inbox shows it with the reason when it's opened.
    }
  }
  if (drafts.length) await prisma.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "connector.drafts_posted", detail: { key, posted, left: drafts.length - posted } } });
  return { posted, left: drafts.length - posted };
}
