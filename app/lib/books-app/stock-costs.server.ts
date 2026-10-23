import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { appRequest, type AppRequestError } from "../apps/client.server";
import { BooksError, type BookView } from "../books/books.server";
import { currencyDecimals } from "../books/money";
import { inventorifyStock } from "./stock.server";

/**
 * Setting Shopify's "Cost per item" from Books (v1.1 V7, D-77, D-102),
 * ported from Financify's setShopifyCosts: for items the stock check found
 * with no cost, the owner types each one's cost. Growzar holds no Shopify
 * write access, so Inventorify writes it (G-INV-C1): a preview that changes
 * nothing, then a confirm of exactly that preview, once (Idempotency-Key).
 *
 * What it doesn't do: sales already in the books keep the cost they came in
 * with (a saved day is never rewritten). Inventorify updates its own unit
 * cost with Shopify's, so the next sync brings it here and the next stock
 * check values those items.
 */

export const COSTS_CAPABILITY = "costs:write";
/** Per preview and confirm: a full 250 can take Inventorify ~30 s on a throttled shop. */
export const MAX_ITEMS = 50;
const PREVIEW_PATH = "/api/v1/growzar/costs/preview";
const CONFIRM_PATH = "/api/v1/growzar/costs/confirm";
const CONFIRM_TIMEOUT_MS = 60_000;

type Money = { amount: string; currency: string };

export type CostPreview = {
  storeId: string;
  previewId: string;
  expiresAt: string;
  currency: string;
  /** Sent with the confirm, so pressing it again never writes twice. */
  key: string;
  items: Array<{ variantId: string; name: string; sku: string | null; current: string | null; proposed: string; change: "set" | "same" | "refused"; reason: string | null }>;
};

export type CostResult = { set: number; failed: number; items: Array<{ variantId: string; name: string; ok: boolean; reason: string | null }> };

const REFUSED: Record<string, string> = {
  not_found: "Shopify doesn't have this item for the store",
  currency_mismatch: "not in the store's currency",
  invalid_amount: "not a cost",
  negative_amount: "below 0",
  too_many_decimals: "too many decimal places",
  archived: "archived in Shopify",
  changed_since_preview: "its cost changed in Shopify since the preview, so it was left as it is",
  shopify_rejected: "Shopify didn't accept it",
  throttled: "Shopify was busy; try it again",
  shop_not_connected: "Inventorify isn't connected to the store",
  shopify_error: "Shopify couldn't be reached; try it again",
};
const reasonText = (code: unknown, message?: unknown) => {
  const c = typeof code === "string" ? code : "";
  const base = REFUSED[c] ?? (c || "not accepted");
  return c === "shopify_rejected" && typeof message === "string" && message ? `${base}: ${message}` : base;
};

/** The store, if it's in the book and Inventorify can write costs for it. */
export async function costsStore(book: BookView, storeId: string) {
  if (!(book.settings.storeIds ?? []).includes(storeId)) throw new BooksError("That store isn't in these books");
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, shopDomain: true, currency: true, connections: { where: { app: "INVENTORIFY", status: "CONNECTED" }, select: { capabilities: true } } },
  });
  if (!store?.connections.some((c) => c.capabilities.includes(COSTS_CAPABILITY))) throw new BooksError("Inventorify can't set costs in Shopify for this store yet.");
  return { id: store.id, shopDomain: store.shopDomain, currency: store.currency ?? book.currency };
}

/** Stores in the book where Inventorify can write costs. */
export async function costsStoreIds(book: BookView): Promise<Set<string>> {
  const rows = await prisma.appConnection.findMany({ where: { storeId: { in: book.settings.storeIds ?? [] }, app: "INVENTORIFY", status: "CONNECTED", capabilities: { has: COSTS_CAPABILITY } }, select: { storeId: true } });
  return new Set(rows.map((r) => r.storeId));
}

/** Items with stock and no cost, most units first: what the card offers. */
export async function itemsWithNoCost(book: BookView, storeId: string) {
  const { items } = await inventorifyStock(book, storeId);
  return items
    .filter((i) => i.state === "no_cost" && i.units > 0)
    .sort((a, b) => b.units - a.units || a.name.localeCompare(b.name))
    .map((i) => ({ variantId: i.variantId, name: i.name, sku: i.sku, units: i.units }));
}

/** "450", "450.5" → "450.50" in the currency's places; null when it isn't a cost above 0. */
export function normaliseCost(input: string, currency: string): string | null {
  const t = input.replace(/,/g, "").trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const places = currencyDecimals(currency);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > places) return null;
  const whole = m[1]!.replace(/^0+(?=\d)/, "");
  const out = places ? `${whole}.${frac.padEnd(places, "0")}` : whole;
  return /[1-9]/.test(out) ? out : null;
}

function requestError(r: AppRequestError, step: "preview" | "confirm"): BooksError {
  switch (r.errorType) {
    case "forbidden":
      return new BooksError(step === "confirm" ? "Only the person who made the preview can confirm it. Preview again." : "Inventorify can't set costs in Shopify for this store: it needs permission to change products there.");
    case "preview_expired":
      return new BooksError("The preview is more than 15 minutes old. Preview again.");
    case "preview_already_confirmed":
      return new BooksError("These costs were already sent to Shopify.");
    case "idempotency_key_conflict":
      return new BooksError("These costs are still being sent. Give it a minute, then press Confirm again: nothing is sent twice.");
    case "shop_not_connected":
      return new BooksError(`Inventorify isn't connected to this store any more. Nothing was changed.`);
    case "shopify_error":
      return new BooksError(step === "confirm" ? "Shopify couldn't be reached. Nothing was changed: press Confirm again in a minute." : "Shopify couldn't be reached. Try again in a minute.");
    case "not_found":
      return new BooksError("Inventorify doesn't know that preview. Preview again.");
  }
  if (r.reason === "rate_limited" || r.reason === "circuit_open") return new BooksError("Inventorify is busy. Try again in a minute.");
  if (step === "confirm" && (r.reason === "timeout" || r.reason === "network" || r.reason === "server_error"))
    return new BooksError("No answer from Inventorify in time. It may still be working: press Confirm again in a minute. Nothing is sent twice.");
  return new BooksError("Inventorify couldn't be reached. Try again in a minute.");
}

const KEY = "shopify_costs";
type Held = { previews?: Record<string, CostPreview & { actor: string }> };

async function held(book: BookView): Promise<Held> {
  const c = await prisma.bkConnector.findUnique({ where: { bookId_key: { bookId: book.id, key: KEY } }, select: { settings: true } });
  return (c?.settings ?? {}) as Held;
}

async function keep(book: BookView, storeId: string, preview: (CostPreview & { actor: string }) | null) {
  const previews = { ...((await held(book)).previews ?? {}) };
  if (preview) previews[storeId] = preview;
  else delete previews[storeId];
  const settings = { previews } as unknown as Prisma.InputJsonValue;
  await prisma.bkConnector.upsert({ where: { bookId_key: { bookId: book.id, key: KEY } }, create: { bookId: book.id, key: KEY, enabled: true, settings }, update: { settings } });
}

/** The preview this person is looking at for a store, while it can still be confirmed. */
export async function heldPreview(book: BookView, storeId: string, actor: string, now = new Date()): Promise<CostPreview | null> {
  const p = (await held(book)).previews?.[storeId];
  if (!p || p.actor !== actor || Date.parse(p.expiresAt) <= now.getTime()) return null;
  const { actor: _, ...preview } = p;
  return preview;
}

export async function dropPreview(book: BookView, storeId: string) {
  await keep(book, storeId, null);
}

/** Ask Inventorify what would change. Nothing is written in Shopify; the preview is kept for the confirm. */
export async function previewCosts(book: BookView, storeId: string, wanted: Array<{ variantId: string; cost: string }>, actor: string): Promise<CostPreview> {
  const store = await costsStore(book, storeId);
  const known = new Map((await itemsWithNoCost(book, storeId)).map((i) => [i.variantId, i]));
  const items: Array<{ variantId: string; cost: Money }> = [];
  for (const w of wanted) {
    if (!w.cost.trim()) continue;
    const item = known.get(w.variantId);
    if (!item) continue;
    const amount = normaliseCost(w.cost, store.currency);
    if (amount === null) throw new BooksError(`${item.name}: enter a cost above 0, like 450${currencyDecimals(store.currency) ? " or 450.50" : ""}`);
    items.push({ variantId: w.variantId, cost: { amount, currency: store.currency } });
  }
  if (items.length === 0) throw new BooksError("Enter a cost for at least one item");
  if (items.length > MAX_ITEMS) throw new BooksError(`At most ${MAX_ITEMS} items at a time`);
  const r = await appRequest<{
    previewId: string;
    expiresAt: string;
    currency: string;
    items: Array<{ variantId: string; title: string | null; sku: string | null; current: Money | null; proposed: Money; change: "set" | "same" | "refused"; reason?: string }>;
  }>("INVENTORIFY", { method: "POST", pathWithQuery: PREVIEW_PATH, shopDomain: store.shopDomain, body: { items }, headers: { "X-Growzar-User": actor } });
  if (!r.ok) throw requestError(r, "preview");
  const preview: CostPreview = {
    storeId,
    previewId: r.data.previewId,
    expiresAt: r.data.expiresAt,
    currency: r.data.currency,
    key: randomUUID(),
    items: r.data.items.map((i) => ({
      variantId: String(i.variantId),
      name: known.get(String(i.variantId))?.name ?? i.title ?? `Variant ${i.variantId}`,
      sku: known.get(String(i.variantId))?.sku ?? i.sku ?? null,
      current: i.current?.amount ?? null,
      proposed: i.proposed.amount,
      change: i.change,
      reason: i.change === "refused" ? reasonText(i.reason) : null,
    })),
  };
  await keep(book, storeId, { ...preview, actor });
  return preview;
}

/** Write the kept preview's "set" items to Shopify through Inventorify, once (pressing it again replays). */
export async function confirmCosts(book: BookView, storeId: string, actor: string): Promise<CostResult> {
  const store = await costsStore(book, storeId);
  const preview = await heldPreview(book, storeId, actor);
  if (!preview) throw new BooksError("Preview the costs first (a preview lasts 15 minutes).");
  if (!preview.items.some((i) => i.change === "set")) throw new BooksError("Nothing in this preview would change.");
  const r = await appRequest<{ items: Array<{ variantId: string; result: "set" | "failed"; reason?: string; message?: string }> }>("INVENTORIFY", {
    method: "POST",
    pathWithQuery: CONFIRM_PATH,
    shopDomain: store.shopDomain,
    body: { previewId: preview.previewId },
    headers: { "X-Growzar-User": actor, "Idempotency-Key": preview.key },
    timeoutMs: CONFIRM_TIMEOUT_MS,
    maxAttempts: 1,
  });
  if (!r.ok) {
    // Kept only when pressing Confirm again can still help (nothing written, or it may still be running).
    if (["forbidden", "preview_expired", "preview_already_confirmed", "not_found"].includes(r.errorType ?? "")) await dropPreview(book, storeId);
    throw requestError(r, "confirm");
  }
  const names = new Map(preview.items.map((i) => [i.variantId, i.name]));
  const items = r.data.items.map((i) => ({ variantId: String(i.variantId), name: names.get(String(i.variantId)) ?? `Variant ${i.variantId}`, ok: i.result === "set", reason: i.result === "set" ? null : reasonText(i.reason, i.message) }));
  const set = items.filter((i) => i.ok).length;
  await dropPreview(book, storeId);
  if (set) await prisma.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "stock.costs_set_in_shopify", detail: { items: set, failed: items.length - set, storeId, previewId: preview.previewId } } });
  return { set, failed: items.length - set, items };
}
