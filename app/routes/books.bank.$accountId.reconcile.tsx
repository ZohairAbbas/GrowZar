import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/books.bank.$accountId.reconcile";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { discardReconciliation, finishReconciliation, reconciliationView, setCleared, startReconciliation, undoLastReconciliation } from "~/lib/books/bank.server";
import { BooksError } from "~/lib/books/books.server";
import { formatDate, todayIn } from "~/lib/books/dates";
import { parseAmount } from "~/lib/books/money";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, Money, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Reconcile · Books · Growzar" }];
}

/**
 * Reconciling an account to its statement (B5): the statement's end date and
 * balance, then tick what the statement shows until the difference is zero.
 * Lines already matched to the statement start ticked. Only later dates can
 * be reconciled; the last one can be undone with a reason.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const [account, open, last] = await Promise.all([
    prisma.bkAccount.findFirst({ where: { id: params.accountId, bookId: book.id }, select: { id: true, name: true } }),
    prisma.bkReconciliation.findFirst({ where: { bookId: book.id, accountId: params.accountId, status: "open" } }),
    prisma.bkReconciliation.findFirst({ where: { bookId: book.id, accountId: params.accountId, status: "done" }, orderBy: { statementDate: "desc" } }),
  ]);
  if (!account) throw new Response("Not found", { status: 404 });
  const m = (v: bigint) => money(book, v, accountant);
  const view = open ? await reconciliationView(book, open.id) : null;
  return {
    canManage,
    account,
    today: todayIn(book.settings.timeZone),
    last: last ? formatDate(last.statementDate.toISOString().slice(0, 10)) : null,
    rec: view
      ? {
          id: view.id,
          statementDate: formatDate(view.statementDate),
          statementBalance: m(view.statementBalance),
          previous: m(view.previous),
          cleared: m(view.cleared),
          difference: m(view.difference),
          zero: view.difference === 0n,
          truncated: view.truncated,
          lines: view.lines.map((l) => ({ id: l.id, date: formatDate(l.date), amount: m(l.amount), label: [l.number, l.kind, l.contactName, l.memo].filter(Boolean).join(" · "), ticked: l.ticked, matched: l.matched })),
        }
      : null,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    switch (str("intent")) {
      case "start": {
        const raw = str("balance").replace(/,/g, "").trim();
        const neg = raw.startsWith("-");
        const v = parseAmount(neg ? raw.slice(1) : raw, book.decimals);
        if (v === null) return { error: "Enter the statement's closing balance, like 125000.50" };
        await startReconciliation(book, params.accountId, str("date"), neg ? -v : v, viewer.userId);
        return { ok: "Started. Tick what the statement shows." };
      }
      case "tick":
        await setCleared(book, str("recId"), form.getAll("on").map(String), true);
        await setCleared(book, str("recId"), form.getAll("off").map(String), false);
        return { ok: "Saved." };
      case "finish":
        await finishReconciliation(book, str("recId"), viewer.userId);
        return { ok: "Reconciled." };
      case "discard":
        await discardReconciliation(book, str("recId"));
        return { ok: "Discarded." };
      case "undo":
        await undoLastReconciliation(book, params.accountId, str("reason"), viewer.userId);
        return { ok: "The last reconciliation is undone." };
      default:
        return { error: "Nothing to do." };
    }
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message };
    throw e;
  }
}

export default function Reconcile({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [ticked, setTicked] = useState<Record<string, boolean>>(() => Object.fromEntries((d.rec?.lines ?? []).map((l) => [l.id, l.ticked])));
  const r = d.rec;
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-bold text-gray-900">Reconcile {d.account.name}</h2>
        <Link to={`/books/bank/${d.account.id}`} className="text-sm font-semibold text-accent-600">
          Back to the statement
        </Link>
      </div>

      {!r && d.canManage ? (
        <Card title="Start">
          <p className="text-sm text-gray-600">{d.last ? `Reconciled to ${d.last}. ` : ""}Enter your statement's end date and the closing balance it shows.</p>
          <Form method="post" className="grid gap-4 md:grid-cols-[200px_220px_auto]">
            <Field label="Statement ends on" htmlFor="date">
              <input id="date" name="date" type="date" max={d.today} required className={inputClass} />
            </Field>
            <Field label="Closing balance" htmlFor="balance">
              <input id="balance" name="balance" inputMode="decimal" required className={inputClass} />
            </Field>
            <button type="submit" name="intent" value="start" className={`${buttonClass} md:mt-7`} disabled={busy}>
              Start
            </button>
          </Form>
          {d.last ? (
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-gray-500">Undo the last reconciliation</summary>
              <Form method="post" className="mt-2 flex flex-wrap gap-2">
                <input name="reason" required placeholder="Why (kept in the activity log)" className={`${inputClass} md:w-80`} />
                <button type="submit" name="intent" value="undo" className={quietButtonClass} disabled={busy}>
                  Undo it
                </button>
              </Form>
            </details>
          ) : null}
        </Card>
      ) : null}

      {r ? (
        <Form method="post" className="space-y-5">
          <input type="hidden" name="recId" value={r.id} />
          {r.lines.map((l) => (
            <input key={l.id} type="hidden" name={ticked[l.id] ? "on" : "off"} value={l.id} />
          ))}
          <Card title={`To ${r.statementDate}`}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              <dt className="text-gray-500">Statement balance</dt>
              <dd><Money value={r.statementBalance} /></dd>
              <dt className="text-gray-500">Reconciled before</dt>
              <dd><Money value={r.previous} /></dd>
              <dt className="text-gray-500">Ticked</dt>
              <dd><Money value={r.cleared} /></dd>
              <dt className="text-gray-500">Difference</dt>
              <dd className={r.zero ? "font-semibold text-mint-700" : "font-semibold text-coral-700"}>{r.difference}</dd>
            </dl>
            <p className="text-xs text-gray-500">The difference shown is as last saved; save your ticks to see it change.</p>
            {r.truncated ? <p className="text-xs text-coral-700">Only the first 3,000 entries are shown.</p> : null}
            <ul className="divide-y divide-gray-100">
              {r.lines.map((l) => (
                <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
                  <input type="checkbox" className="h-4 w-4" checked={!!ticked[l.id]} onChange={(e) => setTicked((t) => ({ ...t, [l.id]: e.target.checked }))} aria-label={`Tick ${l.label}`} disabled={!d.canManage} />
                  <span className="w-24 text-gray-500">{l.date}</span>
                  <span className="min-w-0 flex-1 truncate text-gray-800">
                    {l.label}
                    {l.matched ? <span className="ml-1.5 text-xs text-mint-700">on the statement</span> : null}
                  </span>
                  <Money value={l.amount} className="w-36 text-right" />
                </li>
              ))}
            </ul>
          </Card>
          {d.canManage ? (
            <div className="flex flex-wrap gap-3">
              <button type="submit" name="intent" value="tick" className={quietButtonClass} disabled={busy}>
                Save ticks
              </button>
              <button type="submit" name="intent" value="finish" className={buttonClass} disabled={busy || !r.zero}>
                Finish
              </button>
              <button type="submit" name="intent" value="discard" className="text-sm font-semibold text-gray-500" disabled={busy}>
                Discard
              </button>
            </div>
          ) : null}
        </Form>
      ) : null}
    </div>
  );
}
