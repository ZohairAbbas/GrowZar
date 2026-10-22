import { Link } from "react-router";
import { Upload } from "lucide-react";

import type { Route } from "./+types/books.bank._index";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { bankOverview } from "~/lib/books/bank.server";
import { formatDate } from "~/lib/books/dates";
import { Card, Money } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Bank · Books · Growzar" }];
}

/**
 * Banking (B5): each place money is kept, what's waiting to be matched from
 * its statements, and how far it's reconciled. Statements are read in your
 * browser and their files are never kept (D-72).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const rows = await bankOverview(book);
  return {
    canManage,
    accounts: rows.map((a) => ({
      id: a.id,
      name: a.name,
      balance: money(book, a.balance, accountant),
      toReview: a.toReview,
      lastStatement: a.lastStatementDate ? `${formatDate(a.lastStatementDate)}${a.lastStatementBalance !== null ? `, ${money(book, a.lastStatementBalance, accountant)}` : ""}` : null,
      reconciled: a.reconciledThrough ? formatDate(a.reconciledThrough) : null,
      reconciling: !!a.openReconciliationId,
      foreign: !!a.currency,
    })),
  };
}

export default function Bank({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <Card
        title="Bank and cash"
        aside={
          d.canManage ? (
            <span className="flex gap-3 text-sm font-semibold">
              <Link to="/books/bank/rules" className="text-accent-600">
                Rules
              </Link>
              <Link to="/books/bank/import" className="inline-flex items-center gap-1.5 rounded-full bg-navy px-4 py-1.5 text-white hover:bg-navy-surface">
                <Upload className="h-3.5 w-3.5" /> Import a statement
              </Link>
            </span>
          ) : null
        }
      >
        <p className="text-sm text-gray-600">
          Import a statement, then match each line with what's already in your books: courier payouts, expenses, bills. Statements are read in your browser; account and card numbers are hidden before anything is sent, and the file itself is never kept.
        </p>
        <ul className="divide-y divide-gray-100">
          {d.accounts.map((a) => (
            <li key={a.id}>
              <Link to={`/books/bank/${a.id}`} className="grid gap-1 py-3 text-sm hover:bg-field md:grid-cols-[1fr_150px_1fr_160px]">
                <span className="font-semibold text-gray-900">{a.name}</span>
                <Money value={a.balance} className="md:text-right" />
                <span className="text-gray-600 md:pl-6">{a.toReview ? `${a.toReview} line${a.toReview === 1 ? "" : "s"} to match` : a.lastStatement ? `Statement to ${a.lastStatement}` : "No statement yet"}</span>
                <span className="text-gray-500">{a.reconciling ? "Reconciling…" : a.reconciled ? `Reconciled to ${a.reconciled}` : "Not reconciled"}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
