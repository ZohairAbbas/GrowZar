/**
 * What each connected app contributes to a store's numbers, and how complete
 * it is (Phase 4b, D1). Pure.
 *
 * The screens used to hedge in place: "at most", "known for 0 of 385", "not
 * available". Each hedge was honest, but together they read as "we don't
 * know". This is the one place that says what is missing. A screen shows the
 * numbers plus one line naming the gaps that touch them, with a link here.
 *
 * Every item is a count over the same grain rows the screens add up, so the
 * coverage page cannot disagree with a figure it explains.
 */
import type { SuiteApp } from "@prisma/client";

import type { Section } from "../permissions";
import type { Payout } from "./settlements";
import type { RollupOrder } from "./rollups";

/** At or above this share an item counts as complete: one stray row is not a gap. */
export const COMPLETE_SHARE = 0.99;

const SHIPPED = ["delivered", "returned", "partially_delivered", "in_transit"];

export type CoverageStatus = "complete" | "partial" | "missing";

export type CoverageItem = {
  key: string;
  /** The app the data comes from. */
  app: SuiteApp;
  /** What the data is, e.g. "Courier fees". */
  label: string;
  /** The same, mid-sentence, for the section line: "courier fees". */
  phrase: string;
  /** `have` of `of` `unit`; null for data no connected app sends at all. */
  have: number | null;
  of: number | null;
  unit: string | null;
  status: CoverageStatus;
  /** What is missing, in plain words; null when complete. */
  gap: string | null;
  /** What the gap does to the numbers. */
  effect: string;
  /** The sections whose numbers this changes. */
  sections: Section[];
  /**
   * The line text for an item that is not a count: a stale feed says when it
   * last synced. Such items lead the section line.
   */
  lineText?: string;
};

export type AppContribution = {
  app: SuiteApp;
  state: "connected" | "connected_not_read" | "not_connected";
  gives: string;
  /** The oldest last-successful sync across the app's feeds; null when never. */
  syncedAt?: Date | null;
};

export type CoverageReport = {
  period: { from: string; to: string };
  orders: number;
  apps: AppContribution[];
  items: CoverageItem[];
};

export type CoverageInput = {
  period: { from: string; to: string };
  /** The period's grain rows, as the screens read them. */
  rows: readonly RollupOrder[];
  connected: readonly SuiteApp[];
  /** Courierify settlements, every date (a payout covers older parcels too). */
  payouts: readonly Payout[];
  /**
   * Couriers holding unpaid delivered COD, any order date: they owe the
   * store money now, so their settlements matter whatever the period.
   */
  owingCouriers?: readonly string[];
  adSpend: { daysFetched: number; daysInPeriod: number } | null;
  /** Of the period's distinct buyers, how many have a name on record. */
  buyers: { total: number; named: number };
  /** Orders in another currency with no rate for their day. */
  unconvertedOrders: number;
  /** Orders carrying Financify's other costs (G-FIN3-2), of the period's orders. */
  otherCosts?: { have: number; of: number };
  /** Orders tied to a campaign by Financify (G-FIN3-1), of orders Financify has a row for. */
  attribution?: { matched: number; of: number; organic: number };
  /** Each current feed's last successful sync and its run of failures (sync_state). */
  syncs?: SyncHealth[];
  /** When ad spend was last fetched. */
  adSpendFetchedAt?: Date | null;
  /** "Now", for judging freshness. */
  asOf?: Date;
  /** Orders whose outcome was withheld as one-sided (`outcome-sources.ts`), and the carriers. */
  withheld?: { orders: number; returned: number; inTransit: number; couriers: string[] };
};

/** What each app gives Growzar in this release (R1). */
const GIVES: Record<SuiteApp, string> = {
  COURIERIFY: "Parcels and delivery outcomes, couriers, cities, courier fees, settlements, order confirmations and courier delivery times",
  FINANCIFY: "Orders and their money, product costs, ad spend by platform, campaign and product, profit settings and exchange rates",
  RETAINIFY: "Retention campaigns and consent",
  PREVENTIFY: "Buyer risk and fraud checks",
  INVENTORIFY: "Stock on hand and reorder points",
  WHATKABOT: "Customer conversations",
};

/** Read in this release; the rest report installation only (contract §12). */
const READ_IN_R1: readonly SuiteApp[] = ["COURIERIFY", "FINANCIFY"];
const APP_ORDER: readonly SuiteApp[] = ["COURIERIFY", "FINANCIFY", "RETAINIFY", "PREVENTIFY", "INVENTORIFY", "WHATKABOT"];

function status(have: number, of: number): CoverageStatus {
  if (have === 0) return "missing";
  return have >= COMPLETE_SHARE * of ? "complete" : "partial";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-30" → "30 Sep 2026", the same under every ICU build. */
const shortDay = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

function counted(
  base: Omit<CoverageItem, "have" | "of" | "status" | "gap">,
  have: number,
  of: number,
  gap: (missing: number) => string,
): CoverageItem | null {
  // Nothing to count against (no delivered orders, say): not a gap.
  if (of === 0) return null;
  const s = status(have, of);
  return { ...base, have, of, status: s, gap: s === "complete" ? null : gap(of - have) };
}

function settlementItem(rows: readonly RollupOrder[], payouts: readonly Payout[], alsoOwing: readonly string[] = []): CoverageItem | null {
  // The couriers that owe this store cash: those that delivered a Courierify
  // parcel in the period, and any still holding unpaid COD from before.
  const owing = [
    ...new Set([...rows.filter((r) => r.outcome === "delivered" && r.parcelCount > 0 && r.courier).map((r) => r.courier!), ...alsoOwing]),
  ].sort();
  if (!owing.length) return null;
  const latest = new Map<string, Payout>();
  for (const p of payouts) {
    const seen = latest.get(p.payer);
    if (!seen || p.day > seen.day) latest.set(p.payer, p);
  }
  const settled = owing.filter((c) => latest.has(c));
  const silent = owing.filter((c) => !latest.has(c));
  const s: CoverageStatus = settled.length === owing.length ? "complete" : settled.length ? "partial" : "missing";
  const parts = [
    ...silent.map((c) => `no ${c} settlement has ever been recorded in Courierify, so its delivered COD is shown apart rather than as owed; import ${c}'s statements in Courierify (Settlements → Import) to track it`),
    ...settled.map((c) => {
      const p = latest.get(c)!;
      return `${c} last settled ${shortDay(p.day)}${p.status !== "received" ? ` (${p.status})` : ""}`;
    }),
  ];
  return {
    key: "settlements",
    app: "COURIERIFY",
    label: "Courier settlements",
    phrase: "settlements",
    have: settled.length,
    of: owing.length,
    unit: "couriers owed money",
    status: s,
    gap: s === "complete" && settled.every((c) => latest.get(c)!.status === "received") ? null : parts.join("; "),
    effect: "COD not yet paid counts only couriers whose payouts Courierify records; an untracked courier's COD is listed apart, neither owed nor paid",
    sections: ["home", "finance"],
  };
}

function timingItem(rows: readonly RollupOrder[]): CoverageItem | null {
  const delivered = rows.filter((r) => r.outcome === "delivered" && r.parcelCount > 0);
  const timed = delivered.filter((r) => r.outcomeTiming?.basis === "happened_on");
  const by3pl = delivered.filter((r) => r.outcomeTiming?.basis === "reported_by_3pl").length;
  const untimed = new Map<string, number>();
  for (const r of delivered) {
    if (r.outcomeTiming?.basis === "happened_on") continue;
    const why = r.fulfilledVia ? `${r.courier ?? "unknown"} through ${r.fulfilledVia === "orio" ? "Orio" : "another fulfilment app"}` : (r.courier ?? "unknown");
    untimed.set(why, (untimed.get(why) ?? 0) + 1);
  }
  return counted(
    {
      key: "courier_times",
      app: "COURIERIFY",
      label: "Courier delivery times",
      phrase: "courier delivery times",
      unit: "delivered Courierify orders",
      effect: "time to deliver is a median over timed deliveries only; a courier with too few has no time shown",
      sections: ["shipping"],
    },
    timed.length,
    delivered.length,
    () =>
      `no courier time on ${[...untimed.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n.toLocaleString("en-US")} (${k})`).join(", ")}` +
      (by3pl ? `; ${by3pl.toLocaleString("en-US")} of them have a time reported by the 3PL instead, shown separately` : ""),
  );
}

// ── Freshness ───────────────────────────────────────────────────────────────

export type SyncHealth = { app: SuiteApp; entity: string; lastSuccessAt: Date | null; failures: number; error: string | null };

/** A feed cycles every 5 minutes; an hour without success is 12 missed cycles. */
export const STALE_SYNC_MINUTES = 60;
/** Failures in a row that count as a feed failing, even if it synced recently. */
export const FAILING_AFTER = 3;
/** Ad spend refreshes the trailing days at least daily. */
export const STALE_AD_SPEND_HOURS = 24;

const FEED_LABEL: Record<string, { phrase: string; sections: Section[] }> = {
  "COURIERIFY:PARCEL": { phrase: "Courierify parcels", sections: ["home", "orders", "shipping", "finance", "customers"] },
  "COURIERIFY:SHIPMENT_EVENT": { phrase: "Courierify tracking events", sections: ["shipping"] },
  "COURIERIFY:SETTLEMENT": { phrase: "Courierify settlements", sections: ["home", "finance"] },
  "COURIERIFY:CONFIRMATION": { phrase: "Courierify confirmations", sections: ["home", "orders"] },
  "FINANCIFY:ORDER": { phrase: "Financify orders", sections: ["home", "orders", "shipping", "finance", "customers", "marketing"] },
  "FINANCIFY:PRODUCT": { phrase: "Financify products", sections: ["marketing"] },
  "INVENTORIFY:INVENTORY_VARIANT": { phrase: "Inventorify stock", sections: ["inventory"] },
  "INVENTORIFY:DAILY_SALES": { phrase: "Inventorify units sold", sections: ["inventory"] },
  "INVENTORIFY:STOCK_SNAPSHOT": { phrase: "Inventorify daily stock", sections: ["inventory"] },
  "INVENTORIFY:PURCHASE_ORDER": { phrase: "Inventorify purchase orders", sections: ["inventory"] },
};

const ago = (from: Date, asOf: Date) => {
  const m = Math.round((asOf.getTime() - from.getTime()) / 60_000);
  return m < 120 ? `${m} minutes ago` : m < 48 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
};

/** A stale or failing feed, as a coverage item; null when it is fresh. */
export function freshnessItem(sync: SyncHealth, asOf: Date): CoverageItem | null {
  const label = FEED_LABEL[`${sync.app}:${sync.entity}`];
  if (!label) return null;
  const old = !sync.lastSuccessAt || asOf.getTime() - sync.lastSuccessAt.getTime() > STALE_SYNC_MINUTES * 60_000;
  const failing = sync.failures >= FAILING_AFTER;
  if (!old && !failing) return null;
  const when = sync.lastSuccessAt ? `last synced ${ago(sync.lastSuccessAt, asOf)}` : "never synced";
  const why = failing ? `; the last ${sync.failures} attempts failed${sync.error ? ` (${sync.error.slice(0, 80)})` : ""}` : "";
  return {
    key: `fresh:${sync.app}:${sync.entity}`,
    app: sync.app,
    label: `${label.phrase}: ${when}`,
    phrase: label.phrase.toLowerCase(),
    have: null,
    of: null,
    unit: null,
    status: old ? "missing" : "partial",
    gap: `${label.phrase} ${when}${why}`,
    effect: "every figure from it stops at that time, so recent orders and outcomes are missing",
    sections: label.sections,
    lineText: `${label.phrase} ${when}`,
  };
}

export function coverageReport(input: CoverageInput): CoverageReport {
  const { rows } = input;
  const has = (app: SuiteApp) => input.connected.includes(app);
  const shipped = rows.filter((r) => SHIPPED.includes(r.outcome));
  const delivered = rows.filter((r) => r.outcome === "delivered");
  const items: Array<CoverageItem | null> = [];

  // Stale feeds first: they decide whether anything below is current.
  const asOf = input.asOf ?? new Date();
  for (const sync of input.syncs ?? []) if (has(sync.app)) items.push(freshnessItem(sync, asOf));
  if (has("FINANCIFY") && input.adSpendFetchedAt !== undefined) {
    const at = input.adSpendFetchedAt;
    if (!at || asOf.getTime() - at.getTime() > STALE_AD_SPEND_HOURS * 3_600_000) {
      items.push({
        key: "fresh:FINANCIFY:AD_SPEND",
        app: "FINANCIFY",
        label: `Ad spend: ${at ? `last fetched ${ago(at, asOf)}` : "never fetched"}`,
        phrase: "ad spend",
        have: null,
        of: null,
        unit: null,
        status: "missing",
        gap: `Ad spend ${at ? `last fetched ${ago(at, asOf)}` : "never fetched"}`,
        effect: "profit and ROAS leave out spend since then, so they read higher than they are",
        sections: ["home", "finance", "marketing"],
        lineText: `ad spend ${at ? `last fetched ${ago(at, asOf)}` : "never fetched"}`,
      });
    }
  }

  if (has("COURIERIFY")) {
    items.push(
      counted(
        {
          key: "courierify_booking",
          app: "COURIERIFY",
          label: "Shipped through Courierify",
          phrase: "Courierify bookings",
          unit: "shipped orders",
          effect: "the rest take their outcome from Financify and have no Courierify courier, fee or delivery time",
          sections: ["home", "orders", "shipping", "finance"],
        },
        shipped.filter((r) => r.parcelCount > 0).length,
        // Withheld orders were shipped too, outside Courierify.
        shipped.length + (input.withheld?.orders ?? 0),
        (n) => `${plural(n, "shipped order")} not booked through Courierify`,
      ),
      counted(
        {
          key: "courier_fees",
          app: "COURIERIFY",
          label: "Courier fees",
          phrase: "courier fees",
          unit: "shipped orders",
          effect: "profit subtracts courier fees only where one is recorded",
          sections: ["home", "finance"],
        },
        shipped.filter((r) => r.courierFee).length,
        shipped.length,
        (n) => `no courier fee on ${plural(n, "shipped order")}`,
      ),
      settlementItem(rows, input.payouts, input.owingCouriers),
      counted(
        {
          key: "cities",
          app: "COURIERIFY",
          label: "Cities",
          phrase: "cities",
          unit: "shipped orders",
          effect: "orders with no mapped city are grouped as “unmapped” in every city breakdown",
          sections: ["shipping"],
        },
        shipped.filter((r) => r.city).length,
        shipped.length,
        (n) => `${plural(n, "shipped order")} with no city Courierify could map`,
      ),
      timingItem(rows),
      counted(
        {
          key: "confirmations",
          app: "COURIERIFY",
          label: "Order confirmations",
          phrase: "confirmations",
          unit: "orders",
          effect: "orders never sent for confirmation are left out of the confirmation funnel's confirmed and declined counts",
          sections: ["home", "orders"],
        },
        rows.filter((r) => r.confirmation).length,
        rows.length,
        (n) => `${plural(n, "order")} never sent for confirmation`,
      ),
    );
  }

  if (has("FINANCIFY")) {
    items.push(
      counted(
        {
          key: "cogs",
          app: "FINANCIFY",
          label: "Product costs",
          phrase: "product costs",
          unit: "delivered orders",
          effect: "profit and product margins subtract a cost only for lines that have one",
          sections: ["home", "finance", "marketing"],
        },
        delivered.filter((r) => r.cogsComplete === true).length,
        delivered.length,
        (n) => `${plural(n, "delivered order")} with a line that has no cost in Financify`,
      ),
    );
    if (input.otherCosts) {
      items.push(
        counted(
          {
            key: "other_costs",
            app: "FINANCIFY",
            label: "Other costs",
            phrase: "other costs",
            unit: "orders",
            effect: "profit subtracts payment fees, taxes, your Financify cost rules and its shipping estimate only on orders that carry them",
            sections: ["home", "finance"],
          },
          input.otherCosts.have,
          input.otherCosts.of,
          (n) => `${plural(n, "order")} without Financify's other costs yet`,
        ),
      );
    }
    if (input.adSpend) {
      items.push(
        counted(
          {
            key: "ad_spend",
            app: "FINANCIFY",
            label: "Ad spend",
            phrase: "ad spend",
            unit: "days",
            effect: "profit and ROAS leave ad spend out unless every day of the period is fetched",
            sections: ["home", "finance", "marketing"],
          },
          input.adSpend.daysFetched,
          input.adSpend.daysInPeriod,
          (n) => `${plural(n, "day")} of ad spend not fetched yet`,
        ),
      );
    }
    if (input.unconvertedOrders) {
      items.push({
        key: "fx",
        app: "FINANCIFY",
        label: "Exchange rates",
        phrase: "exchange rates",
        have: null,
        of: null,
        unit: null,
        status: "partial",
        gap: `${plural(input.unconvertedOrders, "order")} in another currency on a day with no rate`,
        effect: "those orders are shown separately, never added into the store's currency",
        sections: ["home", "finance"],
      });
    }
    if (input.withheld?.orders) {
      const w = input.withheld;
      const named = w.couriers.filter((c) => c !== "unknown").map((c) => c.replace(/^financify:/, ""));
      const parts = [
        ...(w.couriers.includes("unknown")
          ? ["orders shipped with a courier booked outside Shopify and Courierify carry no tracking, so no app ever learns whether they arrived; book them through Courierify, or add the tracking number to the Shopify fulfilment"]
          : []),
        ...(named.length ? [`Financify has not reported a single delivery for ${named.join(", ")} in 90 days`] : []),
      ];
      items.push({
        key: "one_sided_outcomes",
        app: "FINANCIFY",
        label: "Outcomes outside Courierify",
        phrase: "outcomes outside Courierify",
        have: null,
        of: null,
        unit: null,
        status: "missing",
        gap: `${parts.join("; ")}. ${plural(w.orders, "order")} this period (${w.inTransit} dispatched, ${w.returned} reported returned) have no outcome counted`,
        effect: "those orders count in orders placed but in no delivery rate, return rate or delivered count, which would otherwise read lower than it is",
        sections: ["home", "orders", "shipping", "finance", "customers", "marketing"],
      });
    }
    // Order-level attribution is what per-campaign orders and returns need.
    if (input.attribution && input.attribution.of > 0) {
      const at = input.attribution;
      const item = counted(
        {
          key: "campaign_attribution",
          app: "FINANCIFY",
          label: "Orders tied to a campaign",
          phrase: "orders tied to a campaign",
          unit: "orders",
          effect: "campaign orders, ROAS on delivered revenue and return rates count only orders Financify tied to a campaign",
          sections: ["marketing"],
        },
        at.matched,
        at.of,
        (n) => `${plural(n, "order")} not tied to a campaign${at.organic ? `, ${at.organic.toLocaleString("en-US")} of them carrying no paid campaign (organic or direct traffic)` : ""}`,
      );
      if (item) items.push(item);
    } else {
      items.push({
        key: "campaign_attribution",
        app: "FINANCIFY",
        label: "Orders per campaign",
        phrase: "orders per campaign",
        have: null,
        of: null,
        unit: null,
        status: "missing",
        gap: "Financify has not sent which campaign each order came from yet",
        effect: "campaigns show spend and fees only",
        sections: ["marketing"],
      });
    }
    items.push({
      key: "bank_receipts",
      app: "FINANCIFY",
      label: "Money received in bank",
      phrase: "money received in bank",
      have: null,
      of: null,
      unit: null,
      status: "missing",
      gap: "Financify's cash ledger has not recorded a settlement for this store",
      effect: "Finance shows what couriers paid out, not what reached the bank account",
      sections: ["finance"],
    });
  }

  if (has("COURIERIFY") || has("FINANCIFY")) {
    const linked = rows.filter((r) => r.customerId).length;
    items.push(
      counted(
        {
          key: "buyers",
          app: has("COURIERIFY") ? "COURIERIFY" : "FINANCIFY",
          label: "Buyer phone numbers",
          phrase: "buyer phone numbers",
          unit: "orders",
          effect: "an order with no phone cannot be tied to a buyer, so it is left out of buyer counts, repeat rates and cohorts",
          sections: ["customers"],
        },
        linked,
        rows.length,
        (n) => `${plural(n, "order")} with no usable phone number`,
      ),
      counted(
        {
          key: "buyer_names",
          app: has("COURIERIFY") ? "COURIERIFY" : "FINANCIFY",
          label: "Buyer names",
          phrase: "buyer names",
          unit: "buyers",
          effect: "a buyer with no name is shown by the last digits of their phone",
          sections: ["customers"],
        },
        input.buyers.named,
        input.buyers.total,
        (n) => `${plural(n, "buyer")} with no name on any order`,
      ),
    );
    items.push({
      key: "buyer_risk",
      app: "PREVENTIFY",
      label: "Buyer risk",
      phrase: "buyer risk",
      have: null,
      of: null,
      unit: null,
      status: "missing",
      gap: has("PREVENTIFY") ? "Preventify is connected; Growzar reads it from the next release" : "Preventify is not installed on this store",
      effect: "orders carry no risk band",
      sections: ["orders"],
    });
    items.push({
      key: "consent",
      app: "RETAINIFY",
      label: "Consent and opt-outs",
      phrase: "consent",
      have: null,
      of: null,
      unit: null,
      status: "missing",
      gap: "Consent lives in Retainify and WhatKaBot, which Growzar reads from the next release",
      effect: "buyers carry no consent state",
      sections: ["customers"],
    });
  }

  return {
    period: input.period,
    orders: rows.length,
    apps: APP_ORDER.map((app) => ({
      app,
      state: !has(app) ? "not_connected" : READ_IN_R1.includes(app) ? "connected" : "connected_not_read",
      gives: GIVES[app],
      syncedAt: (() => {
        const mine = (input.syncs ?? []).filter((x) => x.app === app);
        if (!mine.length) return undefined;
        return mine.some((x) => !x.lastSuccessAt) ? null : new Date(Math.min(...mine.map((x) => x.lastSuccessAt!.getTime())));
      })(),
    })),
    items: items.filter((i): i is CoverageItem => i !== null),
  };
}

export type CoverageLine = {
  /** Gaps that touch this section, most consequential first. */
  gaps: Array<{ key: string; text: string }>;
};

/**
 * The one line at the top of a section: only the gaps that change its
 * numbers. Counted gaps lead (they move a figure), whole missing sources
 * follow.
 */
export function coverageLine(report: CoverageReport, section: Section): CoverageLine {
  const gaps = report.items
    .filter((i) => i.status !== "complete" && i.sections.includes(section))
    // Stale feeds lead, then counted gaps, then whole missing sources.
    .sort((a, b) => Number(!a.lineText) - Number(!b.lineText) || Number(a.have === null) - Number(b.have === null))
    .map((i) => ({
      key: i.key,
      text: i.lineText
        ? i.lineText
        : i.have !== null && i.of !== null
          ? `${i.phrase} for ${i.have.toLocaleString("en-US")} of ${i.of.toLocaleString("en-US")} ${i.unit}`
          : `${i.phrase} not available`,
    }));
  return { gaps };
}
