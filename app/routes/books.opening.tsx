import { useState } from "react";
import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/books.opening";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money, typeLabel } from "~/lib/books-app/format";
import { BooksError, cancelDocument, listAccounts, saveAndPost } from "~/lib/books/books.server";
import { isMoneySubtype, type AccountType } from "~/lib/books/chart";
import { formatDate, todayIn } from "~/lib/books/dates";
import { parseAmount } from "~/lib/books/money";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, Money, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Opening balances · Books · Growzar" }];
}

/**
 * Opening balances (B2, D-75): what the organization had and owed on the day
 * its books start, beyond the money accounts setup already took: stock, what
 * couriers owed, what was owed to suppliers, loans, tax. Each save posts an
 * "Opening balances" entry on the start day; the difference goes to "Opening
 * balance adjustment", the owner's money. A mistake is put right by
 * cancelling the entry (a mirror entry) and saving it again.
 */
const HELP: Record<string, string> = {
  "Owed by couriers": "Cash on delivery couriers had collected or were carrying for you, not yet paid out.",
  "Owed by payment gateways": "Card and wallet payments not yet in your bank.",
  Stock: "What your stock cost you, not what it sells for.",
  "Owed to suppliers": "Bills you hadn't paid yet.",
  "Sales tax to pay": "Tax you'd collected and not yet paid to the tax office.",
};

export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const asOf = book.settings.startDate ?? todayIn(book.settings.timeZone);
  const [accounts, entries] = await Promise.all([
    listAccounts(book),
    prisma.bkDocument.findMany({ where: { bookId: book.id, type: "opening", status: "posted" }, orderBy: { postedAt: "asc" }, select: { id: true, number: true, date: true, total: true, memo: true } }),
  ]);
  const eligible = accounts.filter((a) => (a.type === "asset" || a.type === "liability" || a.type === "equity") && !isMoneySubtype(a.subtype) && a.systemKey !== "opening_balance");
  return {
    welcome: url.searchParams.get("welcome") === "1",
    done: url.searchParams.get("done"),
    canManage,
    asOf,
    asOfLabel: formatDate(asOf),
    currency: book.currency,
    groups: (["asset", "liability", "equity"] as AccountType[]).map((type) => ({
      type,
      label: typeLabel(type, accountant),
      accounts: eligible.filter((a) => a.type === type).map((a) => ({ id: a.id, name: a.name, help: HELP[a.name] ?? null, balance: money(book, type === "asset" ? a.balance : -a.balance, accountant) })),
    })),
    entries: entries.map((e) => ({ id: e.id, number: e.number, date: formatDate(e.date.toISOString().slice(0, 10)), total: money(book, e.total, accountant), memo: e.memo })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "cancel") {
      await cancelDocument(book, String(form.get("id") ?? ""), String(form.get("reason") ?? ""), viewer.userId);
      throw redirect("/books/opening?done=cancelled");
    }
    if (intent !== "save") return { error: "Nothing to do.", field: "" };
    const lines: Array<{ accountId: string; amount: string }> = [];
    for (const [key, value] of form.entries()) {
      if (!key.startsWith("amount:")) continue;
      const raw = String(value).trim().replace(/,/g, "");
      if (!raw) continue;
      const neg = /^[-−]/.test(raw);
      const v = parseAmount(neg ? raw.slice(1) : raw, book.decimals);
      if (v === null) return { error: "Enter amounts like 25000 or 25000.50", field: key };
      if (v !== 0n) lines.push({ accountId: key.slice("amount:".length), amount: String(neg ? -v : v) });
    }
    if (lines.length === 0) return { error: "Enter at least one balance.", field: "" };
    const date = book.settings.startDate ?? todayIn(book.settings.timeZone);
    const r = await saveAndPost(
      book,
      { type: "opening", date, memo: "What you had and owed when your books started", data: { lines }, clientKey: String(form.get("clientKey") ?? "") || null },
      viewer.userId,
    );
    if (r.error) return { error: r.error.message, field: r.error.field ?? "" };
    // A fresh page after a save: empty fields and a new form key.
    throw redirect(`/books/opening?done=${encodeURIComponent(r.doc.number ?? "saved")}`);
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

const newKey = () => `opn-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export default function OpeningBalances({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  // One key per form shown, so a double click records one entry.
  const [clientKey] = useState(newKey);
  const fieldErr = (id: string) => (actionData && "error" in actionData && actionData.field === `amount:${id}` ? actionData.error : null);

  return (
    <div className="space-y-5">
      {d.welcome ? <Notice>Your books are set up. Now add anything else you had or owed on {d.asOfLabel}; leave out what you don't know yet.</Notice> : null}
      {d.done ? <Notice>{d.done === "cancelled" ? "Cancelled. Enter the right balances and save them again." : `Saved as ${d.done}.`}</Notice> : null}
      {actionData && "error" in actionData && !actionData.field.startsWith("amount:") ? <Notice tone="warn">{actionData.error}</Notice> : null}

      {d.entries.length ? (
        <Card title="Saved opening balances">
          <ul className="divide-y divide-gray-100">
            {d.entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="w-24 font-semibold text-gray-900">{e.number}</span>
                <span className="flex-1 text-gray-600">{e.date}</span>
                <Money value={e.total} />
                {d.canManage ? (
                  <details className="w-full md:w-auto">
                    <summary className={`${quietButtonClass} cursor-pointer list-none`}>Cancel</summary>
                    <Form method="post" className="mt-2 flex gap-2">
                      <input type="hidden" name="intent" value="cancel" />
                      <input type="hidden" name="id" value={e.id} />
                      <input name="reason" required placeholder="Why (kept in the activity log)" className={inputClass} />
                      <button type="submit" className={buttonClass} disabled={busy}>
                        Cancel it
                      </button>
                    </Form>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {d.canManage ? (
        <Form method="post" className="space-y-5">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="clientKey" value={clientKey} />
          {d.groups.map((g) => (
            <Card key={g.type} title={`${g.label} on ${d.asOfLabel}`}>
              <div className="grid gap-4 md:grid-cols-2">
                {g.accounts.map((a) => (
                  <Field key={a.id} label={a.name} htmlFor={`amount:${a.id}`} error={fieldErr(a.id)} help={a.help ?? (a.balance !== "0.00" ? `In the books now: ${a.balance}` : undefined)}>
                    <input id={`amount:${a.id}`} name={`amount:${a.id}`} inputMode="decimal" placeholder={`0 ${d.currency}`} className={inputClass} />
                  </Field>
                ))}
              </div>
            </Card>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={buttonClass} disabled={busy}>
              Save opening balances
            </button>
            <p className="text-sm text-gray-500">Whatever doesn't balance goes to "Opening balance adjustment", part of the owner's money.</p>
          </div>
        </Form>
      ) : null}
    </div>
  );
}
