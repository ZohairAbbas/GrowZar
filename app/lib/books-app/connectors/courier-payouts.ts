/**
 * Courier payouts into the books (B3, D-86, D-87, D-92), as pure rules.
 *
 * Courierify's `/api/v1/growzar/settlements?include=lines` gives each payout
 * built by the same serializer Financify's Books reads, so the rules are
 * Financify's (porting guide §4.7), on Growzar's wire format:
 *
 *   Dr where it arrived            netPaid (negative for a courier's invoice)
 *   Dr each kind of charge kept    delivery, returns, tax, other
 *   Dr Held by courier             money kept back for a later payout (D-87)
 *   Cr Courier money not for your orders   the part that isn't this store's
 *   Cr Owed by couriers            this store's parcels' collected cash
 *
 * - The lines are this store's own parcels; `unattributedGross` is money for
 *   parcels that aren't (a courier account shared with another business).
 * - A payout with none of the store's parcels is left out.
 * - `identity_broken` is left out and reported; `unallocated_gap` is posted,
 *   the unexplained part to "Courier charges not explained", and flagged
 *   (D-92). A small residual corrects the per-parcel fee split and goes with
 *   delivery charges, as in Financify.
 */

export type Money = { amount: string; currency: string | null } | null;

export interface SettlementLineWire {
  orderId: string | null;
  orderName?: string | null;
  shipmentId?: string | null;
  status?: string | null;
  collectedAmount: Money;
  merchantAdvance?: Money;
  deductions: Array<{ type: string; amount: Money }>;
  netAmount: Money;
  deliveredAt?: string | null;
  settledAt?: string | null;
}

export interface SettlementWire {
  id: string;
  courier: string | null;
  settlementRef?: string | null;
  settlementDate: string | null;
  receivedAt?: string | null;
  direction: "payout" | "invoice";
  status?: string | null;
  shipmentsCount?: number | null;
  netPaid: Money;
  settlementId?: string;
  paymentReference?: string | null;
  grossCollected?: Money;
  linesGross?: Money;
  unattributedGross?: Money;
  totalDeductions?: Money;
  settlementDeductions?: Array<{ type: string; amount: Money }>;
  invariantOk?: boolean;
  invariantReason?: "identity_broken" | "unallocated_gap" | null;
  lines?: SettlementLineWire[];
}

export interface PayoutMapping {
  /** "Owed by couriers". */
  receivable: string;
  /** Where payouts arrive. */
  receivedIn: string;
  delivery: string;
  returns: string;
  /** Tax the courier withheld: an expense by default, or claimable. */
  tax: string;
  other: string;
}

/** Accounts Books creates the first time it needs them. */
export interface PayoutAccounts {
  held: string;
  unexplained: string;
  others: string;
}

export type Bucket = "delivery" | "returns" | "tax" | "other";

const BUCKETS: Record<string, Bucket> = {
  cod_fee: "delivery",
  delivery_fee: "delivery",
  insurance_fee: "delivery",
  fuel_surcharge: "delivery",
  osa_charge: "delivery",
  reversal_fee: "returns",
  tax: "tax",
  wht: "tax",
};

export const bucketFor = (type: string): Bucket => BUCKETS[type] ?? "other";

const COURIER_NAMES: Record<string, string> = {
  tcs: "TCS", postex: "PostEx", leopards: "Leopards", trax: "Trax", mnp: "M&P", "m&p": "M&P", oshi: "Oshi", blueex: "BlueEx",
  swyft: "Swyft", callcourier: "Call Courier", rider: "Rider", smartlane: "SmartLane", trioex: "TrioEx", orio: "Orio",
  instaworld: "InstaWorld", nextstep: "NextStep", apex: "Apex", dex: "Dex",
};

/** "postex" → "PostEx"; unknown codes are title-cased (Financify's rule). */
export function courierName(code: string | null | undefined): string {
  const c = String(code ?? "").trim();
  if (!c) return "Courier";
  return COURIER_NAMES[c.toLowerCase()] ?? c.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/** A wire amount ("1234.50") → minor units, rounded half away from zero. */
export function minor(m: Money, decimals: number): bigint {
  if (!m || m.amount == null) return 0n;
  const x = /^(-)?(\d*)(?:\.(\d*))?$/.exec(String(m.amount).trim());
  if (!x) throw new Error(`Not an amount: ${m.amount}`);
  const frac = x[3] ?? "";
  let v = BigInt(x[2] || "0") * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals).padEnd(decimals, "0") || "0");
  if (frac.length > decimals && Number(frac[decimals]) >= 5) v += 1n;
  return x[1] ? -v : v;
}

/** The day a payout counts: when the money arrived, else the courier's own date. */
export const payoutDay = (s: Pick<SettlementWire, "receivedAt" | "settlementDate">) => (s.receivedAt ?? s.settlementDate ?? "").slice(0, 10);

export type PayoutPlan =
  | { kind: "skip"; reason: "no_lines" | "identity_broken" }
  | {
      kind: "post";
      data: {
        receivable: string;
        receivedIn: string;
        received: string;
        deductions: Array<{ accountId: string; amount: string; description: string | null }>;
        others: { accountId: string; amount: string } | null;
      };
      /** What comes off "Owed by couriers". */
      gross: bigint;
      /** The payout carried an unexplained difference (D-92): flag it. */
      flagged: boolean;
      /** Part of the payout is for parcels that aren't this store's. */
      mixed: boolean;
    };

/** What a planned payout puts on each account (+debit / −credit), as the posting engine would. */
export function planSums(p: Extract<PayoutPlan, { kind: "post" }>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (id: string, v: bigint) => out.set(id, (out.get(id) ?? 0n) + v);
  add(p.data.receivedIn, BigInt(p.data.received));
  for (const d of p.data.deductions) add(d.accountId, BigInt(d.amount));
  if (p.data.others) add(p.data.others.accountId, -BigInt(p.data.others.amount));
  add(p.data.receivable, -p.gross);
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}

/**
 * One payout → the "Courier paid me" document's data.
 *
 * Whole payout (every parcel the store's): gross is the payout's gross; every
 * charge is the store's. Mixed payout: only the store's lines come off what
 * couriers owe, with their own charges and their share (by collected cash)
 * of the payout-level ones; `unallocated` there is the other business's fees
 * and goes with its money. What's left of the bank amount is held apart.
 */
export function planPayout(s: SettlementWire, decimals: number, m: PayoutMapping, acc: PayoutAccounts): PayoutPlan {
  const lines = s.lines ?? [];
  if (lines.length === 0) return { kind: "skip", reason: "no_lines" };
  if (s.invariantOk === false && s.invariantReason === "identity_broken") return { kind: "skip", reason: "identity_broken" };

  const received = minor(s.netPaid, decimals);
  const all = minor(s.grossCollected ?? null, decimals);
  const linesGross = lines.reduce((t, l) => t + minor(l.collectedAmount, decimals), 0n);
  const mixed = minor(s.unattributedGross ?? null, decimals) !== 0n;
  const flagged = s.invariantOk === false && s.invariantReason === "unallocated_gap";

  const sums = new Map<string, bigint>();
  const add = (account: string, v: bigint) => v !== 0n && sums.set(account, (sums.get(account) ?? 0n) + v);
  const target = (type: string): string => {
    if (type === "carry_forward") return acc.held;
    if (type === "unallocated") return flagged ? acc.unexplained : m.delivery;
    const b = bucketFor(type);
    return b === "delivery" ? m.delivery : b === "returns" ? m.returns : b === "tax" ? m.tax : m.other;
  };

  for (const l of lines) for (const d of l.deductions) add(target(d.type), minor(d.amount, decimals));

  let gross: bigint;
  let others = 0n;
  if (!mixed) {
    gross = all;
    for (const d of s.settlementDeductions ?? []) add(target(d.type), minor(d.amount, decimals));
    // The payout's own total wins; anything the items don't explain is "other" (Financify's rule).
    const total = minor(s.totalDeductions ?? null, decimals);
    const itemised = [...sums.values()].reduce((t, v) => t + v, 0n);
    add(m.other, total - itemised);
  } else {
    gross = linesGross;
    for (const d of s.settlementDeductions ?? []) {
      if (d.type === "unallocated") continue; // the other business's fees (D-92)
      const v = minor(d.amount, decimals);
      add(target(d.type), all > 0n ? (v * linesGross) / all : 0n);
    }
    const kept = [...sums.values()].reduce((t, v) => t + v, 0n);
    // What reached the bank, less this store's net share of it.
    others = received - (gross - kept);
  }

  const deductions = [...sums]
    .filter(([, v]) => v !== 0n)
    .map(([accountId, v]) => ({ accountId, amount: v.toString(), description: accountId === acc.held ? "Kept back for a later payout" : accountId === acc.unexplained ? "Not explained by the courier's charges" : null }));
  return {
    kind: "post",
    data: { receivable: m.receivable, receivedIn: m.receivedIn, received: received.toString(), deductions, others: others !== 0n ? { accountId: acc.others, amount: others.toString() } : null },
    gross,
    flagged,
    mixed,
  };
}
