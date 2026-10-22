/**
 * Cash basis: income when the money arrives, costs when they're paid.
 *
 * Only entries that move a money account (bank, cash, wallets, ad wallets,
 * cards — a card charge counts as paid, as in most accounting software) are
 * looked at. Inside such an entry, each other line counts as follows:
 *   income or expense            as it is
 *   stock                        "Stock paid for" (a cost when paid, not when sold)
 *   owed by / owed to, settling  spread over the lines of the invoices or bills
 *   invoices or bills            it pays, in proportion (tax on them stays out)
 *   owed by couriers / gateways  "Collected from couriers and gateways"
 *   owed, not matched to a bill  "Received from customers" / "Paid to suppliers"
 *   anything else                not profit (tax, loans, owner money, things you own)
 * Opening balances never count.
 */

export interface CashAccount {
  type: string;
  subtype: string;
  systemKey: string | null;
}

export interface CashLine {
  accountId: string;
  amount: bigint;
}

export interface CashEntry {
  documentId: string;
  docType: string;
  lines: CashLine[];
}

export const CASH_ROWS = {
  collected: { id: "cash:collected", name: "Collected from couriers and gateways", type: "income", subtype: "sales" },
  customers: { id: "cash:customers", name: "Received from customers (not matched to an invoice)", type: "income", subtype: "sales" },
  stock: { id: "cash:stock", name: "Stock paid for", type: "expense", subtype: "cost_of_sales" },
  suppliers: { id: "cash:suppliers", name: "Paid to suppliers (not matched to a bill)", type: "expense", subtype: "operating" },
} as const;

const MONEY = new Set(["bank", "cash", "mobile_wallet", "ad_wallet", "card"]);
export const isMoneyAccount = (a: CashAccount | undefined) => !!a && MONEY.has(a.subtype);
const isPnl = (a: CashAccount) => a.type === "income" || a.type === "expense";
const isStock = (a: CashAccount) => a.type === "asset" && (a.subtype === "stock" || a.systemKey === "stock");

/** Split `total` in proportion to `weights` (same sign rules as BigInt), exactly: the rest goes to the largest weight. */
export function distribute(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n || weights.length === 0) return weights.map(() => 0n);
  const out = weights.map((w) => (total * w) / sum);
  const rest = total - out.reduce((a, b) => a + b, 0n);
  if (rest !== 0n) {
    let big = 0;
    for (let i = 1; i < weights.length; i++) if ((weights[i]! < 0n ? -weights[i]! : weights[i]!) > (weights[big]! < 0n ? -weights[big]! : weights[big]!)) big = i;
    out[big]! += rest;
  }
  return out;
}

export function cashMovements(input: {
  entries: CashEntry[];
  accounts: Map<string, CashAccount>;
  /** Payment document → the invoices/bills it settles, with amounts. */
  allocations: Map<string, Array<{ targetId: string; amount: bigint }>>;
  /** Invoice/bill document → its net ledger lines. */
  targets: Map<string, CashLine[]>;
}): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (id: string, v: bigint) => v !== 0n && out.set(id, (out.get(id) ?? 0n) + v);
  for (const e of input.entries) {
    if (e.docType === "opening") continue;
    const acc = (id: string) => input.accounts.get(id);
    if (!e.lines.some((l) => isMoneyAccount(acc(l.accountId)))) continue;
    // Settlement lines of this entry, per control account, share the document's allocations.
    const settling = e.lines.filter((l) => {
      const a = acc(l.accountId);
      return a && !isMoneyAccount(a) && (a.subtype === "receivable" || a.subtype === "payable");
    });
    // A fresh copy per entry: a cancelled payment's reversal spreads the same way and nets out.
    const allocs = (input.allocations.get(e.documentId) ?? []).map((x) => ({ ...x }));
    for (const l of e.lines) {
      const a = acc(l.accountId);
      if (!a || isMoneyAccount(a)) continue;
      if (isPnl(a)) {
        add(l.accountId, l.amount);
        continue;
      }
      if (isStock(a)) {
        add(CASH_ROWS.stock.id, l.amount);
        continue;
      }
      if (!settling.includes(l)) continue; // tax, loans, owner money, things you own
      // Spread over the invoices/bills this payment settles on this account.
      let left = l.amount;
      for (const al of allocs) {
        if (left === 0n) break;
        const target = input.targets.get(al.targetId) ?? [];
        const control = target.filter((t) => t.accountId === l.accountId).reduce((s, t) => s + t.amount, 0n);
        if (control === 0n || al.amount <= 0n) continue;
        const absLeft = left < 0n ? -left : left;
        const take = al.amount > absLeft ? absLeft : al.amount;
        const portion = left < 0n ? -take : take;
        left -= portion;
        al.amount -= take;
        // Each of the invoice's/bill's other lines gets portion × line ÷ (its lines' total).
        const parts = target.filter((t) => t.accountId !== l.accountId);
        const shares = distribute(portion, parts.map((t) => t.amount));
        parts.forEach((t, i) => {
          const ta = acc(t.accountId);
          if (!ta || isMoneyAccount(ta)) return;
          if (isPnl(ta)) add(t.accountId, shares[i]!);
          else if (isStock(ta)) add(CASH_ROWS.stock.id, shares[i]!);
          // An opening bill or invoice (from before Books): what it was for isn't known, but the cash moved now.
          else if (ta.systemKey === "opening_balance") add(a.subtype === "receivable" ? CASH_ROWS.customers.id : CASH_ROWS.suppliers.id, shares[i]!);
          // tax on the invoice/bill isn't profit
        });
      }
      if (left !== 0n) {
        const row = a.subtype === "receivable" ? (a.systemKey === "receivables" ? CASH_ROWS.customers.id : CASH_ROWS.collected.id) : CASH_ROWS.suppliers.id;
        add(row, left);
      }
    }
  }
  return out;
}
