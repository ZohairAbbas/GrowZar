import { Link } from "react-router";

import type { Route } from "./+types/books._index";
import { prisma } from "~/lib/db.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { COD_BASES } from "~/lib/books-app/setup";
import { countDrafts, listAccounts } from "~/lib/books/books.server";
import { isMoneySubtype } from "~/lib/books/chart";
import { MONTH_NAMES, todayIn } from "~/lib/books/dates";
import { formatRate } from "~/lib/books/tax";
import { listTaxRates } from "~/lib/books/taxes.server";
import { Card, Money } from "~/components/books/BooksUi";

/**
 * Books' overview (B2): where money is, what the books cover, and whether the
 * ledger adds up. The daily entries arrive with the connectors (B3).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const today = todayIn(book.settings.timeZone);
  const [accounts, rates, drafts, stores] = await Promise.all([
    listAccounts(book, { asOf: today }),
    listTaxRates(book),
    countDrafts(book),
    prisma.store.findMany({ where: { id: { in: book.settings.storeIds ?? [] }, organizationId: viewer.organizationId }, select: { id: true, shopDomain: true, displayName: true } }),
  ]);
  const total = accounts.reduce((s, a) => s + a.balance, 0n);
  return {
    money: accounts.filter((a) => isMoneySubtype(a.subtype)).map((a) => ({ id: a.id, name: a.name, balance: money(book, a.type === "liability" ? -a.balance : a.balance, accountant), card: a.type === "liability" })),
    // Every entry balances in the database; this shows the whole ledger does too.
    ledgerBalances: total === 0n,
    rates: rates.filter((r) => !r.archived).map((r) => ({ id: r.id, name: r.name, rate: formatRate(r.rateBp) })),
    drafts,
    stores: stores.map((s) => s.displayName ?? s.shopDomain),
    codBasis: COD_BASES.find((b) => b.value === (book.settings.codBasis ?? "delivery"))?.label ?? "",
    year: `${MONTH_NAMES[book.fiscalYearStartMonth - 1]} to ${MONTH_NAMES[(book.fiscalYearStartMonth + 10) % 12]}`,
    timeZone: book.settings.timeZone ?? "",
  };
}

export default function BooksOverview({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Your money" aside={<Link to="/books/accounts" className="text-sm font-semibold text-accent-600">All accounts</Link>}>
        <ul className="divide-y divide-gray-100">
          {d.money.map((m) => (
            <li key={m.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
              <span className="text-gray-800">
                {m.name}
                {m.card ? <span className="ml-1.5 text-xs text-gray-500">owed on the card</span> : null}
              </span>
              <Money value={m.balance} className="font-semibold" />
            </li>
          ))}
        </ul>
        <p className={`rounded-xl px-3 py-2 text-xs ${d.ledgerBalances ? "bg-mint-50 text-mint-700" : "bg-coral-50 text-coral-700"}`}>
          {d.ledgerBalances ? "Everything in the books adds up: every debit has its credit." : "The books don't add up. This shouldn't happen; tell Growzar support."}
        </p>
      </Card>

      <Card title="What these books cover" aside={<Link to="/books/sources" className="text-sm font-semibold text-accent-600">Where entries come from</Link>}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-gray-500">Stores</dt>
          <dd className="text-gray-800">{d.stores.join(", ") || "None"}</dd>
          <dt className="text-gray-500">Year</dt>
          <dd className="text-gray-800">{d.year}</dd>
          <dt className="text-gray-500">Time zone</dt>
          <dd className="text-gray-800">{d.timeZone}</dd>
          <dt className="text-gray-500">COD sales count</dt>
          <dd className="text-gray-800">{d.codBasis}</dd>
          <dt className="text-gray-500">Tax rates</dt>
          <dd className="text-gray-800">{d.rates.length ? d.rates.map((r) => `${r.name} (${r.rate})`).join(", ") : "None yet"}</dd>
        </dl>
      </Card>

      <Card title="What happens next">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-700">
          <li>
            <Link to="/books/opening" className="font-semibold text-accent-600">Add what you had on the start day</Link>: stock, what couriers owed you, what you owed suppliers.
          </li>
          <li>Sales, courier payouts, ad spend and goods received will start arriving each day from your apps.</li>
          {d.drafts ? <li>{d.drafts} entr{d.drafts === 1 ? "y is" : "ies are"} waiting as drafts.</li> : null}
        </ul>
      </Card>
    </div>
  );
}
