import type { SuiteApp } from "@prisma/client";

/**
 * A per-app circuit breaker.
 *
 * Growzar polls apps that run on this same box, on 2 vCPUs with swap already
 * full (pack rule #1). An app that has started failing is usually an app under
 * load, and the worst thing Growzar can do is keep asking. So after a run of
 * failures the circuit opens and calls fail immediately for a cooldown, then
 * one probe decides whether to close it again.
 *
 * State is per process and deliberately so: it is a politeness mechanism, not
 * a correctness one, and putting it in Redis would add a network call to the
 * hot path of deciding not to make a network call. Web and worker each keep
 * their own view, which is the right granularity — they make different calls
 * at different rates.
 */
export type BreakerState = "closed" | "open" | "half-open";

type Entry = {
  failures: number;
  openedAt: number | null;
  /** Set while a half-open probe is in flight, so only one gets through. */
  probing: boolean;
};

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

const entries = new Map<SuiteApp, Entry>();

function entryFor(app: SuiteApp): Entry {
  let entry = entries.get(app);
  if (!entry) {
    entry = { failures: 0, openedAt: null, probing: false };
    entries.set(app, entry);
  }
  return entry;
}

export function breakerState(app: SuiteApp, now = Date.now()): BreakerState {
  const entry = entryFor(app);
  if (entry.openedAt === null) return "closed";
  if (now - entry.openedAt < COOLDOWN_MS) return "open";
  return "half-open";
}

/**
 * May a call go out? A half-open circuit lets exactly one through; everything
 * else waits for its answer rather than piling on.
 */
export function allowRequest(app: SuiteApp, now = Date.now()): boolean {
  const state = breakerState(app, now);
  if (state === "closed") return true;
  if (state === "open") return false;

  const entry = entryFor(app);
  if (entry.probing) return false;
  entry.probing = true;
  return true;
}

export function recordSuccess(app: SuiteApp): void {
  entries.set(app, { failures: 0, openedAt: null, probing: false });
}

/**
 * Only failures that say something about the app's health count. A 404 or a
 * 400 is Growzar asking the wrong question, and tripping the breaker on those
 * would hide a bug behind a cooldown.
 */
export function recordFailure(app: SuiteApp, now = Date.now()): void {
  const entry = entryFor(app);
  entry.probing = false;
  entry.failures += 1;

  if (entry.failures >= FAILURE_THRESHOLD) {
    entry.openedAt = now;
  }
}

/** Test seam. Never called in normal operation. */
export function resetBreakers(): void {
  entries.clear();
}

export const BREAKER_SETTINGS = { FAILURE_THRESHOLD, COOLDOWN_MS };
