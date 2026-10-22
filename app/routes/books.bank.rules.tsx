import { Form, useNavigation } from "react-router";
import { Trash2 } from "lucide-react";

import type { Route } from "./+types/books.bank.rules";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { toMinor, RecordError } from "~/lib/books-app/record";
import { deleteBankRule, listBankRules, saveBankRule } from "~/lib/books/bank.server";
import { BooksError, listAccounts } from "~/lib/books/books.server";
import { isMoneySubtype } from "~/lib/books/chart";
import { formatAmount } from "~/lib/books/money";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Bank rules · Books · Growzar" }];
}

/**
 * Bank rules (B5): "a line that mentions these words is this". A rule
 * suggests how to record a statement line; nothing is recorded until you
 * accept it. Rules are also made by ticking "Remember" when recording a line.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { book, canManage } = await requireBook(request, "view");
  const [rules, accounts] = await Promise.all([listBankRules(book), listAccounts(book)]);
  const live = accounts.filter((a) => !a.archived && !a.currency);
  const fmt = (v: bigint | null) => (v === null ? null : formatAmount(v, book.decimals));
  return {
    canManage,
    rules: rules.map((r) => ({ id: r.id, contains: r.contains, direction: r.direction, label: r.accountName, contact: r.contactName, min: fmt(r.minAmount), max: fmt(r.maxAmount), archived: r.archived })),
    accounts: live.map((a) => ({ id: a.id, name: `${a.code} · ${a.name}`, type: a.type, money: isMoneySubtype(a.subtype) })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    if (str("intent") === "delete") {
      await deleteBankRule(book, str("id"));
      return { ok: "Rule removed." };
    }
    await saveBankRule(
      book,
      { contains: str("contains"), direction: str("direction"), kind: str("kind"), accountId: str("accountId"), minAmount: toMinor(str("min"), book.decimals, "minAmount"), maxAmount: toMinor(str("max"), book.decimals, "maxAmount") },
      viewer.userId,
    );
    return { ok: "Rule saved." };
  } catch (e) {
    if (e instanceof BooksError || e instanceof RecordError) return { error: e.message };
    throw e;
  }
}

export default function BankRules({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      <Card title="Bank rules">
        {d.rules.length === 0 ? <p className="text-sm text-gray-500">No rules yet. Tick "Remember" when you record a statement line, or add one below.</p> : null}
        <ul className="divide-y divide-gray-100">
          {d.rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="flex-1 text-gray-800">
                Money {r.direction} mentioning <strong>“{r.contains}”</strong>
                {r.min || r.max ? <span className="text-gray-500"> ({r.min ?? "any"} to {r.max ?? "any"})</span> : null} → {r.label}
                {r.contact ? <span className="text-gray-500"> · {r.contact}</span> : null}
                {r.archived ? <span className="ml-1.5 text-xs text-coral-700">uses an archived account</span> : null}
              </span>
              {d.canManage ? (
                <Form method="post">
                  <input type="hidden" name="id" value={r.id} />
                  <button type="submit" name="intent" value="delete" aria-label={`Remove the rule for ${r.contains}`} className={quietButtonClass} disabled={busy}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Form>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {d.canManage ? (
        <Card title="Add a rule">
          <Form method="post" className="grid gap-4 md:grid-cols-3">
            <input type="hidden" name="intent" value="save" />
            <Field label="Lines mentioning" htmlFor="contains">
              <input id="contains" name="contains" required className={inputClass} placeholder="K-ELECTRIC" />
            </Field>
            <Field label="Money" htmlFor="direction">
              <select id="direction" name="direction" className={inputClass}>
                <option value="out">going out</option>
                <option value="in">coming in</option>
              </select>
            </Field>
            <Field label="Is" htmlFor="kind">
              <select id="kind" name="kind" className={inputClass}>
                <option value="account">Recorded to an account</option>
                <option value="transfer">A move between your own accounts</option>
              </select>
            </Field>
            <Field label="Account" htmlFor="accountId">
              <select id="accountId" name="accountId" required className={inputClass}>
                <option value="">Choose…</option>
                {d.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From amount (optional)" htmlFor="min">
              <input id="min" name="min" inputMode="decimal" className={inputClass} />
            </Field>
            <Field label="To amount (optional)" htmlFor="max">
              <input id="max" name="max" inputMode="decimal" className={inputClass} />
            </Field>
            <div>
              <button type="submit" className={buttonClass} disabled={busy}>
                Save rule
              </button>
            </div>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}
