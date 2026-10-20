/**
 * Return risk per order (G-GZR11-4, pack §5.5 and §10 P11-4, P11-8, P11-9).
 * Pure.
 *
 * A transparent additive score, from this store's own history: each signal
 * adds the log-odds of its category's return rate against the store's,
 * shrunk toward the store's rate by K[signal] orders of it, so a category
 * seen a few times says little. No model is fitted or trained (Q11 clause
 * E; per-store statistics fall outside it, P11-10). The reasons are the
 * largest contributions, in words.
 *
 * The score is learned in one pass through the store's orders in time
 * order: an order is scored when it is placed, from outcomes known by then,
 * and its own outcome joins the counts when it becomes known. The backtest
 * therefore scores every past order exactly as it would have been scored on
 * the day, for nothing.
 *
 * Signals:
 *  - the buyer's own earlier orders with this store;
 *  - first order or repeat;
 *  - Courierify's network label, only where it was asked within a day of the
 *    order (most past labels were fetched weeks later, so they know returns
 *    that came after the order);
 *  - the city × courier route (the city alone before a courier is booked);
 *  - the riskiest product in the order;
 *  - the WhatsApp confirmation state;
 *  - an offer taken at checkout (stores with Preventify);
 *  - cash on delivery or paid in advance.
 *
 * Bands (P11-4: a band and its reasons, never a percentage): "high" is the
 * largest top slice of scores whose odds of a return were at least
 * HIGH_RATIO × the store's; "low" the largest bottom slice at most
 * LOW_RATIO × them; the rest "medium". Odds, not rates: the pack's "2× the
 * store's return rate" cannot be reached by a store returning 33–43% of
 * orders, while 2× the odds is 50% returned there and 28% on a store at
 * 16%. Cut-offs come from the backtest and need Zohair's approval before a
 * merchant sees a band.
 */

export type Signal = "buyer" | "repeat" | "network" | "route" | "product" | "confirmation" | "offer" | "payment";

export type RiskOrder = {
  orderId: string;
  createdAt: Date;
  /** When the outcome became known; null when never decided. */
  knownAt: Date | null;
  /** True returned, false delivered, null not decided (open, cancelled). */
  returned: boolean | null;
  customerId: string | null;
  courier: string | null;
  city: string | null;
  products: Array<{ id: string; title: string | null }>;
  confirmation: string | null;
  payment: "cod" | "prepaid" | "unknown";
  /** Null when the store has no Preventify. */
  offerTaken: boolean | null;
  /** Courierify's answer, kept only when asked within a day of the order. */
  network: { level: string; otherStores: number | null; orders: number | null; returned: number | null } | null;
};

/** Orders a band is shown on (P11-9): not yet with the courier, placed in the last RISK_OPEN_DAYS. */
export const RISK_OUTCOMES = ["not_shipped", "booked"] as const;
export const RISK_OPEN_DAYS = 30;
/** The buttons a high band leads to: confirm before shipping, as I8's card does. */
export const RISK_SCREENS = ["courierify_confirmations", "whatkabot_cod_confirmation"] as const;

/** Orders of a category that weigh as much as its own (shrinkage toward the store's rate). */
export const K: Record<Signal, number> = { buyer: 3, repeat: 30, network: 30, route: 30, product: 30, confirmation: 30, offer: 30, payment: 30 };
/** Decided orders a store needs before anything is scored. */
export const MIN_STORE = 100;
export const HIGH_RATIO = 2;
export const LOW_RATIO = 0.5;
/** Orders a band needs in the backtest before it is used. */
export const MIN_BAND = 30;
/** A contribution smaller than this (log-odds) is not worth a reason. */
export const MIN_REASON = 0.15;

type Count = { n: number; r: number };
export type Category = { signal: Signal; key: string; label: string };
export type Contribution = Category & { value: number; n: number; r: number };
export type Scored = { score: number; storeRate: number; contributions: Contribution[] };

/** What the pass has learned so far. */
export class RiskState {
  store: Count = { n: 0, r: 0 };
  readonly counts = new Map<string, Count>();
  readonly placements = new Map<string, number>();

  get(signal: Signal, key: string): Count | undefined {
    return this.counts.get(`${signal}:${key}`);
  }

  add(cat: Category, returned: boolean) {
    const k = `${cat.signal}:${cat.key}`;
    const c = this.counts.get(k) ?? { n: 0, r: 0 };
    this.counts.set(k, { n: c.n + 1, r: c.r + (returned ? 1 : 0) });
  }
}

const logit = (p: number) => Math.log(p / (1 - p));
const odds = (p: number) => (p >= 1 ? Infinity : p / (1 - p));

const CONFIRMATION_LABEL: Record<string, string> = {
  confirmed: "confirmed on WhatsApp",
  timed_out: "no answer to the WhatsApp confirmation",
  expired: "the WhatsApp confirmation expired",
  declined: "declined the WhatsApp confirmation",
  none: "no WhatsApp confirmation sent",
};

/** The categories an order falls in, as it stands when placed. */
export function categoriesOf(o: RiskOrder, state: RiskState): Category[] {
  const cats: Category[] = [];
  if (o.customerId) {
    cats.push({ signal: "buyer", key: o.customerId, label: "this buyer's earlier orders" });
    const first = (state.placements.get(o.customerId) ?? 0) === 0;
    cats.push({ signal: "repeat", key: first ? "first" : "repeat", label: first ? "a first order" : "a repeat buyer" });
  }
  if (o.network) cats.push({ signal: "network", key: o.network.level, label: `Courierify's network rates this buyer ${o.network.level.replace("_", " ")}` });
  const city = o.city ?? "unmapped";
  cats.push(o.courier ? { signal: "route", key: `${o.courier}|${city}`, label: `${city} by ${o.courier}` } : { signal: "route", key: `city|${city}`, label: city });
  for (const p of o.products) cats.push({ signal: "product", key: p.id, label: p.title ?? `product ${p.id}` });
  const conf = o.confirmation ?? "none";
  cats.push({ signal: "confirmation", key: conf, label: CONFIRMATION_LABEL[conf] ?? `WhatsApp confirmation ${conf.replace("_", " ")}` });
  if (o.offerTaken !== null) cats.push({ signal: "offer", key: o.offerTaken ? "taken" : "none", label: o.offerTaken ? "took an offer at checkout" : "no offer taken" });
  cats.push({ signal: "payment", key: o.payment, label: o.payment === "prepaid" ? "paid in advance" : o.payment === "cod" ? "cash on delivery" : "payment method unknown" });
  return cats;
}

/** Score an order's categories against what the state knows. Null until the store has MIN_STORE decided orders. */
export function scoreOf(cats: readonly Category[], state: RiskState): Scored | null {
  if (state.store.n < MIN_STORE) return null;
  const p = (state.store.r + 0.5) / (state.store.n + 1);
  const contributions: Contribution[] = [];
  let bestProduct: Contribution | null = null;
  for (const cat of cats) {
    const c = state.get(cat.signal, cat.key);
    if (!c?.n) continue;
    const shrunk = (c.r + K[cat.signal] * p) / (c.n + K[cat.signal]);
    const value = logit(shrunk) - logit(p);
    const item = { ...cat, value, n: c.n, r: c.r };
    // An order is as risky as its riskiest product, not the sum of its lines.
    if (cat.signal === "product") {
      if (!bestProduct || value > bestProduct.value) bestProduct = item;
    } else contributions.push(item);
  }
  if (bestProduct) contributions.push(bestProduct);
  return { score: logit(p) + contributions.reduce((a, c) => a + c.value, 0), storeRate: p, contributions };
}

export type PassResult = {
  /** Each order scored as it was placed (null before the store had enough history). */
  atPlacement: Map<string, Scored | null>;
  /** Each order's categories, fixed when placed. */
  categories: Map<string, Category[]>;
  state: RiskState;
};

/** One pass through the orders in time order, up to `until`. */
export function riskPass(orders: readonly RiskOrder[], until: Date = new Date()): PassResult {
  type Ev = { at: number; kind: 0 | 1; o: RiskOrder };
  const events: Ev[] = [];
  for (const o of orders) {
    if (o.createdAt > until) continue;
    events.push({ at: o.createdAt.getTime(), kind: 1, o });
    if (o.returned !== null && o.knownAt && o.knownAt <= until) events.push({ at: Math.max(o.knownAt.getTime(), o.createdAt.getTime()), kind: 0, o });
  }
  // At the same instant, an outcome becoming known comes before a new order.
  events.sort((a, b) => a.at - b.at || a.kind - b.kind);
  const state = new RiskState();
  const atPlacement = new Map<string, Scored | null>();
  const categories = new Map<string, Category[]>();
  for (const e of events) {
    if (e.kind === 1) {
      const cats = categoriesOf(e.o, state);
      categories.set(e.o.orderId, cats);
      atPlacement.set(e.o.orderId, scoreOf(cats, state));
      if (e.o.customerId) state.placements.set(e.o.customerId, (state.placements.get(e.o.customerId) ?? 0) + 1);
    } else {
      const returned = e.o.returned!;
      state.store = { n: state.store.n + 1, r: state.store.r + (returned ? 1 : 0) };
      for (const cat of categories.get(e.o.orderId) ?? []) state.add(cat, returned);
    }
  }
  return { atPlacement, categories, state };
}

export type Band = "high" | "medium" | "low";
export type Cuts = { high: number | null; low: number | null; storeRate: number; orders: number };

/** Band cut-offs from scored, decided orders (see the header). */
export function fitCuts(scored: ReadonlyArray<{ score: number; returned: boolean }>): Cuts {
  const n = scored.length;
  const r = scored.filter((s) => s.returned).length;
  const storeRate = n ? r / n : 0;
  const desc = [...scored].sort((a, b) => b.score - a.score);
  let high: number | null = null;
  let cr = 0;
  desc.forEach((s, i) => {
    cr += s.returned ? 1 : 0;
    const next = desc[i + 1];
    // Only cut between distinct scores.
    if (next && next.score === s.score) return;
    if (i + 1 >= MIN_BAND && odds(cr / (i + 1)) >= HIGH_RATIO * odds(storeRate)) high = s.score;
  });
  let low: number | null = null;
  cr = 0;
  const asc = [...desc].reverse();
  asc.forEach((s, i) => {
    cr += s.returned ? 1 : 0;
    const next = asc[i + 1];
    if (next && next.score === s.score) return;
    if (i + 1 >= MIN_BAND && odds(cr / (i + 1)) <= LOW_RATIO * odds(storeRate)) low = s.score;
  });
  if (high !== null && low !== null && low >= high) low = null;
  return { high, low, storeRate, orders: n };
}

export const bandOf = (score: number, cuts: Cuts): Band =>
  cuts.high !== null && score >= cuts.high ? "high" : cuts.low !== null && score <= cuts.low ? "low" : "medium";

const pct = (r: number, n: number) => `${Math.round((100 * r) / n)}%`;

/** The reasons behind a band, in words: the largest contributions in its direction. */
export function reasonsOf(s: Scored, band: Band, network?: RiskOrder["network"]): string[] {
  const up = band !== "low";
  return s.contributions
    .filter((c) => (up ? c.value >= MIN_REASON : c.value <= -MIN_REASON))
    .sort((a, b) => (up ? b.value - a.value : a.value - b.value))
    .slice(0, 3)
    .map((c) => {
      const rate = `${pct(c.r, c.n)} of ${c.n} came back`;
      switch (c.signal) {
        case "buyer":
          return `this buyer returned ${c.r} of ${c.n} earlier orders`;
        case "network": {
          // D-53: exact network figures, only when they span 2+ other stores.
          const figures =
            network?.orders != null && network.returned != null && (network.otherStores ?? 0) >= 2
              ? `: ${network.orders - network.returned} of ${network.orders} delivered network-wide (${pct(network.orders - network.returned, network.orders)})`
              : network?.otherStores === 1
                ? " (from 1 other store)"
                : "";
          return `${c.label}${figures}`;
        }
        case "route":
        case "product":
          return `${c.label}: ${rate} (store ${Math.round(s.storeRate * 100)}%)`;
        default:
          return `${c.label}: ${rate}`;
      }
    });
}

export type BandReport = { band: Band; orders: number; returned: number; rate: number };
export type RiskBacktest = {
  fit: { from: string; to: string; cuts: Cuts };
  test: {
    from: string;
    to: string;
    orders: number;
    storeRate: number;
    bands: BandReport[];
    highCatches: number | null;
    /** Return rate by tenth of the score, highest first. */
    tenths: Array<{ orders: number; rate: number }>;
  };
};

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Score every order as it was placed, then split the decided, scored orders
 * placed before `asOf` in time: fit the cut-offs on the older half, and
 * report on the newer half (out of sample) the return rate per band, the
 * share of its returns "high" caught, and the return rate by tenth of the
 * score. Outcomes are read as known by `now`.
 */
export function backtestRisk(orders: readonly RiskOrder[], asOf: Date, { now = asOf } = {}): RiskBacktest {
  // Scores at placement only ever use what was known then.
  const pass = riskPass(orders, now);
  const scored = orders
    .filter((o) => o.createdAt < asOf && o.returned !== null && o.knownAt && o.knownAt <= now)
    .map((o) => ({ o, s: pass.atPlacement.get(o.orderId) }))
    .filter((x): x is { o: RiskOrder; s: Scored } => !!x.s)
    .sort((a, b) => a.o.createdAt.getTime() - b.o.createdAt.getTime())
    .map((x) => ({ at: x.o.createdAt, score: x.s.score, returned: x.o.returned! }));
  const half = Math.floor(scored.length / 2);
  const fit = scored.slice(0, half);
  const test = scored.slice(half);
  const cuts = fitCuts(fit);
  const bands: BandReport[] = (["high", "medium", "low"] as const).map((band) => {
    const list = test.filter((t) => bandOf(t.score, cuts) === band);
    const returned = list.filter((t) => t.returned).length;
    return { band, orders: list.length, returned, rate: list.length ? returned / list.length : 0 };
  });
  const returns = test.filter((t) => t.returned).length;
  const desc = [...test].sort((a, b) => b.score - a.score);
  const tenths = Array.from({ length: 10 }, (_, i) => {
    const slice = desc.slice(Math.floor((i * desc.length) / 10), Math.floor(((i + 1) * desc.length) / 10));
    return { orders: slice.length, rate: slice.length ? slice.filter((t) => t.returned).length / slice.length : 0 };
  });
  const span = (xs: typeof scored) => (xs.length ? { from: day(xs[0]!.at), to: day(xs.at(-1)!.at) } : { from: "–", to: "–" });
  return {
    fit: { ...span(fit), cuts },
    test: { ...span(test), orders: test.length, storeRate: test.length ? returns / test.length : 0, bands, highCatches: returns ? bands[0]!.returned / returns : null, tenths },
  };
}

/**
 * The placebo: every order keeps its time and outcome but takes another
 * order's signals (a seeded shuffle). A score that still separates returns
 * is reading something other than the signals.
 */
export function shuffled(orders: readonly RiskOrder[], next: () => number): RiskOrder[] {
  const features = orders.map(({ customerId, courier, city, products, confirmation, payment, offerTaken, network }) => ({ customerId, courier, city, products, confirmation, payment, offerTaken, network }));
  for (let i = features.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [features[i], features[j]] = [features[j]!, features[i]!];
  }
  return orders.map((o, i) => ({ ...o, ...features[i]! }));
}
