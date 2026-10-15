import type {
  Finding,
} from "~/lib/metrics/findings";
import type { StockoutFinding } from "~/lib/metrics/stockout";
import type { UnfollowedCheckoutsFinding } from "~/lib/metrics/checkouts";
import type { OfferReturnsFinding } from "~/lib/metrics/offers";
import type { NetworkRiskFinding, ReturnersFinding } from "~/lib/metrics/buyer-history";
import type { CampaignReturnsFinding } from "~/lib/metrics/campaign-acquisition";
import type { ScreenKey } from "~/lib/apps/app-links";
import { formatAmount } from "~/lib/metrics/format";

/**
 * A finding in words: the headline, figure and next step Home's attention
 * rows and compact cards show, and the app screens that act on it. Moved
 * out of FindingCards.tsx unchanged (G-GZR6-5) so the weekly digest says
 * exactly what Home says; nothing here may touch React or the server.
 */

/**
 * The app screens that act on a finding, in order of preference: the first
 * whose app is connected is opened, else the first is offered to install.
 * Not here: COD-form abandonments (no suite app can remind on them) and
 * WhatKaBot for abandoned checkouts (its access to them is unconfirmed).
 */
export function screensFor(f: Finding): ScreenKey[] {
  switch (f.kind) {
    case "unfollowed_checkouts":
      // Retainify reminds on Shopify checkouts only; nothing reminds on COD forms.
      return f.source === "shopify_checkout" ? ["retainify_flows"] : [];
    case "unconfirmed_returns":
      return ["whatkabot_cod_confirmation", "courierify_confirmations"];
    case "stuck_parcels":
      // Buyers already asking: answer them first.
      return f.wroteIn?.orders ? ["whatkabot_inbox", "courierify_ndr"] : ["courierify_ndr"];
    case "returners":
    case "network_risk":
      return ["preventify_verification"];
    case "offer_returns":
      return ["preventify_offers"];
    case "stockout":
      return ["inventorify_reorder"];
    case "margin":
      return f.cogsIncompleteOrders ? ["financify_costs"] : [];
    case "product_loss":
      return ["financify_profitability"];
    case "campaign_returns":
      // A flagged campaign with no spend recorded: its ad account isn't connected.
      return f.flagged.some((c) => !c.spend) ? ["financify_integrations"] : [];
    default:
      return [];
  }
}

export type Money = { amount: string; currency: string };
export const money = (m: Money) => `${formatAmount(m.amount)} ${m.currency}`;
export const n = (x: number) => x.toLocaleString("en-GB");

export const variantName = (f: StockoutFinding) => (f.variantTitle ? `${f.title} (${f.variantTitle})` : f.title);
export const stockoutHeadline = (f: StockoutFinding) =>
  f.situation === "out"
    ? `${variantName(f)} is out of stock while selling ${f.perDay.toFixed(1)} a day`
    : `${variantName(f)} runs out in about ${n(f.daysOfCover)} day${f.daysOfCover === 1 ? "" : "s"}, before a reorder could arrive`;

export const abandonedNoun = (f: UnfollowedCheckoutsFinding) => (f.source === "cod_form" ? "COD-form abandonments" : "abandoned checkouts");
export const checkoutsHeadline = (f: UnfollowedCheckoutsFinding) => `${n(f.notFollowedUp)} of ${n(f.settled)} ${abandonedNoun(f)} got no reminder`;

export const offerHeadline = (f: OfferReturnsFinding) =>
  `${f.label}${f.valueLiftPct !== null ? ` raise order value ${f.valueLiftPct.toFixed(0)}%, but` : ""} come back ${f.gapPoints.toFixed(1)} points more`;

export const returnersHeadline = (f: ReturnersFinding) => `Buyers who returned a parcel before come back ${pct(f.rate)} of the time`;
export const returnersNext = (f: ReturnersFinding) =>
  f.otpEnabled === null || (f.formShare ?? 0) < 50
    ? "Confirm orders from these buyers before booking, or ask them to pay ahead."
    : "Turn on OTP verification in Preventify, or block repeat returners' numbers there.";

export const networkHeadline = (f: NetworkRiskFinding) => `Buyers Courierify rated high risk when they ordered came back ${pct(f.rate)} of the time`;
export const networkNext = (f: NetworkRiskFinding) =>
  f.openHigh
    ? `Confirm the ${n(f.openHigh)} open order${f.openHigh === 1 ? "" : "s"} from such buyers by phone before booking, or ask for payment ahead.`
    : "Confirm orders from buyers Courierify rates high by phone before booking, or ask for payment ahead.";
export const networkLink = (f: NetworkRiskFinding, period: string) =>
  f.openHigh ? { to: `/orders?${period}&network=high`, label: `See the ${n(f.openHigh)} open orders` } : { to: `/customers?${period}`, label: "See buyers" };

export const campaignName = (c: CampaignReturnsFinding["flagged"][number]) => `${c.name ?? c.key}${c.platform ? ` (${c.platform})` : ""}`;
export const campaignHeadline = (f: CampaignReturnsFinding) =>
  f.flagged.length === 1
    ? `${campaignName(f.flagged[0]!)} brings buyers who send their first parcel back`
    : `${n(f.flagged.length)} campaigns bring buyers who send their first parcel back`;

/** Display names for the identifiers Courierify uses; anything else is capitalised. */
export const COURIER_NAMES: Record<string, string> = {
  orio: "Orio",
  tcs: "TCS",
  nkfulfillment: "NK Fulfilment",
  blueex: "BlueEx",
  postex: "PostEx",
  smartlane: "SmartLane",
  trax: "Trax",
  leopards: "Leopards",
  bouraq: "Bouraq",
};
export const payerName = (p: string) => COURIER_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

export const routeName = (r: { courier: string; via: string }) =>
  `${payerName(r.courier)}${r.via === "direct" ? ", booked directly" : ` through ${payerName(r.via)}`}`;

export const unsigned = (m: Money) => ({ ...m, amount: m.amount.replace(/^-/, "") });

/**
 * The face of a compact card. Every figure and sentence comes from the
 * finding or from its full card's own text: "next" only where that text
 * already says what to do, otherwise "why" quotes what the figure means. No
 * recommendation or money is made up here: an estimate appears only when the
 * finding carries one (approved per detector, 2026-10-06).
 */
export type Summary = {
  headline: string;
  figure: string;
  note: string;
  next?: string;
  why?: string;
  affects: string;
  link?: { to: string; label: string };
};

export const pct = (x: number) => `${x.toFixed(1)}%`;
/** A headline amount: currency first, whole units, as in the metric row. */
export const figure = (m: Money) => `${m.currency} ${formatAmount(m.amount).replace(/\.\d+$/, "")}`;
export const first = (m: Money[]) => (m[0] ? figure(m[0]) : "—");

export function summaryOf(f: Finding, period: string): Summary {
  switch (f.kind) {
    case "cash_held": {
      const who = payerName(f.payer);
      // Orio's statements are uploaded by hand: no statement is not the same as no payment.
      if (f.byUpload) {
        return {
          headline: `No ${who} statement in Courierify for ${n(f.orders)} delivered order${f.orders === 1 ? "" : "s"}`,
          figure: first(f.cod),
          note: `Last ${who} statement uploaded ${f.lastPaidDay}`,
          next: `Upload ${who}'s latest statements in Courierify, then chase what is still unpaid.`,
          affects: `${n(f.orders)} delivered orders`,
          link: { to: `/orders?${period}&awaitingPayout=${f.payer}`, label: "See orders" },
        };
      }
      return {
        headline: `${who} hasn't paid for ${n(f.orders)} delivered order${f.orders === 1 ? "" : "s"}`,
        figure: first(f.cod),
        note: f.daysLate > 0 ? `${n(f.daysLate)} days past its usual ${f.medianGapDays}-day payout` : `Last payout ${f.lastPaidDay}`,
        next: `Check ${who}'s own statement, then chase the payout.`,
        affects: `${n(f.orders)} delivered orders`,
        link: { to: `/orders?${period}&awaitingPayout=${f.payer}`, label: "See orders" },
      };
    }
    case "unconfirmed_returns":
      return {
        headline: "Orders nobody confirmed come back more often",
        figure: f.cost ? figure(f.cost.total) : pct(f.unanswered.returnRate),
        note: f.cost
          ? `in courier charges on ${n(f.excessReturns)} extra returns: ${pct(f.unanswered.returnRate)} returned unanswered, ${pct(f.confirmed.returnRate)} confirmed`
          : `returned when unanswered, against ${pct(f.confirmed.returnRate)} when confirmed`,
        ...(f.waiting
          ? { next: `Call the ${n(f.waiting)} unanswered order${f.waiting === 1 ? "" : "s"} before booking: they can still be confirmed or cancelled.` }
          : { why: `${n(f.excessReturns)} more returns than the confirmed rate would give.` }),
        affects: `${n(f.unanswered.decided)} unanswered orders`,
        link: f.waiting ? { to: `/orders?${period}&unanswered=waiting`, label: "See orders" } : undefined,
      };
    case "variant_returns": {
      const v = f.flagged[0]!;
      const name = v.title ?? `Variant ${v.variantId}`;
      return {
        headline: f.flagged.length === 1 ? `${name} comes back far more often` : `${n(f.flagged.length)} products come back far more often`,
        figure: v.cost ? figure(v.cost.total) : pct(v.returnRate),
        note: v.cost
          ? `in courier charges on ${n(v.excessReturns ?? 0)} extra returns: ${pct(v.returnRate)} returned, ${pct(f.store.returnRate)} for the store`
          : `${f.flagged.length === 1 ? "" : `${name}: `}returned, against ${pct(f.store.returnRate)} for the whole store`,
        why: "Counted by order: a returned order counts against every product in it.",
        affects: `${n(v.decided)} decided orders`,
        link: { to: `/orders?${period}&variant=${v.variantId}`, label: "See orders" },
      };
    }
    case "margin": {
      const loss = f.ceiling.amount.startsWith("-");
      return {
        headline: `Ads took ${pct(f.adsShareOfDelivered)} of delivered revenue`,
        figure: loss ? `−${figure(unsigned(f.ceiling))}` : figure(f.ceiling),
        note: loss ? "lost after cost and ads, at least" : "left after cost and ads, at most",
        why: "Before the rest of the courier fees and the cost of returns.",
        affects: `${n(f.delivered)} delivered orders`,
        link: { to: `/finance?${period}`, label: "See the arithmetic" },
      };
    }
    case "product_loss":
      return {
        headline: `${f.title ?? `Variant ${f.variantId}`} loses money once returns are counted`,
        figure: `−${figure(unsigned(f.ceiling))}`,
        note: `lost at least, with ${pct(f.returnRate)} of its orders returned`,
        why: `Had every order been delivered it would have made ${money(f.ifAllDelivered)}.`,
        affects: `${n(f.orders)} orders`,
        link: { to: `/orders?${period}&variant=${f.variantId}`, label: "See orders" },
      };
    case "city_returns":
      return {
        headline: `Orders to ${f.city} come back far more often`,
        figure: pct(f.returnRate),
        note: `returned, against ${pct(f.rest.returnRate)} for the rest of the store`,
        why: "Unlikely to be chance alone (95%).",
        affects: `${n(f.orders)} orders`,
        link: { to: `/orders?${period}&city=${encodeURIComponent(f.city)}`, label: "See orders" },
      };
    case "courier_for_city": {
      const w = f.worse[0]!;
      return {
        headline: `In ${f.city}, ${routeName(f.best)} delivers more`,
        figure: `+${w.gapPoints.toFixed(1)} pts`,
        note: `${pct(f.best.rate)} delivered, against ${pct(w.rate)} for ${routeName(w)}`,
        why: "Unlikely to be chance alone (95%), though what went each way can differ.",
        affects: `${n(f.best.decided + w.decided)} decided orders`,
        link: {
          to: `/orders?${period}&city=${encodeURIComponent(f.city)}&courier=${f.best.courier}&via=${f.best.via}`,
          label: "See orders",
        },
      };
    }
    case "missing_fees":
      return {
        headline: "Courier fees missing on Courierify orders",
        figure: n(f.missing),
        note: `of ${n(f.viaCourierify)} orders shipped through Courierify have no fee`,
        why: f.estimate
          ? `Profit reads about ${figure(f.estimate.total)} too high (at the median fee of ${figure(f.estimate.medianFee)}).`
          : "Every profit figure that includes them reads higher than it is.",
        affects: `${n(f.missing)} shipped orders`,
        link: { to: `/orders?${period}&feeMissing=1`, label: "See orders" },
      };
    case "disagreements":
      return {
        headline: "Courierify and Financify disagree on outcomes",
        figure: n(f.total),
        note: `orders, out of ${n(f.bothApps)} both apps know about`,
        why: "Growzar takes the courier's answer, through Courierify.",
        affects: `${n(f.total)} orders`,
        link: { to: `/orders?${period}&disagree=1`, label: "See orders" },
      };
    case "campaign_returns":
      return {
        headline: campaignHeadline(f),
        figure: f.spendOnReturned ? figure(f.spendOnReturned) : pct(f.flagged[0]!.rate ?? 0),
        note: f.spendOnReturned
          ? `of ad spend went on first orders that came back${f.spendKnownFor < f.flagged.length ? ` (${n(f.spendKnownFor)} of ${n(f.flagged.length)} campaigns; the rest have no spend recorded)` : ""}`
          : `of its new buyers' first parcels came back, against ${pct(f.flagged[0]!.restRate)}`,
        next: "Narrow these campaigns' audience or pause them, and check which products and cities their returned orders were for.",
        affects: `${n(f.flagged.reduce((t, c) => t + c.returned, 0))} returned first orders`,
        link: { to: `/marketing?${period}`, label: "See campaigns" },
      };
    case "network_risk":
      return {
        headline: networkHeadline(f),
        figure: f.cost ? figure(f.cost.total) : pct(f.rate),
        note: f.cost
          ? `in courier charges on ${n(f.excessReturns)} extra returns: ${pct(f.rate)} came back, against ${pct(f.restRate)}`
          : `came back, against ${pct(f.restRate)} for everyone else`,
        next: networkNext(f),
        affects: `${n(f.openHigh)} open orders`,
        link: networkLink(f, period),
      };
    case "returners":
      return {
        headline: returnersHeadline(f),
        figure: f.cost ? figure(f.cost.total) : pct(f.rate),
        note: f.cost
          ? `in courier charges on ${n(f.excessReturns)} extra returns: ${pct(f.rate)} came back, against ${pct(f.restRate)}`
          : `came back, against ${pct(f.restRate)} for everyone else`,
        next: returnersNext(f),
        affects: `${n(f.orders)} orders from buyers who returned before`,
        link: { to: `/customers?${period}`, label: "See buyers" },
      };
    case "offer_returns":
      return {
        headline: offerHeadline(f),
        figure: pct(f.returnRate),
        note: `returned, against ${pct(f.baselineRate)} with no offer`,
        next: `Check which ${f.label.toLowerCase()} come back most in Marketing, and restrict or turn them off in Preventify.`,
        affects: `${n(f.orders)} orders with ${f.label.toLowerCase()}`,
        link: { to: `/marketing?${period}`, label: "See offers" },
      };
    case "unfollowed_checkouts":
      return {
        headline: checkoutsHeadline(f),
        figure: f.notFollowedUpValue[0] ? figure(f.notFollowedUpValue[0]) : n(f.notFollowedUp),
        note: f.notFollowedUpValue[0] ? `in ${n(f.notFollowedUp)} carts nobody reminded` : `of ${n(f.settled)} abandoned checkouts`,
        next: f.pausedJourney
          ? `Turn Retainify's “${f.pausedJourney.name}” journey back on.`
          : f.source === "cod_form"
            ? f.reminderAppConnected
              ? "Remind COD-form leavers from Retainify or WhatKaBot."
              : "Connect Retainify or WhatKaBot to remind COD-form leavers."
            : "Turn on a cart reminder in Retainify.",
        affects: `${n(f.notFollowedUp)} ${abandonedNoun(f)}`,
        link: { to: `/marketing?${period}`, label: "See checkouts" },
      };
    case "stockout":
      return {
        headline: stockoutHeadline(f),
        figure: f.situation === "out" ? "Out" : `${n(f.daysOfCover)} days`,
        note: `left, with a ${n(f.leadTimeDays)}-day lead time and nothing on order`,
        next: "Reorder it in Inventorify now, or set its real lead time there.",
        affects: `about ${n(f.unitsShort)} units of demand`,
        link: { to: "/inventory?days=30", label: "See stock" },
      };
    case "stuck_parcels":
      return {
        headline: f.wroteIn?.orders
          ? `${n(f.booked + f.inTransit)} parcels have not moved for days; buyers asked about ${n(f.wroteIn.orders)}`
          : `${n(f.booked + f.inTransit)} parcels have not moved for days`,
        figure: f.placed ? figure(f.placed) : n(f.booked + f.inTransit),
        note:
          f.wroteIn?.orders && f.wroteIn.test.significant
            ? `here, orders whose buyer wrote in came back ${f.wroteIn.test.wrote.rate}% of the time, against ${f.wroteIn.test.silent.rate}%`
            : f.placed
              ? `in ${n(f.booked + f.inTransit)} orders: ${n(f.booked)} booked and never picked up, ${n(f.inTransit)} in transit with no update`
              : `${n(f.booked)} booked and never picked up, ${n(f.inTransit)} in transit with no update`,
        next: f.wroteIn?.orders
          ? `Reply to the ${n(f.wroteIn.orders)} buyer${f.wroteIn.orders === 1 ? "" : "s"} who wrote in, and raise a delivery case with the courier for their parcels first.`
          : f.booked
            ? "Ask the courier to pick up the booked parcels, or cancel the ones that will not ship."
            : "Ask the courier where the parcels in transit are.",
        affects: `${n(f.booked + f.inTransit)} orders`,
        link: f.wroteIn?.orders
          ? { to: `/orders?${period}&stuck=wrote`, label: `See the ${n(f.wroteIn.orders)} orders` }
          : { to: `/orders?${period}&stuck=1`, label: "See orders" },
      };
    case "returns_not_received":
      return {
        headline: `${n(f.older)} returns not confirmed back after 14 days`,
        figure: f.productCost ? figure(f.productCost) : n(f.orders),
        note: f.productCost ? `of product in ${n(f.orders)} returned orders not marked received in Courierify` : "returned orders not marked received in Courierify",
        next: "Check them against the courier's return slip, and mark the ones that arrived as received in Courierify.",
        affects: `${n(f.orders)} returned orders`,
        link: { to: `/shipping?${period}`, label: "See returns" },
      };
    case "courier_deductions":
      return {
        headline: `${payerName(f.payer)} kept COD its statement does not explain`,
        figure: `−${figure(f.unitemized)}`,
        note: `${pct(f.unitemizedShare)} of the ${figure(f.cod)} COD it collected, on ${n(f.statements)} statement${f.statements === 1 ? "" : "s"}`,
        next: `Ask ${payerName(f.payer)} for a breakdown of the deduction.`,
        affects: `${n(f.statements)} statement${f.statements === 1 ? "" : "s"}`,
        link: { to: `/finance?${period}`, label: "See deductions" },
      };
    case "courierify_stopped":
      return {
        headline: `Orders stopped going through Courierify after ${f.lastParcelDay}`,
        figure: `${n(f.withParcel)} of ${n(f.shipped)}`,
        note: "shipped orders this period were booked through Courierify",
        why: "For the rest there is no courier time, city or fee, so those comparisons stop at that date.",
        affects: `${n(f.shipped - f.withParcel)} shipped orders`,
        link: { to: `/orders?${period}&decidedBy=financify`, label: "See orders" },
      };
  }
}

/** Home's "Needs your attention" shows this many rows; the weekly digest sends the same ones. */
export const ATTENTION_ROWS = 3;

/** The findings that ask for something (rankInsights' "specific" group), in rank order. */
export const needsAction = <T extends { insight: { rank: { group: string } } }>(items: T[]): T[] =>
  items.filter((i) => i.insight.rank.group === "specific");
