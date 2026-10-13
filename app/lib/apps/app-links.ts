/**
 * Where a card sends the merchant to act (G-GZR6-2, cross-sell kind 2): the
 * screen in the app that fixes what the card found when the app is
 * connected, else the app's App Store page so it can be installed.
 *
 * A fixed list, so a link is built on the server from a key and never from a
 * URL the client sends (the act route redirects off-site). Every handle and
 * path here was read from the app's own code or its live App Store page on
 * 2026-10-13; an app whose admin handle is not confirmed gets no "open"
 * link rather than a guessed one.
 *
 * Admin handle ≠ App Store slug: Retainify is listed as `retainify` but its
 * admin pages live under `retainify-1` (Retainify's plan-url.server.js).
 */

export type LinkedApp = "COURIERIFY" | "FINANCIFY" | "INVENTORIFY" | "RETAINIFY" | "PREVENTIFY" | "WHATKABOT";

type AppEntry = {
  name: string;
  /** Public App Store listing; null when the app is not listed. */
  listing: string | null;
  /** The admin.shopify.com/store/<shop>/apps/<handle> handle; null until confirmed. */
  adminHandle: string | null;
};

export const SUITE_APPS: Record<LinkedApp, AppEntry> = {
  COURIERIFY: { name: "Courierify", listing: "https://apps.shopify.com/courierify", adminHandle: "courierify" },
  RETAINIFY: { name: "Retainify", listing: "https://apps.shopify.com/retainify", adminHandle: "retainify-1" },
  PREVENTIFY: { name: "Preventify", listing: "https://apps.shopify.com/preventify", adminHandle: "jaldi-cod-form" },
  // Admin handles confirmed from the merchant's own admin URL (2026-10-13).
  WHATKABOT: { name: "WhatKaBot", listing: "https://apps.shopify.com/whatkabot", adminHandle: "whatkabot" },
  FINANCIFY: { name: "Financify", listing: "https://apps.shopify.com/financify", adminHandle: "financify" },
  // Listed as `inventorify-8`; its admin handle is not confirmed yet.
  INVENTORIFY: { name: "Inventorify", listing: "https://apps.shopify.com/inventorify-8", adminHandle: null },
};

/** A screen in one app that fixes a finding. `does` finishes "Set up …"/"Open …" labels. */
export const SCREENS = {
  retainify_flows: { app: "RETAINIFY", path: "/app/flows", open: "Set up a cart reminder in Retainify" },
  preventify_verification: { app: "PREVENTIFY", path: "/app/settings", open: "Turn on verification in Preventify" },
  preventify_offers: { app: "PREVENTIFY", path: "/app/sales-booster", open: "Review offers in Preventify" },
  courierify_confirmations: { app: "COURIERIFY", path: "/app/confirmations", open: "Open confirmations in Courierify" },
  courierify_ndr: { app: "COURIERIFY", path: "/app/ndr", open: "Open delivery problems in Courierify" },
} as const satisfies Record<string, { app: LinkedApp; path: string; open: string }>;

export type ScreenKey = keyof typeof SCREENS;
export const isScreenKey = (v: unknown): v is ScreenKey => typeof v === "string" && Object.hasOwn(SCREENS, v);

export type AppAction = { screen: ScreenKey; label: string; install: boolean };

/** The button for a screen, given what the store has connected; null when there is nowhere confirmed to go. */
export function actionFor(screen: ScreenKey, connected: ReadonlySet<string>): AppAction | null {
  const s = SCREENS[screen];
  const app = SUITE_APPS[s.app];
  if (connected.has(s.app)) return app.adminHandle ? { screen, label: s.open, install: false } : null;
  return app.listing ? { screen, label: `Install ${app.name}`, install: true } : null;
}

/** Where the act route redirects: the app's admin screen for this shop, or its listing. */
export function actionHref(screen: ScreenKey, connected: ReadonlySet<string>, shopDomain: string): string | null {
  const s = SCREENS[screen];
  const app = SUITE_APPS[s.app];
  if (connected.has(s.app)) {
    if (!app.adminHandle) return null;
    const store = shopDomain.replace(/\.myshopify\.com$/, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(store)) return null;
    return `https://admin.shopify.com/store/${store}/apps/${app.adminHandle}${s.path}`;
  }
  return app.listing;
}
