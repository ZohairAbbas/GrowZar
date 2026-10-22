/**
 * Tax rates (Settings → Taxes) and the tax summary report.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "~/lib/db.server";
import { BooksError, addDays, isIsoDate } from "./posting";
import { ledgerSums, reportAccounts, toDbDate, type BookView } from "./books.server";
import { MAX_RATE_BP, TAX_KINDS, type TaxKind, type TaxRateView } from "./tax";
import { naturalBalance } from "./chart";

function view(r: { id: string; name: string; kind: string; rateBp: number; accountId: string | null; archivedAt: Date | null }): TaxRateView {
  return { id: r.id, name: r.name, kind: r.kind as TaxKind, rateBp: r.rateBp, accountId: r.accountId, archived: !!r.archivedAt };
}

export async function listTaxRates(book: BookView, opts: { includeArchived?: boolean } = {}): Promise<TaxRateView[]> {
  const rows = await prisma.bkTaxRate.findMany({ where: { bookId: book.id, ...(opts.includeArchived ? {} : { archivedAt: null }) }, orderBy: [{ kind: "asc" }, { rateBp: "desc" }, { name: "asc" }] });
  return rows.map(view);
}

export interface TaxRateInput {
  id?: string | null;
  name: string;
  kind: string;
  rateBp: number;
  accountId: string | null;
}

/** Create or change a rate. Entries already made keep the rate they were made with. */
export async function saveTaxRate(book: BookView, input: TaxRateInput, actor: string | null): Promise<TaxRateView> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw new BooksError("Give the rate a name", "name");
  if (name.length > 100) throw new BooksError("That name is too long", "name");
  if (!(TAX_KINDS as readonly string[]).includes(input.kind)) throw new BooksError("Choose what kind of tax this is", "kind");
  const kind = input.kind as TaxKind;
  if (!Number.isInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > MAX_RATE_BP) throw new BooksError("Enter a rate like 18 or 4.5", "rateBp");
  const accountId = input.accountId || null;
  if (accountId) {
    const a = await prisma.bkAccount.findFirst({ where: { id: accountId, bookId: book.id } });
    if (!a) throw new BooksError("Choose an account", "accountId");
    if (a.archivedAt) throw new BooksError(`"${a.name}" is archived`, "accountId");
    const want = kind === "purchase" ? "asset" : "liability";
    if (!(a.type === want && a.subtype === "tax")) {
      throw new BooksError(kind === "purchase" ? `"${a.name}" isn't a tax account you can claim from` : `"${a.name}" isn't a tax account you owe`, "accountId");
    }
  } else if (kind !== "purchase") {
    throw new BooksError("Choose the account this tax is owed in", "accountId");
  }

  return prisma.$transaction(async (tx) => {
    const clash = await tx.bkTaxRate.findFirst({ where: { bookId: book.id, name: { equals: name, mode: "insensitive" }, ...(input.id ? { NOT: { id: input.id } } : {}) } });
    if (clash) throw new BooksError(`There's already a rate called "${clash.name}"`, "name");
    if (input.id) {
      const cur = await tx.bkTaxRate.findFirst({ where: { id: input.id, bookId: book.id } });
      if (!cur) throw new BooksError("Rate not found");
      const r = await tx.bkTaxRate.update({ where: { id: cur.id }, data: { name, kind, rateBp: input.rateBp, accountId } });
      await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "tax_rate.updated", detail: { taxRateId: r.id, name, before: { name: cur.name, rateBp: cur.rateBp, accountId: cur.accountId }, after: { rateBp: r.rateBp, accountId } } as Prisma.InputJsonValue } });
      return view(r);
    }
    const r = await tx.bkTaxRate.create({ data: { bookId: book.id, name, kind, rateBp: input.rateBp, accountId } });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: "tax_rate.created", detail: { taxRateId: r.id, name, kind, rateBp: r.rateBp } as Prisma.InputJsonValue } });
    return view(r);
  }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new BooksError(`There's already a rate called "${name}"`, "name");
    throw e;
  });
}

export async function setTaxRateArchived(book: BookView, id: string, archived: boolean, actor: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const r = await tx.bkTaxRate.findFirst({ where: { id, bookId: book.id } });
    if (!r) throw new BooksError("Rate not found");
    await tx.bkTaxRate.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
    await tx.bkAuditEvent.create({ data: { bookId: book.id, actor, action: archived ? "tax_rate.archived" : "tax_rate.restored", detail: { taxRateId: id, name: r.name } } });
  });
}

// ── Tax summary ──────────────────────────────────────────────────────────────

/** Which kind of entry moved a tax account, in words. */
const SOURCE_LABELS: Record<string, string> = {
  sales_summary: "Sales",
  money_in: "Money in",
  invoice: "Invoices",
  credit_note: "Credit notes",
  customer_payment: "Customer payments",
  expense: "Expenses",
  bill: "Bills",
  bill_payment: "Bill payments",
  ad_spend: "Ad spend",
  courier_payout: "Courier payouts",
  gateway_payout: "Gateway payouts",
  tax_payment: "Tax paid or refunded",
  opening: "Opening balances",
  manual: "Manual entries",
};

export interface TaxAccountSummary {
  accountId: string;
  code: string;
  name: string;
  /** "owed": tax you owe (liability); "claimable": tax you can claim (asset). */
  side: "owed" | "claimable";
  /** Natural amounts: positive = more owed (or more claimable). */
  start: bigint;
  movements: Array<{ source: string; label: string; amount: bigint }>;
  end: bigint;
}

export interface RateBase {
  name: string;
  rateBp: number | null;
  kind: "sales" | "purchase" | "withholding";
  /** Before-tax amount the tax was worked out on (for withholding: the payment). */
  base: bigint;
  tax: bigint;
}

/**
 * Every tax account's movement in a period, by what moved it (from the
 * ledger, so it includes Shopify sales tax, ad taxes and anything entered by
 * hand), plus taxable amounts per rate from entries made with a rate.
 */
export async function taxSummary(book: BookView, from: string, to: string) {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new BooksError("Choose dates");
  const accounts = (await reportAccounts(book)).filter((a) => a.subtype === "tax" && (a.type === "asset" || a.type === "liability"));
  const ids = accounts.map((a) => a.id);
  const [before, rows, docs] = await Promise.all([
    ledgerSums(book.id, { to: addDays(from, -1) }),
    ids.length
      ? prisma.$queryRaw<Array<{ accountId: string; type: string; amount: bigint }>>`
          SELECT l."accountId", d.type, SUM(l.amount)::bigint AS amount
            FROM bk_entry_lines l
            JOIN bk_entries e ON e.id = l."entryId"
            JOIN bk_documents d ON d.id = e."documentId"
           WHERE l."bookId" = ${book.id} AND l."accountId" = ANY(${ids})
             AND l.date >= ${toDbDate(from)} AND l.date <= ${toDbDate(to)}
           GROUP BY l."accountId", d.type`
      : Promise.resolve([]),
    prisma.bkDocument.findMany({
      where: { bookId: book.id, status: "posted", type: { in: ["expense", "bill", "money_in", "bill_payment", "invoice", "credit_note", "customer_payment"] }, date: { gte: toDbDate(from), lte: toDbDate(to) } },
      select: { type: true, data: true },
    }),
  ]);

  const summaries: TaxAccountSummary[] = accounts
    .map((a) => {
      const side = a.type === "liability" ? ("owed" as const) : ("claimable" as const);
      const nat = (v: bigint) => naturalBalance(a.type, v);
      const movements = rows
        .filter((r) => r.accountId === a.id && r.amount !== 0n)
        .map((r) => ({ source: r.type, label: SOURCE_LABELS[r.type] ?? r.type, amount: nat(r.amount) }))
        .sort((x, y) => x.label.localeCompare(y.label));
      const start = nat(before.get(a.id) ?? 0n);
      const end = start + movements.reduce((s, m) => s + m.amount, 0n);
      return { accountId: a.id, code: a.code, name: a.name, side, start, movements, end };
    })
    .filter((s) => s.start !== 0n || s.end !== 0n || s.movements.length > 0)
    .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));

  // Taxable amounts per rate, from entries made with a rate.
  const bases = new Map<string, RateBase>();
  const add = (kind: RateBase["kind"], name: string | null | undefined, rateBp: number | null | undefined, base: bigint, tax: bigint) => {
    const key = `${kind}|${name ?? ""}|${rateBp ?? ""}`;
    const b = bases.get(key) ?? { name: name || "Tax", rateBp: rateBp ?? null, kind, base: 0n, tax: 0n };
    b.base += base;
    b.tax += tax;
    bases.set(key, b);
  };
  const big = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : 0n);
  for (const d of docs) {
    const data = (d.data ?? {}) as { lines?: Array<{ amount?: string; tax?: { name?: string; rateBp?: number; amount?: string } | null }>; withheld?: { name?: string; rateBp?: number; amount?: string } | null; allocations?: Array<{ amount?: string }> };
    const selling = d.type === "money_in" || d.type === "invoice" || d.type === "credit_note";
    // A credit note gives sales tax back: it reduces the taxable amount and the tax.
    const sign = d.type === "credit_note" ? -1n : 1n;
    for (const l of data.lines ?? []) {
      if (l.tax && big(l.tax.amount) > 0n) add(selling ? "sales" : "purchase", l.tax.name, l.tax.rateBp, sign * big(l.amount), sign * big(l.tax.amount));
    }
    if (data.withheld && big(data.withheld.amount) > 0n) {
      const settled = d.type === "bill_payment" || d.type === "customer_payment";
      const paid = settled ? (data.allocations ?? []).reduce((s, a) => s + big(a.amount), 0n) : (data.lines ?? []).reduce((s, l) => s + big(l.amount) + (l.tax ? big(l.tax.amount) : 0n), 0n);
      add("withholding", d.type === "customer_payment" ? `${data.withheld.name || "Tax withheld"} (by customers)` : data.withheld.name, data.withheld.rateBp, paid, big(data.withheld.amount));
    }
  }
  const owed = summaries.filter((s) => s.side === "owed").reduce((x, s) => x + s.end, 0n);
  const claimable = summaries.filter((s) => s.side === "claimable").reduce((x, s) => x + s.end, 0n);
  return { from, to, accounts: summaries, rates: [...bases.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), owed, claimable, net: owed - claimable };
}

/** Tax account balances on a date, for the "Pay tax" form. */
export async function taxBalances(book: BookView, asOf: string) {
  const accounts = (await reportAccounts(book)).filter((a) => !a.archived && a.subtype === "tax" && (a.type === "asset" || a.type === "liability"));
  const sums = await ledgerSums(book.id, { to: asOf });
  return accounts.map((a) => ({ accountId: a.id, name: a.name, side: a.type === "liability" ? "owed" : "claimable", balance: naturalBalance(a.type, sums.get(a.id) ?? 0n) }));
}

