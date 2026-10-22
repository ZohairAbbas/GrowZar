/**
 * Recording by hand (B4), as pure rules: what a person types on a "Record"
 * form → the document data the posting engine stores (posting.ts). Amounts
 * arrive as typed ("1,250.50") and are stored in whole minor units; a tax
 * rate picked on a line becomes the line's tax, worked out and snapshotted
 * (name, rate, account) so changing the rate later never changes the entry.
 * Every mistake names its field, as the engine's do.
 */
import { parseAmount } from "../books/money";
import { taxOn, type TaxRateView } from "../books/tax";
import type { DocType } from "../books/posting";

/** The kinds of entry a person records by hand in version 1 (D-68, D-88), in the Record menu's order. */
export const RECORD_TYPES = [
  { type: "expense", label: "Record an expense", help: "Something you paid for: rent, packaging, salaries, ads paid by hand." },
  { type: "money_in", label: "Other money in", help: "Money that isn't a sale: interest, a refund from a supplier, scrap sold." },
  { type: "bill", label: "Add a bill", help: "What a supplier charged you, to pay later." },
  { type: "bill_payment", label: "Pay bills", help: "Paying one or more of a supplier's bills." },
  { type: "supplier_credit", label: "Supplier credit", help: "Money a supplier takes off what you owe them." },
  { type: "courier_payout", label: "Courier paid me", help: "A courier's payout you're recording by hand: what arrived and what they kept." },
  { type: "parcel_writeoff", label: "Write off parcels", help: "Cash-on-delivery parcels a courier will never pay for: lost, or paid short." },
  { type: "tax_payment", label: "Tax paid", help: "Paying the tax office what you owe, less what you can claim back." },
  { type: "transfer", label: "Move money", help: "From one of your accounts to another: bank to cash, a card paid off." },
  { type: "owner_in", label: "Owner put money in", help: "Money the owner added to the business." },
  { type: "owner_out", label: "Owner took money out", help: "Money the owner took for themselves." },
  { type: "manual", label: "Journal entry", help: "Debits and credits, for an accountant." },
] as const satisfies ReadonlyArray<{ type: DocType; label: string; help: string }>;

export type RecordType = (typeof RECORD_TYPES)[number]["type"];

export const isRecordType = (t: string): t is RecordType => RECORD_TYPES.some((r) => r.type === t);

/** A form error: the message and the field it belongs to (dotted path). */
export class RecordError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
  }
}

const AMOUNT_KEYS = new Set(["amount", "debit", "credit", "received"]);
/** Fields that may be negative (a courier's invoice, a carry-forward handed back). */
const SIGNED: Partial<Record<RecordType, Set<string>>> = { courier_payout: new Set(["received", "deductions"]) };

/** "1,250.50" → "125050"; empty → null. Throws a RecordError naming the field. */
export function toMinor(raw: unknown, decimals: number, field: string, signed = false): string | null {
  const s = String(raw ?? "").trim().replace(/,/g, "").replace(/^−/, "-");
  if (s === "") return null;
  const neg = s.startsWith("-");
  if (neg && !signed) throw new RecordError("Amounts can't be negative here", field);
  const v = parseAmount(neg ? s.slice(1) : s, decimals);
  if (v === null) throw new RecordError(`Enter an amount like 2500 or 2500.50`, field);
  return (neg ? -v : v).toString();
}

type Json = null | string | number | boolean | Json[] | { [k: string]: Json };

/**
 * Walk the typed data: amounts to minor units; a line's `taxRateId` to its tax;
 * `withheld.rateId` to the withholding account. The form drops rows nobody
 * filled in before sending (`isBlankRow`), so error paths match the screen.
 */
export function toDocData(type: RecordType, data: Record<string, Json>, decimals: number, rates: TaxRateView[]): Record<string, Json> {
  const rateById = new Map(rates.map((r) => [r.id, r]));
  const walk = (v: Json, path: string, signed: boolean): Json => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}.${i}`, signed));
    if (v && typeof v === "object") {
      const out: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        const s = signed || !!SIGNED[type]?.has(k);
        if (AMOUNT_KEYS.has(k)) {
          const m = toMinor(x, decimals, p, s);
          if (m !== null) out[k] = m;
        } else if (k !== "taxRateId") out[k] = walk(x, p, s);
      }
      return out;
    }
    return v;
  };
  const out = walk(data, "", false) as Record<string, Json>;

  // A line's tax, worked out on its amount before tax and snapshotted.
  if (Array.isArray(data.lines) && Array.isArray(out.lines)) {
    out.lines = (out.lines as Array<Record<string, Json>>).map((line, i) => {
      const src = (data.lines as Array<Record<string, Json>>)[i];
      const rateId = src && typeof src.taxRateId === "string" ? src.taxRateId : "";
      if (!rateId) return line;
      const rate = rateById.get(rateId);
      if (!rate) throw new RecordError("Choose a tax rate from the list", `lines.${i}.taxRateId`);
      const amount = typeof line.amount === "string" ? BigInt(line.amount) : 0n;
      return { ...line, tax: { rateId: rate.id, name: rate.name, rateBp: rate.rateBp, accountId: rate.accountId, amount: taxOn(amount, rate.rateBp).toString() } };
    });
  }

  // Tax withheld: the rate names the account; the amount is as typed, else worked out on the lines.
  const w = data.withheld as Record<string, Json> | null | undefined;
  if (w && typeof w === "object" && w.rateId) {
    const rate = rateById.get(String(w.rateId));
    if (!rate || rate.kind !== "withholding" || !rate.accountId) throw new RecordError("Choose a withholding rate", "withheld.rateId");
    const typed = toMinor(w.amount, decimals, "withheld.amount");
    const base = (Array.isArray(out.lines) ? (out.lines as Array<Record<string, Json>>) : []).reduce((s, l) => s + BigInt(String(l.amount ?? "0")), 0n);
    const amount = typed ?? taxOn(base, rate.rateBp).toString();
    out.withheld = amount === "0" ? null : { accountId: rate.accountId, amount, rateId: rate.id, name: rate.name, rateBp: rate.rateBp };
  } else if ("withheld" in out) {
    out.withheld = null;
  }
  return out;
}

/** A row nobody filled in: the form drops these before sending. */
export function isBlankRow(x: Record<string, unknown>): boolean {
  return Object.entries(x).every(([k, v]) => k === "key" || v === undefined || v === null || String(v).trim() === "");
}
