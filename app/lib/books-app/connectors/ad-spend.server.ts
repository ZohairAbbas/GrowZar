import type { BkConnector, Prisma } from "@prisma/client";

import { prisma } from "../../db.server";
import { BooksError, discardDraft, listAccounts, postDocument, upsertImported, type BookView } from "../../books/books.server";
import { isMoneySubtype } from "../../books/chart";
import { formatDate, todayIn } from "../../books/dates";
import { formatAmount } from "../../books/money";
import { addDays, isIsoDate } from "../../books/posting";
import {
  buildAdDay,
  correctionDate,
  daysToCheck,
  decimalToMinor,
  difference,
  platformName,
  toPosting,
  toSums,
  type AdPlatformMapping,
  type AdSpendSettings,
  type Posting,
} from "./ad-spend";
import type { RunResult } from "./runs.server";

/** The platforms the book's stores have spend on, from Growzar's own ad data. */
export async function adPlatforms(book: BookView): Promise<string[]> {
  const rows = await prisma.adSpend.findMany({
    where: { storeId: { in: book.settings.storeIds ?? [] }, level: "platform" },
    distinct: ["key"],
    select: { key: true },
  });
  return rows.map((r) => r.key).sort();
}

/** Suggested accounts: Advertising for spend and its charges, paid from a card, else a bank account. */
export async function adSpendDefaults(book: BookView): Promise<AdSpendSettings> {
  const [accounts, platforms] = await Promise.all([listAccounts(book), adPlatforms(book)]);
  const live = accounts.filter((a) => !a.archived && !a.currency);
  const ads = live.find((a) => a.code === "6000")?.id ?? "";
  const paidFrom = live.find((a) => a.subtype === "card")?.id ?? live.find((a) => a.subtype === "bank")?.id ?? "";
  return { platforms: Object.fromEntries(platforms.map((p) => [p, { advertising: ads, fees: ads, paidFrom }])) };
}

/** Check each platform's accounts; every message names the field. */
export async function checkAdSpendSettings(book: BookView, settings: AdSpendSettings): Promise<AdSpendSettings> {
  const accounts = await listAccounts(book);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const platforms: Record<string, AdPlatformMapping> = {};
  for (const [p, m] of Object.entries(settings.platforms ?? {})) {
    const need = (id: string, field: keyof AdPlatformMapping, ok: (a: (typeof accounts)[number]) => boolean, what: string) => {
      const a = byId.get(id);
      if (!a || a.archived) throw new BooksError(`Choose an account for ${what}`, `platforms.${p}.${field}`);
      if (a.currency) throw new BooksError(`"${a.name}" is in ${a.currency}; ad spend comes in ${book.currency}. Choose another account.`, `platforms.${p}.${field}`);
      if (!ok(a)) throw new BooksError(`"${a.name}" can't be used for ${what}`, `platforms.${p}.${field}`);
    };
    const name = platformName(p);
    need(m.advertising, "advertising", (a) => a.type === "expense", `${name} spend`);
    need(m.fees, "fees", (a) => a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype)), `${name} taxes and charges`);
    need(m.paidFrom, "paidFrom", (a) => isMoneySubtype(a.subtype) || (a.type === "liability" && a.subtype === "payable"), `what ${name} is paid from`);
    platforms[p] = { advertising: m.advertising, fees: m.fees, paidFrom: m.paidFrom };
  }
  return { platforms };
}

type DocRow = { id: string; sourceRef: string; status: string; data: Prisma.JsonValue; number: string | null };

const isCorrectionOf = (ref: string, base: string) => ref.startsWith(`${base}:c`);

/**
 * One run: every store's platform-days from the start (or where the last run
 * ended) to yesterday, re-checking the last 35 days for corrections.
 */
export async function runAdSpend(book: BookView, connector: BkConnector): Promise<RunResult> {
  const r: RunResult = { status: "ok", created: 0, updated: 0, skipped: 0, notes: [], from: null, to: null };
  const settings = (connector.settings ?? {}) as unknown as AdSpendSettings;
  const start = connector.startDate?.toISOString().slice(0, 10);
  if (!start || !settings.platforms) return { ...r, status: "error", notes: ["Finish setting up ad spend first"] };
  const today = todayIn(book.settings.timeZone);
  const win = daysToCheck(start, connector.syncedThrough?.toISOString().slice(0, 10) ?? null, addDays(today, -1), addDays);
  if (!win) return r;
  r.from = win.from;
  r.to = win.to;
  const storeIds = book.settings.storeIds ?? [];
  const [rows, stores] = await Promise.all([
    prisma.adSpend.findMany({ where: { storeId: { in: storeIds }, level: "platform", day: { gte: win.from, lte: win.to } }, orderBy: [{ day: "asc" }, { storeId: "asc" }, { key: "asc" }] }),
    prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, shopDomain: true, displayName: true } }),
  ]);
  const storeName = new Map(stores.map((s) => [s.id, s.displayName ?? s.shopDomain]));
  // Everything already brought in for these days: originals, and corrections dated anywhere.
  const docs = await prisma.$queryRaw<DocRow[]>`
    SELECT id, "sourceRef", status, data, number FROM bk_documents
     WHERE "bookId" = ${book.id} AND source = 'ad_spend' AND "sourceRef" NOT LIKE '%~%'
       AND split_part("sourceRef", ':', 3) BETWEEN ${win.from} AND ${win.to}`;
  const byRef = new Map(docs.map((d) => [d.sourceRef, d]));
  const unmapped = new Set<string>();
  const money = (v: bigint) => formatAmount(v, book.decimals, { currency: book.currency });

  const save = async (input: { sourceRef: string; date: string; data: Posting & { platform: string; correctionOf?: string | null }; memo: string; storeId: string }) => {
    const res = await upsertImported(book, { source: "ad_spend", type: "ad_spend", ...input });
    if (res.action === "created") r.created++;
    else if (res.action === "updated") r.updated++;
    else r.skipped++;
    if (connector.mode === "auto" && res.doc.status === "draft") {
      try {
        await postDocument(book, res.doc.id, null);
      } catch (e) {
        r.status = "partial";
        r.notes.push(`${input.memo}: kept as a draft (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  };

  for (const row of rows) {
    const m = settings.platforms[row.key];
    const label = `${platformName(row.key)}, ${storeName.get(row.storeId) ?? "a store"}, ${formatDate(row.day)}`;
    if (!m) {
      unmapped.add(row.key);
      continue;
    }
    // Version 1 keeps one currency (D-89); Financify converts to the store's currency, which setup checked.
    if (row.currency !== book.currency) {
      r.status = "partial";
      r.notes.push(`${label}: spend is in ${row.currency}, not ${book.currency}, so it's left out`);
      continue;
    }
    if (row.fxStatus && row.fxStatus !== "ok") {
      r.status = "partial";
      r.notes.push(`${label}: Financify couldn't convert this day's spend yet, so it waits`);
      continue;
    }
    const spend = decimalToMinor(row.spendAmount.toString(), book.decimals);
    const fees = decimalToMinor(row.feesAmount.toString(), book.decimals);
    const current = buildAdDay(spend, fees, m);
    const base = `${row.storeId}:${row.key}:${row.day}`;
    const original = byRef.get(base);
    const memo = `${platformName(row.key)} ad spend, ${formatDate(row.day)}: ${money(spend)}${fees ? ` + ${money(fees)} taxes and charges` : ""}`;

    if (!original || original.status === "draft") {
      if (current.size === 0) continue;
      await save({ sourceRef: base, date: row.day, data: { platform: row.key, ...toPosting(current) }, memo, storeId: row.storeId });
      continue;
    }
    // The merchant cancelled this day: their call stands.
    if (original.status === "cancelled") continue;

    const corrections = docs.filter((d) => isCorrectionOf(d.sourceRef, base));
    const posted = corrections.filter((d) => d.status === "posted");
    const draft = corrections.find((d) => d.status === "draft");
    const delta = difference(current, [original, ...posted].map((d) => toSums(d.data as Posting)));
    if (delta.size === 0) {
      if (draft) await discardDraft(book, draft.id, null);
      continue;
    }
    // A correction the merchant cancelled for exactly this difference isn't raised again.
    const declined = corrections.some((d) => d.status === "cancelled" && difference(delta, [toSums(d.data as Posting)]).size === 0);
    if (declined) {
      r.skipped++;
      continue;
    }
    const ref = draft?.sourceRef ?? `${base}:c${posted.length + 1}`;
    const change = (delta.get(m.advertising) ?? 0n) + (m.fees !== m.advertising ? delta.get(m.fees) ?? 0n : 0n);
    await save({
      sourceRef: ref,
      date: correctionDate(row.day, book.lockedThrough, today),
      data: { platform: row.key, correctionOf: original.number, ...toPosting(delta) },
      memo: `${platformName(row.key)} corrected its ad spend for ${formatDate(row.day)} by ${change < 0n ? "−" : "+"}${money(change < 0n ? -change : change)} (${original.number})`,
      storeId: row.storeId,
    });
  }

  for (const p of unmapped) {
    r.status = "partial";
    r.notes.push(`${platformName(p)} has spend but isn't set up in Books yet. Open Ad spend and save it`);
  }
  await prisma.bkConnector.update({ where: { id: connector.id }, data: { syncedThrough: new Date(`${win.to}T00:00:00.000Z`) } });
  return r;
}

/** The settings form's input, checked: first day and each platform's accounts. */
export async function parseAdSpendForm(book: BookView, input: { enabled: boolean; mode: string; startDate: string; platforms: AdSpendSettings["platforms"] }, today: string) {
  if (!isIsoDate(input.startDate)) throw new BooksError("Choose the first day to bring in", "startDate");
  if (input.startDate > today) throw new BooksError("The first day can't be in the future", "startDate");
  const bookStart = book.settings.startDate;
  if (bookStart && input.startDate < bookStart) throw new BooksError(`Your books start on ${formatDate(bookStart)}; choose that day or later`, "startDate");
  const settings = await checkAdSpendSettings(book, { platforms: input.platforms });
  return { enabled: input.enabled, mode: input.mode === "auto" ? ("auto" as const) : ("draft" as const), startDate: input.startDate, settings };
}
