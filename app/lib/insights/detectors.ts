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
  marginFinding,
  missingFeesFinding,
  variantReturnsFinding,
  type Finding,
  type FindingsInput,
  type Skip,
  type VariantReturnsFinding,
} from "../metrics/findings";

export type App = "COURIERIFY" | "FINANCIFY";

export type DetectorId =
  | "outcome_disagreement"
  | "variant_returns"
  | "margin_ceiling"
  | "courierify_stopped"
  | "missing_courier_fees";

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

/** Returns above the store's own rate, in orders: what the gap amounts to. */
function excessReturns(f: VariantReturnsFinding, v: VariantReturnsFinding["flagged"][number]): number {
  return Math.max(0, v.returned - Math.round((v.decided * f.store.returnRate) / 100));
}

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
          { group: "specific", ordersAffected: excessReturns(f, v) },
          false,
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
      return [insight("missing_courier_fees", "store", f, { group: "context", ordersAffected: f.missing }, false)];
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
    if (i.finding.kind === "disagreements") {
      return [{ ...i, revealsMoney: false, finding: { ...i.finding, groups: i.finding.groups.map((g) => ({ ...g, placed: [] })) } }];
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
  }
}
