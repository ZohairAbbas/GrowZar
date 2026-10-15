/**
 * Watches (G-GZR9-1): what Growzar keeps when someone acts on an insight, so
 * the measurement engine can later say what changed. Pure: the rules for
 * opening and closing a watch, and what its baseline holds.
 *
 * The rules (phase-g9 pack §4 and §10, agreed 2026-10-15):
 * - the first click or app link on an insight opens a watch at that moment;
 *   later clicks don't move it;
 * - a finding that resolved and came back (`reappeared`) opens a new watch on
 *   its next click, and so does a click after a watch was closed;
 * - only a dismissal as "wrong" closes a watch;
 * - an observed change never opens one (it upgrades the claim, G-GZR9-4);
 * - internal accounts' watches are measured but kept out of totals.
 */

import type { Money } from "../metrics/money";
import type { DetectorId, Insight } from "../insights/detectors";

/** What opened the watch. `action` arrives with Phase 8's write actions. */
export const TRIGGERS = ["clicked", "app_link", "action"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const VERDICTS = ["too_early", "improved", "no_change", "worse", "not_enough_data", "closed"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type BaselineSource = "snapshot" | "reconstructed" | "unavailable";

/**
 * A placebo watch (pack §10.2, approved 2026-10-15): a finding that started
 * firing, measured from then as if acted on, while nobody clicks it. What
 * placebos come out "improved" on is the improvement nobody caused, the
 * baseline a real claim must beat. Never shown, never counted in results;
 * a click closes it ("clicked") and opens the real watch.
 */
export const PLACEBO = "placebo";

/**
 * Whether an evaluation that found an insight opens a placebo for it: when
 * its episode starts (new, or back after resolving), or when it has neither
 * a placebo nor a real watch yet (a finding already firing).
 */
export function opensPlacebo(detector: string, episodeStarts: boolean, has: { placebo: boolean; real: boolean }): boolean {
  if (!watches(detector)) return false;
  return episodeStarts || (!has.placebo && !has.real);
}

/** Informational or data-health findings: nothing to measure afterwards (pack §5). */
export const NO_OUTCOME: ReadonlySet<DetectorId> = new Set<DetectorId>(["margin_ceiling", "outcome_disagreement"]);

export const watches = (detector: string): boolean => !NO_OUTCOME.has(detector as DetectorId);

/**
 * The orders a state-based finding was about when it was judged, followed
 * afterwards (pack §4: state-based windows). `money` is what was owed or at
 * stake on that order, where the detector counts money per order.
 */
export type WatchItem = { orderId: string; money?: Money };

/** What an evaluation keeps on the insight row, and a click copies. */
export type FindingSnapshot = { insight: Insight; items?: WatchItem[] };

export type Baseline = {
  /** The whole finding, money included; null when it could not be had. */
  finding: Insight | null;
  items?: WatchItem[];
  /** `evidenceOf` at the time, kept as the card's few numbers. */
  evidence: Record<string, unknown>;
  /** When the finding was evaluated. */
  evaluatedAt: string | null;
  note?: string;
};

/** A watch from the copy the last evaluation kept; without one, only the evidence. */
export function baselineFrom(
  lastFinding: unknown,
  lastEvidence: unknown,
  lastSeenAt: Date | null,
): { baseline: Baseline; source: BaselineSource } {
  const evidence = (lastEvidence && typeof lastEvidence === "object" ? lastEvidence : {}) as Record<string, unknown>;
  const snap = lastFinding as FindingSnapshot | null;
  if (snap && typeof snap === "object" && snap.insight) {
    return {
      baseline: { finding: snap.insight, ...(snap.items ? { items: snap.items } : {}), evidence, evaluatedAt: lastSeenAt?.toISOString() ?? null },
      source: "snapshot",
    };
  }
  return {
    baseline: { finding: null, evidence, evaluatedAt: lastSeenAt?.toISOString() ?? null, note: "no evaluation had kept the full finding yet" },
    source: "unavailable",
  };
}

/** The insight's latest watch, as the opening rule needs it. */
export type LatestWatch = { actedAt: Date; closedAt: Date | null } | null;

/**
 * Whether a click at `at` opens a new watch: when there is none yet, when the
 * last one was closed, or when the finding came back (`reappeared`) after the
 * last one was opened.
 */
export function opensWatch(detector: string, latest: LatestWatch, lastReappearedAt: Date | null): boolean {
  if (!watches(detector)) return false;
  if (!latest || latest.closedAt) return true;
  return !!lastReappearedAt && lastReappearedAt > latest.actedAt;
}

/** Only "It's wrong" ends a watch; the other dismissals and snoozes keep watching (pack §10.5). */
export const closesWatch = (action: { intent: string; reason?: string }): boolean => action.intent === "dismiss" && action.reason === "wrong";

/**
 * Internal accounts (pack §10.1), from `INTERNAL_EMAILS`: a comma-separated
 * list, compared without case.
 */
export function internalEmails(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const isInternal = (email: string | null | undefined, internal: ReadonlySet<string>): boolean =>
  !!email && internal.has(email.trim().toLowerCase());
