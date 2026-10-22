/**
 * Inventorify → Books: what each receipt and supplier-ledger entry becomes.
 * Pure (no database, no network), so every rule is tested directly.
 *
 * Inventorify is where stock moves; Books is where money moves (see the spec
 * "Linking Inventorify stock and suppliers to Books"):
 *
 *   receipt                  → bill: Stock (good units) + Damaged, awaiting claim (damaged) / Owed to supplier
 *   ledger bill receipt:<id> → nothing (the receipt made it)
 *   ledger bill claim:<id>:… → bill to Damaged, awaiting claim (invoiced, never sent)
 *   ledger bill, typed       → bill to Purchase differences and charges
 *   credit note              → supplier credit: a claim's to Damaged, awaiting claim; else Purchase differences
 *   adjustment               → bill (owes more) or supplier credit (owes less) to Purchase differences
 *   payment / refund         → not posted: Books is where money moves; shown to match or record
 *   reversal                 → the Books entry it undoes is cancelled (or a draft discarded)
 *
 * Ids are Inventorify's; amounts arrive as decimal strings in the store's one
 * currency ("1234.50"). Amounts here are minor units.
 */

export interface InvMoney {
  amount: string;
  currency: string;
}

export interface InvReceipt {
  id: string;
  poId: string;
  poNumber: string | null;
  supplierId: string | null;
  locationId: string | null;
  receivedOn: string;
  lines: Array<{ variantId: string | null; inventoryItemId: string | null; quantity: number; quantityDamaged: number; unitCost: InvMoney | null }>;
  billLedgerEntryId: string | null;
  currency: string;
  createdAt: string;
}

export type InvLedgerKind = "bill" | "payment" | "credit_note" | "refund" | "adjustment" | "reversal";

export interface InvLedgerEntry {
  id: string;
  supplierId: string;
  kind: InvLedgerKind | string;
  amount: InvMoney | null;
  currency: string;
  date: string;
  sourceKey: string | null;
  reference: string | null;
  poId: string | null;
  receiptId: string | null;
  claimId: string | null;
  reversalOf: string | null;
  createdAt: string;
}

export interface InvAccounts {
  payable: string;
  stock: string;
  /** Damaged stock and units invoiced but not sent, until the supplier's claim settles. */
  awaitingClaim: string;
  /** Typed-in bills, adjustments and credits not tied to a claim (freight, price differences…). */
  purchaseDiffs: string;
}

/** "1234.5" → 123450 for 2 decimals; rounds half away from zero; null when it isn't a number. */
export function decimalToMinorUnits(value: string | null | undefined, decimals: number): bigint | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  const m = s.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  const scale = 10n ** BigInt(decimals);
  let v = BigInt(whole!) * scale + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (frac.length > decimals && Number(frac[decimals]) >= 5) v += 1n;
  return sign === "-" ? -v : v;
}

/** What Books does with one Inventorify row. */
export type InvPlan =
  | { action: "post"; sourceRef: string; type: "bill" | "supplier_credit"; date: string; supplierId: string; memo: string; data: Record<string, unknown> }
  | { action: "payment"; entry: { id: string; supplierId: string; kind: "payment" | "refund"; date: string; amount: string; reference: string | null } }
  | { action: "reverse"; ledgerId: string; date: string; memo: string }
  | { action: "skip"; reason: string };

const short = (id: string) => id.slice(-6);

/**
 * A receipt's bill. The whole quantity is billed at the PO price (Inventorify posts it
 * so); the damaged part waits on the claim account, the rest goes into Stock.
 */
export function planReceipt(r: InvReceipt, a: InvAccounts, o: { currency: string; decimals: number; startDate: string }): InvPlan {
  if (r.currency && r.currency !== o.currency) return { action: "skip", reason: `Receipt ${r.poNumber ?? r.id} is in ${r.currency}, your books are in ${o.currency}` };
  if (r.receivedOn < o.startDate) return { action: "skip", reason: "before the first day" };
  if (!r.supplierId) return { action: "skip", reason: `Receipt on ${r.poNumber ?? "a PO"} has no supplier, so Inventorify posted no bill` };
  let good = 0n;
  let damaged = 0n;
  let units = 0;
  let damagedUnits = 0;
  for (const l of r.lines) {
    const cost = decimalToMinorUnits(l.unitCost?.amount, o.decimals);
    if (cost === null) return { action: "skip", reason: `Receipt on ${r.poNumber ?? "a PO"} has a line without a cost` };
    const qty = Math.max(0, Math.trunc(l.quantity));
    const dmg = Math.min(qty, Math.max(0, Math.trunc(l.quantityDamaged)));
    good += cost * BigInt(qty - dmg);
    damaged += cost * BigInt(dmg);
    units += qty;
    damagedUnits += dmg;
  }
  if (good + damaged === 0n) return { action: "skip", reason: "nothing billed" };
  const lines = [
    ...(good > 0n ? [{ accountId: a.stock, amount: good.toString(), description: `${units - damagedUnits} unit${units - damagedUnits === 1 ? "" : "s"} received` }] : []),
    ...(damaged > 0n ? [{ accountId: a.awaitingClaim, amount: damaged.toString(), description: `${damagedUnits} unit${damagedUnits === 1 ? "" : "s"} arrived damaged — awaiting claim` }] : []),
  ];
  return {
    action: "post",
    sourceRef: `receipt:${r.id}`,
    type: "bill",
    date: r.receivedOn,
    supplierId: r.supplierId,
    memo: `Goods received on ${r.poNumber ?? "a purchase order"} (Inventorify)`,
    // The reference must be unique per supplier: one PO can have several deliveries.
    data: { payable: a.payable, reference: `${r.poNumber ?? "PO"}-R${short(r.id)}`, dueDate: null, lines, inventorify: { receiptId: r.id, ledgerId: r.billLedgerEntryId, poId: r.poId } },
  };
}

/** A supplier-ledger entry. Receipt bills are skipped (the receipt posts them). */
export function planLedgerEntry(e: InvLedgerEntry, a: InvAccounts, o: { currency: string; decimals: number; startDate: string }): InvPlan {
  if (e.currency && e.currency !== o.currency) return { action: "skip", reason: `Ledger entry in ${e.currency}, your books are in ${o.currency}` };
  if (e.date < o.startDate) return { action: "skip", reason: "before the first day" };
  const kind = String(e.kind);
  if (kind === "reversal") {
    if (!e.reversalOf) return { action: "skip", reason: "reversal without the entry it undoes" };
    return { action: "reverse", ledgerId: e.reversalOf, date: e.date, memo: `Reversed in Inventorify${e.reference ? ` (${e.reference})` : ""}` };
  }
  const amount = decimalToMinorUnits(e.amount?.amount, o.decimals);
  if (amount === null || amount === 0n) return { action: "skip", reason: "no amount" };
  if (kind === "payment" || kind === "refund") {
    return { action: "payment", entry: { id: e.id, supplierId: e.supplierId, kind, date: e.date, amount: (amount < 0n ? -amount : amount).toString(), reference: e.reference } };
  }
  if (kind === "bill" && e.sourceKey?.startsWith("receipt:")) return { action: "skip", reason: "posted with its receipt" };

  const claim = !!e.claimId || !!e.sourceKey?.startsWith("claim:");
  const owesMore = amount > 0n;
  const abs = owesMore ? amount : -amount;
  const account = claim ? a.awaitingClaim : a.purchaseDiffs;
  const what =
    kind === "bill" ? (claim ? "Invoiced but not sent — awaiting claim" : "Supplier bill") : kind === "credit_note" ? (claim ? "Credit for a claim" : "Supplier credit") : "Adjustment";
  const line = { accountId: account, amount: abs.toString(), description: [what, e.reference].filter(Boolean).join(" · ") };
  // The reference must be unique per supplier, so it's Inventorify's id; the supplier's own reference is on the line.
  const base = { payable: a.payable, reference: `INV-${short(e.id)}`, lines: [line], inventorify: { ledgerId: e.id, claimId: e.claimId, poId: e.poId } };
  // Positive: the merchant owes more (a bill); negative: owes less (a supplier credit).
  return owesMore
    ? { action: "post", sourceRef: `ledger:${e.id}`, type: "bill", date: e.date, supplierId: e.supplierId, memo: `${what} (Inventorify)`, data: { ...base, dueDate: null } }
    : { action: "post", sourceRef: `ledger:${e.id}`, type: "supplier_credit", date: e.date, supplierId: e.supplierId, memo: `${what} (Inventorify)`, data: base };
}
