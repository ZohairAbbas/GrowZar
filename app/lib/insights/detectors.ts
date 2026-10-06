/**
 * The insight framework's detector layer (G-GZR3-3). Pure.
 *
 * A detector reads only the metric layer (through `FindingsInput`) and
 * answers one of four ways, so the inbox never shows an unexplained gap:
 *  - `found`: one or more insights, each with a stable fingerprint, so a
 *    dismissal or snooze sticks to the same subject across runs;
 *  - `nothing_found`: it checked, and the situation is not there;
 *  - `not_enough_data`: its gate failed, with the reason;
 *  - `locked`: the store lacks an app the detector needs (D-16: a locked
 *    preview, never a built insight).
 *
 * Every insight is a single-merchant finding until more merchants enrol;
 * the backtests in G-GZR3-9 say so in their results.
 */
import {
  courierifyStoppedFinding,
  disagreementFinding,
  isSkip,
  cashHeldFindings,
  marginFinding,
  missingFeesFinding,
  unconfirmedFinding,
  courierCityFindings,
  productLossFindings,
  cityReturnsFindings,
  variantReturnsFinding,
  type Finding,
  type FindingsInput,
  type Skip,
} from "../metrics/findings";

export type App = "COURIERIFY" | "FINANCIFY";

export type DetectorId =
  | "outcome_disagreement"
  | "variant_returns"
  | "margin_ceiling"
  | "courierify_stopped"
  | "missing_courier_fees"
  | "cash_held"
  | "unconfirmed_returns"
  | "courier_for_city"
  | "product_loss"
  | "city_returns";

export type Insight = {
  detector: DetectorId;
  /** "store" for a store-wide finding, else the subject's key (a variant id). */
  subject: string;
  /** `detector:subject`: what a dismissal or snooze attaches to. */
  fingerprint: string;
  /**
   * Ranking until money is validated (PLAN.md §3): specific findings first,
   * by how many orders they concern; store-wide context after them.
   */
  rank: { group: "specific" | "context"; ordersAffected: number };
  /** Shows money: needs `finance:view` (the staff role sees none). */
  revealsMoney: boolean;
  finding: Finding;
};

export type DetectorOutcome =
  | { detector: DetectorId; status: "found"; insights: Insight[] }
  | { detector: DetectorId; status: "nothing_found" | "not_enough_data"; reason: string }
  | { detector: DetectorId; status: "locked"; needs: App[]; preview: string };

type Detector = {
  id: DetectorId;
  /**
   * Apps the detector cannot work without. The specific detectors need both:
   * what one app could say alone stays in that app (DECISION-LAYER §3). The
   * money card is context, and works from Financify alone.
   */
  needs: App[];
  label: string;
  /** What connecting the missing app would show (D-16). */
  preview: string;
  run(input: FindingsInput): Insight[] | Skip;
};

const insight = (
  detector: DetectorId,
  subject: string,
  finding: Finding,
  rank: Insight["rank"],
  revealsMoney: boolean,
): Insight => ({ detector, subject, fingerprint: `${detector}:${subject}`, rank, revealsMoney, finding });


export const DETECTORS: readonly Detector[] = [
  {
    id: "outcome_disagreement",
    needs: ["COURIERIFY", "FINANCIFY"],
    label: "Where Courierify and Financify disagree on an order's outcome",
    preview: "Orders your books count as delivered that the courier says came back",
    run(input) {
      const f = disagreementFinding(input);
      if (isSkip(f)) return f;
      return [insight("outcome_disagreement", "store", f, { group: "specific", ordersAffected: f.total }, true)];
    },
  },
  {
    id: "variant_returns",
    needs: ["COURIERIFY", "FINANCIFY"],
    label: "Products that come back far more often than the rest",
    preview: "Which products come back far more often than your best sellers",
    run(input) {
      const f = variantReturnsFinding(input);
      if (isSkip(f)) return f;
      // One insight per product, so "I know about this one" dismisses that
      // product and not the next one to cross the line.
      return f.flagged.map((v) =>
        insight(
          "variant_returns",
          v.variantId,
          { ...f, flagged: [v] },
          { group: "specific", ordersAffected: v.excessReturns ?? 0 },
          !!v.cost,
        ),
      );
    },
  },
  {
    id: "margin_ceiling",
    needs: ["FINANCIFY"],
    label: "Where delivered revenue went after COGS and ads",
    preview: "What is left of delivered revenue after COGS and ad spend",
    run(input) {
      const f = marginFinding(input);
      if (isSkip(f)) return f;
      return [insight("margin_ceiling", "store", f, { group: "context", ordersAffected: f.delivered }, true)];
    },
  },
  {
    id: "courierify_stopped",
    needs: ["COURIERIFY", "FINANCIFY"],
    label: "Whether orders still go through Courierify",
    preview: "When orders stop going through Courierify, and what that loses",
    run(input) {
      const f = courierifyStoppedFinding(input);
      if (isSkip(f)) return f;
      return [insight("courierify_stopped", "store", f, { group: "context", ordersAffected: f.shipped - f.withParcel }, false)];
    },
  },
  {
    id: "missing_courier_fees",
    needs: ["COURIERIFY", "FINANCIFY"],
    label: "Shipped orders whose courier fee is not recorded (I13)",
    preview: "Orders whose courier fee is missing, so profit reads higher than it is",
    run(input) {
      const f = missingFeesFinding(input);
      if (isSkip(f)) return f;
      // Context, not specific: a data gap of thousands of orders would
      // otherwise outrank every finding about the business itself.
      return [insight("missing_courier_fees", "store", f, { group: "context", ordersAffected: f.missing }, !!f.estimate)];
    },
  },
  {
    id: "cash_held",
    // Courierify alone (D-47's named exception): Courierify does not show this.
    needs: ["COURIERIFY"],
    label: "COD a courier or 3PL has not paid (I4)",
    preview: "COD your couriers have not paid, judged against how often each one pays you",
    run(input) {
      const list = cashHeldFindings(input);
      if (!Array.isArray(list)) return list;
      return list.map((f) => insight("cash_held", f.payer, f, { group: "specific", ordersAffected: f.orders }, true));
    },
  },
  {
    id: "unconfirmed_returns",
    needs: ["COURIERIFY", "FINANCIFY"],
    label: "Orders the buyer never confirmed, and how often they come back (I8)",
    preview: "How much more often orders the buyer never confirmed come back",
    run(input) {
      const f = unconfirmedFinding(input);
      if (isSkip(f)) return f;
      return [insight("unconfirmed_returns", "store", f, { group: "specific", ordersAffected: f.excessReturns }, !!f.cost)];
    },
  },
  {
    id: "courier_for_city",
    // Rates alone are Courierify's; Financify's profit per order is what
    // PLAN's impact formula adds once it is validated.
    needs: ["COURIERIFY", "FINANCIFY"],
    label: "A route that delivers better in a city (I1)",
    preview: "Which courier, booked how, delivers best in each city",
    run(input) {
      const list = courierCityFindings(input);
      if (!Array.isArray(list)) return list;
      return list.map((f) => {
        const w = f.worse[0]!;
        // Returns a switch would have avoided on the worse route's own volume.
        const ordersAffected = Math.round((w.decided * w.gapPoints) / 100);
        return insight("courier_for_city", f.city.toLowerCase(), f, { group: "specific", ordersAffected }, false);
      });
    },
  },
  {
    id: "product_loss",
    needs: ["COURIERIFY", "FINANCIFY"],
    label: "A product that looks profitable but loses money after returns (I2)",
    preview: "Which products look profitable until returns are counted",
    run(input) {
      const list = productLossFindings(input);
      if (!Array.isArray(list)) return list;
      return list.map((f) => insight("product_loss", f.variantId, f, { group: "specific", ordersAffected: f.returned }, true));
    },
  },
  {
    id: "city_returns",
    needs: ["COURIERIFY", "FINANCIFY"],
    label: "A city whose orders come back far more often (I12)",
    preview: "Cities where orders come back far more often than the rest",
    run(input) {
      const list = cityReturnsFindings(input);
      if (!Array.isArray(list)) return list;
      return list.map((f) =>
        insight("city_returns", f.city.toLowerCase(), f, { group: "specific", ordersAffected: Math.max(0, f.returned - Math.round((f.decided * f.rest.returnRate) / 100)) }, false),
      );
    },
  },
];

export function runDetectors(input: FindingsInput, connected: ReadonlySet<App>): DetectorOutcome[] {
  return DETECTORS.map((d): DetectorOutcome => {
    const missing = d.needs.filter((a) => !connected.has(a));
    if (missing.length) return { detector: d.id, status: "locked", needs: missing, preview: d.preview };
    const result = d.run(input);
    if (!Array.isArray(result)) return { detector: d.id, status: result.status, reason: result.reason };
    return { detector: d.id, status: "found", insights: result };
  });
}

export const detectorLabel = (id: DetectorId) => DETECTORS.find((d) => d.id === id)!.label;

/** Specific before context; within each, more orders first; ties by fingerprint, so the order is stable. */
export function rankInsights(insights: readonly Insight[]): Insight[] {
  const group = { specific: 0, context: 1 } as const;
  return [...insights].sort(
    (a, b) =>
      group[a.rank.group] - group[b.rank.group] ||
      b.rank.ordersAffected - a.rank.ordersAffected ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
}

/**
 * Strip money for a viewer without `finance:view` (the staff role: "nothing
 * that reveals money"). Done on the server, so it never reaches the browser.
 */
export function withoutMoney(insights: readonly Insight[]): Insight[] {
  return insights.flatMap((i) => {
    if (!i.revealsMoney) return [i];
    const f = i.finding;
    if (f.kind === "disagreements") {
      return [{ ...i, revealsMoney: false, finding: { ...f, groups: f.groups.map((g) => ({ ...g, placed: [] })) } }];
    }
    // Estimates go; the card, in orders, stays.
    if (f.kind === "unconfirmed_returns") return [{ ...i, revealsMoney: false, finding: { ...f, cost: null } }];
    if (f.kind === "missing_fees") return [{ ...i, revealsMoney: false, finding: { ...f, estimate: null } }];
    if (f.kind === "variant_returns") {
      return [{ ...i, revealsMoney: false, finding: { ...f, flagged: f.flagged.map((v) => ({ ...v, cost: null })) } }];
    }
    return [];
  });
}

/** The few numbers an evaluation keeps, to say later what changed. */
export function evidenceOf(i: Insight): Record<string, number | string> {
  const f = i.finding;
  switch (f.kind) {
    case "disagreements":
      return { orders: f.total, bothApps: f.bothApps };
    case "variant_returns":
      return { returnRate: f.flagged[0]!.returnRate, decided: f.flagged[0]!.decided, storeRate: f.store.returnRate };
    case "margin":
      return { ceiling: f.ceiling.amount, currency: f.ceiling.currency, adsShare: f.adsShareOfDelivered };
    case "courierify_stopped":
      return { lastParcelDay: f.lastParcelDay, shipped: f.shipped, withParcel: f.withParcel };
    case "missing_fees":
      return { missing: f.missing, viaCourierify: f.viaCourierify };
    case "cash_held":
      return { orders: f.orders, daysLate: f.daysLate, lastPaidDay: f.lastPaidDay };
    case "unconfirmed_returns":
      return { unanswered: f.unanswered.returnRate, confirmed: f.confirmed.returnRate, waiting: f.waiting };
    case "product_loss":
      return { ceiling: f.ceiling.amount, per30Days: f.per30Days.amount, returnRate: f.returnRate };
    case "city_returns":
      return { returnRate: f.returnRate, rest: f.rest.returnRate, decided: f.decided };
    case "courier_for_city":
      return { best: `${f.best.courier}/${f.best.via}`, bestRate: f.best.rate, worst: `${f.worse[0]!.courier}/${f.worse[0]!.via}`, gap: f.worse[0]!.gapPoints };
  }
}
