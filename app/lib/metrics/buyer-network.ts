/**
 * Courierify's buyer network in Growzar (Phase 5, G-GZR5-16).
 *
 * Courierify's network and its risk rule stay its own (D-54): Growzar asks
 * `POST /api/v1/growzar/buyer-network` about the store's own buyers, keeps
 * the answer, and shows it labelled as Courierify's. Figures are exact (D-53):
 * "3 of 5 delivered here; 40 of 50 across 3 other stores". Courierify sends
 * other stores' figures only when the buyer has 2 or more of them, and never
 * says which.
 *
 * The figures are today's totals. They describe a buyer now, so they may
 * guide what to do with an open order, but they are never used to judge a
 * past one: that would count parcels that came after it (I5 waits for
 * G-CFY5-3's cut-off date).
 */

export const RISK_LEVELS = ["high", "medium", "low", "insufficient_data"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Phones per request: Courierify allows 200, but a cold 200 took 8.7 s against a 10 s timeout. */
export const BATCH_SIZE = 100;
/** An answer older than this is asked again, new order or not: other stores keep shipping. */
export const STALE_MS = 7 * 86_400_000;
/** Buyers kept fresh: those with an order in this many days. */
export const ACTIVE_DAYS = 90;
/** Batches per worker cycle, outside and during the quiet hours (05:00–15:00 UTC). */
export const BATCHES_PER_CYCLE = { open: 10, quiet: 1 } as const;

export type Figures = { orders: number; delivered: number; returned: number; active: number };
export type NetworkFigures = Figures & { otherStores: number };

export type BuyerNetworkAnswer = {
  phone: string;
  status: string;
  storeFigures: (Figures & { cancelled: number; shipments: number }) | null;
  network: (NetworkFigures & { shipments: number; carriedShipments: number; firstSeen: string | null; lastSeen: string | null }) | null;
  otherStores: number | null;
  riskLevel: RiskLevel | null;
  riskBasis: string | null;
};

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One item of Courierify's answer. Only counts are kept: no cities, couriers or money. */
export function parseAnswer(p: unknown): BuyerNetworkAnswer | null {
  const r = obj(p);
  const phone = str(r?.phone);
  const status = str(r?.status);
  if (!r || !phone || !status) return null;
  const s = obj(r.store);
  const n = obj(r.network);
  const risk = obj(r.risk);
  const otherStores = int(n?.otherStores);
  const storeFigures =
    s && int(s.orders) !== null
      ? { orders: int(s.orders)!, shipments: int(s.shipments) ?? 0, delivered: int(s.delivered) ?? 0, returned: int(s.returned) ?? 0, active: int(s.active) ?? 0, cancelled: int(s.cancelled) ?? 0 }
      : null;
  // Courierify nulls every network figure under 2 other stores (D-53's guard); so does Growzar.
  const network =
    n && otherStores !== null && otherStores >= 2 && int(n.orders) !== null
      ? {
          otherStores,
          orders: int(n.orders)!,
          shipments: int(n.shipments) ?? 0,
          carriedShipments: int(n.carriedShipments) ?? 0,
          delivered: int(n.delivered) ?? 0,
          returned: int(n.returned) ?? 0,
          active: int(n.active) ?? 0,
          firstSeen: str(n.firstSeen),
          lastSeen: str(n.lastSeen),
        }
      : null;
  const level = str(risk?.level);
  return {
    phone,
    status,
    storeFigures,
    network,
    otherStores,
    riskLevel: level && (RISK_LEVELS as readonly string[]).includes(level) ? (level as RiskLevel) : null,
    riskBasis: str(risk?.basis),
  };
}

export type RefreshCandidate = { customerId: string; phone: string; lastOrderAt: Date; hasOpenOrder: boolean };

/**
 * Who to ask this cycle, most useful first: buyers with an open order (the
 * answer can still change what the merchant does), then buyers never asked,
 * then answers older than the buyer's latest order or than STALE_MS.
 */
export function pickRefresh(
  candidates: readonly RefreshCandidate[],
  fetched: ReadonlyMap<string, { fetchedAt: Date; phone: string }>,
  now: Date,
  limit: number,
): RefreshCandidate[] {
  const due = candidates.filter((c) => {
    const f = fetched.get(c.customerId);
    return !f || f.phone !== c.phone || f.fetchedAt < c.lastOrderAt || now.getTime() - f.fetchedAt.getTime() > STALE_MS;
  });
  const rank = (c: RefreshCandidate) => (c.hasOpenOrder ? 0 : fetched.has(c.customerId) ? 2 : 1);
  return due
    .sort((a, b) => rank(a) - rank(b) || b.lastOrderAt.getTime() - a.lastOrderAt.getTime() || a.customerId.localeCompare(b.customerId))
    .slice(0, limit);
}

export type StoredAnswer = {
  customerId: string;
  status: string;
  storeFigures: unknown;
  network: unknown;
  otherStores: number | null;
  riskLevel: string | null;
  riskBasis: string | null;
  fetchedAt: Date;
};

/** What a buyer row or an order shows: Courierify's counts and label, nothing else. */
export type BuyerNetworkLine = {
  store: Figures | null;
  network: NetworkFigures | null;
  riskLevel: RiskLevel | null;
  riskBasis: string | null;
  fetchedAt: string;
};

const figures = (v: unknown): Figures | null => {
  const r = obj(v);
  return r && int(r.orders) !== null
    ? { orders: int(r.orders)!, delivered: int(r.delivered) ?? 0, returned: int(r.returned) ?? 0, active: int(r.active) ?? 0 }
    : null;
};

export function lineOf(a: StoredAnswer): BuyerNetworkLine | null {
  if (a.status !== "ok") return null;
  const n = figures(a.network);
  return {
    store: figures(a.storeFigures),
    network: n && a.otherStores !== null && a.otherStores >= 2 ? { ...n, otherStores: a.otherStores } : null,
    riskLevel: a.riskLevel && (RISK_LEVELS as readonly string[]).includes(a.riskLevel) ? (a.riskLevel as RiskLevel) : null,
    riskBasis: a.riskBasis,
    fetchedAt: a.fetchedAt.toISOString(),
  };
}

export type OpenOrder = { orderId: string; orderName: string | null; customerId: string; createdAt: Date | null; outcome: string; phoneTail: string | null };

export type BuyerNetworkView = {
  /** The period's buyers, and how many Courierify has answered for. */
  buyers: number;
  answered: number;
  /** Of those answered, with figures from 2+ other stores. */
  withNetwork: number;
  /** Courierify's label for the answered buyers. */
  levels: Record<RiskLevel, number>;
  /** Open orders whose buyer Courierify rates high, most returns across the network first. */
  openHigh: Array<OpenOrder & { line: BuyerNetworkLine }>;
  openHighTotal: number;
  /**
   * Open orders in all; of them, those whose buyer Courierify has figures
   * for, and those it answered "not your customer" for: it counts a buyer as
   * the store's only once it has shipped a parcel for them there, so a first
   * order not yet booked gets no figures.
   */
  openOrders: number;
  openAnswered: number;
  openNotShippedHere: number;
  /** The oldest answer shown, so the page can say how fresh it is. */
  oldestFetchedAt: string | null;
};

/** Open orders listed on the panel; the rest are behind the Orders link. */
export const OPEN_HIGH_SHOWN = 15;

export function buyerNetworkView(input: {
  periodBuyers: ReadonlySet<string>;
  answers: ReadonlyMap<string, StoredAnswer>;
  openOrders: readonly OpenOrder[];
}): BuyerNetworkView {
  const levels = Object.fromEntries(RISK_LEVELS.map((l) => [l, 0])) as Record<RiskLevel, number>;
  let answered = 0;
  let withNetwork = 0;
  let oldest: Date | null = null;
  for (const id of input.periodBuyers) {
    const a = input.answers.get(id);
    const line = a ? lineOf(a) : null;
    if (!a || !line) continue;
    answered += 1;
    if (line.network) withNetwork += 1;
    if (line.riskLevel) levels[line.riskLevel] += 1;
    if (!oldest || a.fetchedAt < oldest) oldest = a.fetchedAt;
  }
  const open = input.openOrders.map((o) => {
    const a = input.answers.get(o.customerId);
    return { ...o, status: a?.status ?? null, line: a ? lineOf(a) : null };
  });
  const high = open
    .filter((o): o is OpenOrder & { status: string; line: BuyerNetworkLine } => o.line?.riskLevel === "high")
    .sort((a, b) => (b.line.network?.returned ?? 0) + (b.line.store?.returned ?? 0) - ((a.line.network?.returned ?? 0) + (a.line.store?.returned ?? 0)) || a.orderId.localeCompare(b.orderId));
  return {
    buyers: input.periodBuyers.size,
    answered,
    withNetwork,
    levels,
    openHigh: high.slice(0, OPEN_HIGH_SHOWN).map(({ status: _status, ...o }) => o),
    openHighTotal: high.length,
    openOrders: open.length,
    openAnswered: open.filter((o) => o.line).length,
    openNotShippedHere: open.filter((o) => o.status === "not_your_customer").length,
    oldestFetchedAt: oldest?.toISOString() ?? null,
  };
}

/** Outcomes of an order not yet decided and still worth acting on. */
export const OPEN_OUTCOMES = ["not_shipped", "booked", "in_transit", "unknown"] as const;
/** Open orders older than this are left to the stuck-parcel card, not the network panel. */
export const OPEN_DAYS = 30;

const LEVEL_LABEL: Record<RiskLevel, string> = { high: "High", medium: "Medium", low: "Low", insufficient_data: "Not enough history" };
export const riskLabel = (l: RiskLevel) => LEVEL_LABEL[l];

/** "3 of 5 delivered, 1 returned": counts, as D-53 asks, never a band. */
export function figuresText(f: Figures): string {
  return `${f.delivered} of ${f.orders} delivered${f.returned ? `, ${f.returned} returned` : ""}${f.active ? `, ${f.active} on the way` : ""}`;
}
