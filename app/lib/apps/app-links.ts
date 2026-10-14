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
  // Listed as `inventorify-8`, but its admin pages live under `inventorify-5`.
  INVENTORIFY: { name: "Inventorify", listing: "https://apps.shopify.com/inventorify-8", adminHandle: "inventorify-5" },
};

/** A screen in one app that fixes a finding. `does` finishes "Set up …"/"Open …" labels. */
export const SCREENS = {
  retainify_flows: { app: "RETAINIFY", path: "/app/flows", open: "Set up a cart reminder in Retainify" },
  preventify_verification: { app: "PREVENTIFY", path: "/app/settings", open: "Turn on verification in Preventify" },
  preventify_offers: { app: "PREVENTIFY", path: "/app/sales-booster", open: "Review offers in Preventify" },
  courierify_confirmations: { app: "COURIERIFY", path: "/app/confirmations", open: "Open confirmations in Courierify" },
  courierify_ndr: { app: "COURIERIFY", path: "/app/ndr", open: "Open delivery problems in Courierify" },
  inventorify_reorder: { app: "INVENTORIFY", path: "/app/purchase-orders/new", open: "Create a purchase order in Inventorify" },
  // WhatKaBot and Financify paths as each app's team gave them (2026-10-14). No
  // screen opens a specific row or template from the URL.
  whatkabot_cod_confirmation: { app: "WHATKABOT", path: "/app/settings-v3/customer-notifications", open: "Turn on COD confirmation in WhatKaBot" },
  whatkabot_inbox: { app: "WHATKABOT", path: "/app/inbox-v3", open: "Reply in WhatKaBot's inbox" },
  financify_costs: { app: "FINANCIFY", path: "/app/cost-history?tab=missing", open: "Add missing product costs in Financify" },
  financify_profitability: { app: "FINANCIFY", path: "/app/product-profitability", open: "See product profit in Financify" },
  financify_integrations: { app: "FINANCIFY", path: "/app/integrations", open: "Connect your ad accounts in Financify" },
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

/**
 * The first screen whose app is connected, opened; else an install of the
 * first one listed. Screens are in order of preference.
 */
export function firstAction(screens: readonly ScreenKey[], connected: ReadonlySet<string>): AppAction | null {
  for (const s of screens) {
    if (!connected.has(SCREENS[s].app)) continue;
    const a = actionFor(s, connected);
    if (a) return a;
  }
  return screens[0] ? actionFor(screens[0], connected) : null;
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
