import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/books.close";
import { Forbidden } from "~/lib/authorize.server";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { requireBook } from "~/lib/books-app/access.server";
import { BooksError, closeCheck, prepareClose, setClosedThrough } from "~/lib/books/books.server";
import { CONNECTORS } from "~/lib/books/connectors/registry";
import { formatDate, monthEnd, monthStart, todayIn } from "~/lib/books/dates";
import { addDays, isIsoDate } from "~/lib/books/posting";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Close the books · Books · Growzar" }];
}

const connectorName = (key: string) => CONNECTORS.find((c) => c.key === key)?.name ?? key;

/**
 * Close the books (B6, D-70): once a month is checked, close it so nothing
 * dated on or before that day can be added, saved or cancelled. Only owners
 * and admins close or reopen (reopening needs a reason, kept in the activity
 * log); an accountant prepares a close for them to confirm. Before closing,
 * the screen says what would be left behind: drafts waiting and sources not
 * yet brought in up to the date. Ported from Financify's settings.close.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canManage, canClose } = await requireBook(request, "view");
  const today = todayIn(book.settings.timeZone);
  const suggested = monthEnd(addDays(monthStart(today), -1));
  const prepared = book.settings.preparedClose ?? null;
  const asked = url.searchParams.get("through");
  const through = isIsoDate(asked) ? asked : prepared?.through ?? (book.lockedThrough && suggested <= book.lockedThrough ? null : suggested);
  const valid = !!through && through <= today && (!book.lockedThrough || through > book.lockedThrough);
  const check = valid ? await closeCheck(book, through!) : null;
  const history = await prisma.bkAuditEvent.findMany({
    where: { bookId: book.id, action: { in: ["book.closed", "book.reopened", "book.close_prepared", "book.close_withdrawn"] } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, action: true, actor: true, detail: true, createdAt: true },
  });
  const actors = [...new Set([...history.map((h) => h.actor), prepared?.by ?? null].filter((x): x is string => !!x))];
  const names = new Map((actors.length ? await prisma.user.findMany({ where: { id: { in: actors } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  const who = (id: string | null) => (id ? (id === viewer.userId ? "You" : names.get(id) || "Someone on your team") : "Automatic");
  const error = !through ? null : !isIsoDate(through) ? "Choose a date" : through > today ? "You can only close days that have already happened." : book.lockedThrough && through <= book.lockedThrough ? `Already closed through ${formatDate(book.lockedThrough)}. To close fewer days, reopen below.` : null;
  return {
    today,
    canClose,
    // An accountant (or anyone who manages Books but can't close) prepares instead.
    canPrepare: canManage && !canClose,
    lockedThrough: book.lockedThrough,
    closedLabel: book.lockedThrough ? formatDate(book.lockedThrough) : null,
    nextOpen: book.lockedThrough ? formatDate(addDays(book.lockedThrough, 1)) : null,
    through: through ?? "",
    throughLabel: through && isIsoDate(through) ? formatDate(through) : "",
    error,
    check: check ? { drafts: check.drafts, behind: check.behind.map((b) => ({ name: connectorName(b.key), through: b.syncedThrough ? formatDate(b.syncedThrough) : null })) } : null,
    prepared: prepared ? { through: prepared.through, label: formatDate(prepared.through), by: who(prepared.by), at: formatDate(prepared.at.slice(0, 10)), note: prepared.note ?? null } : null,
    history: history.map((h) => {
      const d = (h.detail ?? {}) as { from?: string | null; to?: string | null; reason?: string; note?: string };
      const text =
        h.action === "book.closed"
          ? `Closed through ${formatDate(d.to ?? null)}`
          : h.action === "book.reopened"
            ? d.to
              ? `Reopened after ${formatDate(d.to)}`
              : "Reopened every date"
            : h.action === "book.close_prepared"
              ? `Prepared closing through ${formatDate(d.to ?? null)}`
              : `Withdrew the prepared close through ${formatDate(d.from ?? null)}`;
      return { id: h.id.toString(), text, who: who(h.actor), at: formatDate(h.createdAt.toISOString().slice(0, 10)), why: d.reason ?? d.note ?? null };
    }),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage, canClose } = await requireBook(request, "view");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const today = todayIn(book.settings.timeZone);
  const intent = str("intent");
  try {
    if (intent === "close" || intent === "reopen") {
      if (!canClose) throw new Forbidden("Only an owner or admin can close or reopen the books.");
      if (intent === "close") {
        const through = await setClosedThrough(book, str("through"), today, viewer.userId);
        return { ok: `Closed through ${formatDate(through)}.` };
      }
      const through = await setClosedThrough(book, str("keep") || null, today, viewer.userId, str("reason"));
      return { ok: through ? `Reopened. Now closed through ${formatDate(through)}.` : "Reopened. Every date is open." };
    }
    if (intent === "prepare" || intent === "withdraw") {
      if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
      if (intent === "prepare") {
        await prepareClose(book, str("through"), today, viewer.userId, str("note"));
        return { ok: `Prepared. An owner or admin can now close through ${formatDate(str("through"))}.` };
      }
      await prepareClose(book, null, today, viewer.userId);
      throw redirect("/books/close");
    }
    return { error: "Nothing to do.", field: null };
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? null };
    throw e;
  }
}

export default function Close({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const err = actionData && "error" in actionData ? actionData : null;
  const ready = !!d.check && !d.error;
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {err && err.field !== "through" && err.field !== "reason" ? <Notice tone="warn">{err.error}</Notice> : null}

      <Card title={d.closedLabel ? `Closed through ${d.closedLabel}` : "Every date is open"}>
        <p className="text-sm text-gray-600">
          {d.closedLabel
            ? `Nothing dated on or before ${d.closedLabel} can be added, saved or cancelled. Cancelling an older entry puts its reversal on ${d.nextOpen}.`
            : "Once you've checked a month (bank balances match, sales and costs are in), close it so nothing in it changes by accident."}
        </p>
        {!d.canClose && !d.canPrepare ? <p className="text-sm text-gray-600">Only an owner or admin can close the books.</p> : null}
      </Card>

      {d.prepared ? (
        <Card title={`Prepared: close through ${d.prepared.label}`}>
          <p className="text-sm text-gray-600">
            {d.prepared.by} prepared this on {d.prepared.at}
            {d.canClose ? ". Check what's below and close it." : ", for an owner or admin to confirm."}
          </p>
          {d.prepared.note ? <p className="rounded-xl bg-field p-3 text-sm text-gray-700">{d.prepared.note}</p> : null}
          {d.canPrepare ? (
            <Form method="post">
              <button type="submit" name="intent" value="withdraw" className={quietButtonClass} disabled={busy}>
                Withdraw
              </button>
            </Form>
          ) : null}
        </Card>
      ) : null}

      {d.canClose || d.canPrepare ? (
        <Card title={d.canClose ? (d.closedLabel ? "Close more days" : "Close the books") : "Prepare a close"}>
          <Form method="get" className="flex flex-wrap items-end gap-2">
            <Field label="Close everything up to and including" htmlFor="through" error={err?.field === "through" ? err.error : d.error}>
              <input id="through" name="through" type="date" defaultValue={d.through} max={d.today} className={`${inputClass} w-48`} />
            </Field>
            <button type="submit" className={quietButtonClass}>
              Check
            </button>
          </Form>
          {d.check ? (
            <div className="space-y-2">
              {d.check.drafts > 0 ? (
                <Notice tone="warn">
                  {d.check.drafts} draft{d.check.drafts === 1 ? " is" : "s are"} dated on or before {d.throughLabel}. Once closed, {d.check.drafts === 1 ? "it" : "they"} can't be saved.{" "}
                  <Link to="/books/drafts" className="font-semibold underline">
                    Save or discard {d.check.drafts === 1 ? "it" : "them"} first
                  </Link>
                  .
                </Notice>
              ) : null}
              {d.check.behind.map((b) => (
                <Notice key={b.name} tone="warn">
                  {b.name} {b.through ? `has only brought things in up to ${b.through}` : "hasn't brought anything in yet"}. Anything it finds for closed days will wait as a draft you can't save.
                </Notice>
              ))}
              {d.check.drafts === 0 && d.check.behind.length === 0 ? <p className="text-sm font-medium text-emerald-700">No drafts are waiting and every source is up to date for this period.</p> : null}
            </div>
          ) : null}
          {ready && d.canClose ? (
            <Form method="post">
              <input type="hidden" name="through" value={d.through} />
              <button type="submit" name="intent" value="close" className={buttonClass} disabled={busy}>
                Close through {d.throughLabel}
              </button>
            </Form>
          ) : null}
          {ready && d.canPrepare ? (
            <Form method="post" className="space-y-3">
              <input type="hidden" name="through" value={d.through} />
              <Field label="A note for the owner (optional)" htmlFor="note">
                <input id="note" name="note" maxLength={500} placeholder="For example: September's bank statements are reconciled" className={inputClass} />
              </Field>
              <button type="submit" name="intent" value="prepare" className={buttonClass} disabled={busy}>
                Prepare closing through {d.throughLabel}
              </button>
            </Form>
          ) : null}
        </Card>
      ) : null}

      {d.lockedThrough && d.canClose ? (
        <Card title="Reopen">
          <p className="text-sm text-gray-600">Reopening lets entries in those days change again; reports you've already shared may no longer match.</p>
          <Form method="post" className="grid gap-3 md:grid-cols-[200px_1fr_auto] md:items-end">
            <Field label="Keep closed through" htmlFor="keep" help="Leave empty to reopen every date.">
              <input id="keep" name="keep" type="date" max={addDays(d.lockedThrough, -1)} className={inputClass} />
            </Field>
            <Field label="Why are you reopening?" htmlFor="reason" error={err?.field === "reason" ? err.error : null}>
              <input id="reason" name="reason" required maxLength={500} placeholder="For example: a supplier bill for September arrived late" className={inputClass} />
            </Field>
            <button type="submit" name="intent" value="reopen" className={quietButtonClass} disabled={busy}>
              Reopen
            </button>
          </Form>
        </Card>
      ) : null}

      {d.history.length ? (
        <Card title="History">
          <ul className="divide-y divide-gray-100 text-sm">
            {d.history.map((h) => (
              <li key={h.id} className="py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-gray-900">{h.text}</span>
                  <span className="text-xs text-gray-500">
                    {h.who} · {h.at}
                  </span>
                </div>
                {h.why ? <p className="text-xs text-gray-500">{h.why}</p> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
