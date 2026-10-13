import type { Money } from "./money";

/**
 * "Next app for your store" on Home (G-GZR6-3, cross-sell). For each suite
 * app the store has not connected, one problem Growzar can already measure
 * from the apps it has, in the store's own numbers; the app is named as what
 * acts on it. Money is what was measured (orders that came back, orders with
 * no courier tracking, what one-time buyers spent), never what the app would
 * save (decided 2026-10-13: at stake only). The biggest amount leads; the
 * rest are listed under it.
 */

export type PromptApp = "PREVENTIFY" | "WHATKABOT" | "RETAINIFY" | "COURIERIFY" | "INVENTORIFY" | "FINANCIFY";

export type StoreFacts = {
  currency: string | null;
  days: number;
  /** Orders that came back in the window, in the store's currency. */
  returns: { orders: number; value: Money | null };
  /** Returned orders nobody confirmed with the buyer. */
  unconfirmedReturns: { orders: number; value: Money | null };
  /** Buyers whose only order, delivered 45–180 days ago, was never followed by another. */
  oneTimeBuyers: { buyers: number; value: Money | null };
  /** Orders shipped in the window that no Courierify parcel covers. */
  untracked: { orders: number; value: Money | null };
  /** The ten best-selling variants' share of the last 30 days' orders, and how many variants sold. */
  topSellers: { orders: number; share: number | null; variants: number };
  /** Delivered orders in the window. */
  delivered: { orders: number; value: Money | null };
};

export type AppPrompt = {
  app: PromptApp;
  headline: string;
  body: string;
  /** The measured amount the headline names; null for a count-only prompt. */
  amount: Money | null;
};

/** Below these, a figure is noise and the app is not pitched on it. */
export const MIN = { returns: 20, unconfirmedReturns: 10, oneTimeBuyers: 50, untracked: 20, topSellerOrders: 30, topSellerVariants: 15, delivered: 20 } as const;

const n = (x: number) => x.toLocaleString("en-GB");
const whole = (m: Money) => `${m.currency} ${n(Math.round(Number(m.amount)))}`;

/** The prompts for apps the store lacks, biggest measured amount first; count-only prompts after. */
export function nextAppPrompts(facts: StoreFacts, connected: ReadonlySet<string>, canSeeMoney: boolean): AppPrompt[] {
  const money = (m: Money | null) => (canSeeMoney ? m : null);
  const out: AppPrompt[] = [];
  const d = facts.days;
  const missing = (a: PromptApp) => !connected.has(a);

  if (missing("PREVENTIFY") && facts.returns.orders >= MIN.returns) {
    const v = money(facts.returns.value);
    out.push({
      app: "PREVENTIFY",
      headline: v ? `${whole(v)} of orders came back in ${d} days` : `${n(facts.returns.orders)} orders came back in ${d} days`,
      body: `${n(facts.returns.orders)} orders were returned. Preventify checks COD buyers with a one-time code and blocks numbers that keep returning, before the order is booked.`,
      amount: v,
    });
  }
  if (missing("WHATKABOT") && facts.unconfirmedReturns.orders >= MIN.unconfirmedReturns) {
    const v = money(facts.unconfirmedReturns.value);
    out.push({
      app: "WHATKABOT",
      headline: v ? `${whole(v)} of returned orders were never confirmed with the buyer` : `${n(facts.unconfirmedReturns.orders)} returned orders were never confirmed`,
      body: `${n(facts.unconfirmedReturns.orders)} orders came back in ${d} days without the buyer ever confirming them. WhatKaBot asks every COD buyer to confirm on WhatsApp before you book the parcel.`,
      amount: v,
    });
  }
  if (missing("COURIERIFY") && facts.untracked.orders >= MIN.untracked) {
    const v = money(facts.untracked.value);
    out.push({
      app: "COURIERIFY",
      headline: v ? `${whole(v)} of orders shipped with no courier tracking` : `${n(facts.untracked.orders)} orders shipped with no courier tracking`,
      body: `${n(facts.untracked.orders)} orders in ${d} days went out without Courierify, so Growzar can't see their delivery, their returns or the COD the courier owes you. Courierify books and tracks every courier and checks their payouts.`,
      amount: v,
    });
  }
  if (missing("RETAINIFY") && facts.oneTimeBuyers.buyers >= MIN.oneTimeBuyers) {
    const v = money(facts.oneTimeBuyers.value);
    out.push({
      app: "RETAINIFY",
      headline: `${n(facts.oneTimeBuyers.buyers)} buyers ordered once and never came back`,
      body: `${v ? `They spent ${whole(v)} on that one order. ` : ""}Retainify sends win-back offers and abandoned-cart reminders on WhatsApp, email and push.`,
      amount: v,
    });
  }
  if (missing("FINANCIFY") && facts.delivered.orders >= MIN.delivered) {
    const v = money(facts.delivered.value);
    out.push({
      app: "FINANCIFY",
      headline: v ? `${whole(v)} delivered in ${d} days, profit unknown` : `${n(facts.delivered.orders)} orders delivered, profit unknown`,
      body: "Financify adds product costs and ad spend, so every order, product and campaign shows what it really earned.",
      amount: v,
    });
  }
  // "Your 10 best sellers" only says something for a store that sells many more than ten.
  if (missing("INVENTORIFY") && facts.topSellers.orders >= MIN.topSellerOrders && facts.topSellers.variants >= MIN.topSellerVariants && facts.topSellers.share !== null) {
    out.push({
      app: "INVENTORIFY",
      headline: `Your 10 best sellers are in ${facts.topSellers.share.toFixed(0)}% of orders, and their stock is invisible`,
      body: "Inventorify forecasts when each product runs out and drafts the purchase order before it does.",
      amount: null,
    });
  }
  const value = (p: AppPrompt) => (p.amount ? Number(p.amount.amount) : -1);
  return out.sort((a, b) => value(b) - value(a));
}
