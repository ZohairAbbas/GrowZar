/**
 * Ranges for every Phase 11 forecast (G-GZR11-1, pack §5.1). Pure.
 *
 * A figure is a low / likely / high triple. Low and high are the 10th and
 * 90th percentiles of a bootstrap, so "actual inside low–high" should happen
 * 80% of the time, which is the pass bar every backtest uses. Headline money
 * takes the low end.
 *
 * Draws come from a seeded generator: the same inputs give the same range, so
 * Plan and Ask can never show two different figures for one question (§7).
 */

export type Range = { low: number; likely: number; high: number };

export const LOW_Q = 0.1;
export const HIGH_Q = 0.9;
export const DEFAULT_ITERATIONS = 1000;
export const DEFAULT_SEED = 11;

/** Linear interpolation between order statistics; null on an empty list. `sorted` must be ascending. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export const median = (sorted: readonly number[]) => quantile(sorted, 0.5);

/** mulberry32: small, fast, and good enough to resample with. Returns [0, 1). */
export function rng(seed: number = DEFAULT_SEED): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The range of a set of simulated outcomes, with `likely` given or taken as their median. */
export function rangeOf(draws: readonly number[], likely?: number): Range | null {
  const sorted = [...draws].sort((a, b) => a - b);
  const low = quantile(sorted, LOW_Q);
  const high = quantile(sorted, HIGH_Q);
  if (low === null || high === null) return null;
  const mid = likely ?? quantile(sorted, 0.5)!;
  // A point estimate outside its own draws (a skewed statistic) widens the range rather than sitting outside it.
  return { low: Math.min(low, mid), likely: mid, high: Math.max(high, mid) };
}

/**
 * Resample `items` with replacement and compute `stat` on each sample.
 * `likely` is the statistic on the whole set, not the draws' median.
 */
export function bootstrap<T>(
  items: readonly T[],
  stat: (sample: readonly T[]) => number,
  { iterations = DEFAULT_ITERATIONS, seed = DEFAULT_SEED }: { iterations?: number; seed?: number } = {},
): Range | null {
  if (!items.length) return null;
  const next = rng(seed);
  const draws: number[] = [];
  const sample = new Array<T>(items.length);
  for (let k = 0; k < iterations; k++) {
    for (let i = 0; i < items.length; i++) sample[i] = items[Math.floor(next() * items.length)]!;
    draws.push(stat(sample));
  }
  return rangeOf(draws, stat(items));
}

/**
 * A total from parts whose draws are not at hand: lows add to the low, highs
 * to the high. Wider than simulating the parts together, so it errs safe.
 */
export function addRanges(parts: readonly Range[]): Range {
  return parts.reduce((s, r) => ({ low: s.low + r.low, likely: s.likely + r.likely, high: s.high + r.high }), { low: 0, likely: 0, high: 0 });
}

export const DAY_MS = 86_400_000;
export const daysBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY_MS;
