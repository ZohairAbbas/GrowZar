import type { SuiteApp } from "@prisma/client";

import { SECTIONS, SECTION_LABELS, type Section } from "./permissions";

/**
 * What each section needs to be worth opening (D-04, D-16, D-43).
 *
 * A single-app merchant sees a **locked preview** of everything the other apps
 * would give them, never a half-built screen. That is the whole point: the
 * value of the suite is visible before it is bought, and a section that cannot
 * yet say anything true says nothing rather than something empty.
 *
 * `requires` is any-of: Orders is worth opening with either Courierify or
 * Financify connected, because either one carries orders. Finance needs
 * Financify specifically — Courierify's settlements alone do not make a
 * finance section.
 */
export type SectionDefinition = {
  section: Section;
  label: string;
  /** Any one of these connected opens the section. Empty means always open. */
  requires: SuiteApp[];
  /** One line, shown open or locked. */
  blurb: string;
  /** What the merchant gets by connecting — the locked state's preview. */
  preview: string[];
};

export const SECTION_DEFINITIONS: Record<Section, SectionDefinition> = {
  home: {
    section: "home",
    label: SECTION_LABELS.home,
    requires: [],
    blurb: "Your stores, and what changed since you last looked.",
    preview: [],
  },
  orders: {
    section: "orders",
    label: SECTION_LABELS.orders,
    requires: ["COURIERIFY", "FINANCIFY"],
    blurb: "Every order across your stores, with what happened to it.",
    preview: [
      "Orders from every store in one list",
      "Confirmation status beside delivery outcome",
      "Which orders are still waiting on a courier",
    ],
  },
  shipping: {
    section: "shipping",
    label: SECTION_LABELS.shipping,
    requires: ["COURIERIFY"],
    blurb: "Parcels, couriers and what each delivery actually cost.",
    preview: [
      "Delivery outcome and fee for every parcel",
      "Which courier does better in which city",
      "Returns, and what they cost you",
    ],
  },
  finance: {
    section: "finance",
    label: SECTION_LABELS.finance,
    requires: ["FINANCIFY"],
    blurb: "Money in, money out, and what is still with a courier.",
    preview: [
      "Cash still sitting with your couriers",
      "Cost and margin per order",
      "Settlements against what was booked",
    ],
  },
  customers: {
    section: "customers",
    label: SECTION_LABELS.customers,
    requires: ["COURIERIFY", "FINANCIFY"],
    blurb: "Who buys from you — counted once, however they spell their number.",
    preview: [
      "One record per buyer across your stores",
      "Repeat buyers, and who stopped",
      "Return rate per customer",
    ],
  },
  inventory: {
    section: "inventory",
    label: SECTION_LABELS.inventory,
    requires: ["INVENTORIFY"],
    blurb: "What you hold, what is moving, what is about to run out.",
    preview: [
      "Stock on hand per variant",
      "What to reorder, and when",
      "Stock tied up in parcels in transit",
    ],
  },
  marketing: {
    section: "marketing",
    label: SECTION_LABELS.marketing,
    requires: ["FINANCIFY"],
    blurb: "What you spend to get an order, and whether it is worth it.",
    preview: [
      "Ad spend per product",
      "Products that look profitable but are not",
      "Regions that cost more than they return",
    ],
  },
  inbox: {
    section: "inbox",
    label: SECTION_LABELS.inbox,
    requires: ["WHATKABOT"],
    blurb: "Customer conversations, beside the order they are about.",
    preview: [
      "WhatsApp conversations in one place",
      "The order a buyer is asking about, beside their message",
      "Who on your team replied, and when",
    ],
  },
  settings: {
    section: "settings",
    label: SECTION_LABELS.settings,
    requires: [],
    blurb: "Your organization, your team and their permissions.",
    preview: [],
  },
};

export type SectionState =
  | { kind: "open" }
  | { kind: "locked"; missing: SuiteApp[] }
  /**
   * The app was uninstalled (D-17). Distinct from locked: there IS data, it is
   * just not being refreshed. Showing "connect this app" here would be a lie
   * to someone who already had it.
   */
  | { kind: "reconnect"; apps: SuiteApp[]; asOf: Date | null };

export type StoreConnection = {
  app: SuiteApp;
  status: "CONNECTED" | "DISCONNECTED" | "REINSTALL_NEEDED" | "ERROR";
  lastSyncedAt: Date | null;
};

export function sectionState(
  definition: SectionDefinition,
  connections: StoreConnection[],
): SectionState {
  if (definition.requires.length === 0) return { kind: "open" };

  const relevant = connections.filter((c) => definition.requires.includes(c.app));
  const connected = relevant.filter((c) => c.status === "CONNECTED");

  if (connected.length > 0) return { kind: "open" };

  const disconnected = relevant.filter((c) => c.status === "DISCONNECTED");
  if (disconnected.length > 0) {
    // Last-known data stays visible, stamped with when it was last true.
    const asOf = disconnected
      .map((c) => c.lastSyncedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    return { kind: "reconnect", apps: disconnected.map((c) => c.app), asOf };
  }

  return { kind: "locked", missing: definition.requires };
}

export const APP_LABELS: Record<SuiteApp, string> = {
  COURIERIFY: "Courierify",
  FINANCIFY: "Financify",
  WHATKABOT: "WhatKaBot",
  PREVENTIFY: "Preventify",
  RETAINIFY: "Retainify",
  INVENTORIFY: "Inventorify",
};

export const ORDERED_SECTIONS = SECTIONS.map(
  (section) => SECTION_DEFINITIONS[section],
);
