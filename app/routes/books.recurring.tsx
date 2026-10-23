import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/books.recurring";
import { Forbidden } from "~/lib/authorize.server";
import { readFormData } from "~/lib/form.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { BooksError } from "~/lib/books/books.server";
import { formatDate, todayIn } from "~/lib/books/dates";
import { FREQUENCIES } from "~/lib/books/recurring";
import { deleteRecurring, listRecurring, readScheduleForm, runRecurring, setRecurringPaused, updateRecurring } from "~/lib/books/recurring.server";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, Money, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Recurring entries · Books · Growzar" }];
}

/**
 * Recurring entries (Books v1.1 V6): what repeats, when it's next, and
 * whether it waits as a draft (the default, D-101) or is saved straight
 * away. Made from an entry ("Repeat this"). Ported from Financify's
 * settings.recurring; one rule is changed at a time (?edit=<id>).
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const today = todayIn(book.settings.timeZone);
  // Anything due is made before the list is shown.
  if (canManage) await runRecurring(book, today).catch(() => 0);
  const rules = await listRecurring(book);
  const m = (v: bigint) => money(book, v, isAccountantRole(viewer.role));
  return {
    canManage,
    made: url.searchParams.get("made"),
    editId: url.searchParams.get("edit"),
    rules: rules.map((r) => ({
      ...r,
      total: r.total === null ? null : m(r.total),
      next: r.nextDate ? formatDate(r.nextDate) : null,
      state: r.paused ? "Paused" : !r.nextDate ? "Ended" : r.mode === "auto" ? "Saves automatically" : "Makes drafts",
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  const today = todayIn(book.settings.timeZone);
  try {
    if (intent === "pause" || intent === "resume") await setRecurringPaused(book, id, intent === "pause", today, viewer.userId);
    else if (intent === "delete") await deleteRecurring(book, id, viewer.userId);
    else if (intent === "update") await updateRecurring(book, id, readScheduleForm(form), today, viewer.userId);
    else return { error: "Nothing to do." };
    await runRecurring(book, today);
    return { ok: intent === "delete" ? "Stopped. The entries already made stay as they are." : "Saved." };
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message };
    throw e;
  }
}

export default function Recurring({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <div className="space-y-5">
      {d.made ? <Notice>It will repeat. Anything already due has been made: check To approve.</Notice> : null}
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      <div>
        <h2 className="font-display text-xl font-bold text-gray-900">Recurring entries</h2>
        <p className="text-sm text-gray-600">Rent, salaries, subscriptions: made for you on their dates, as drafts to approve unless you choose otherwise.</p>
      </div>
      {d.rules.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-600">Nothing repeats yet. Open an entry you make every month (rent, a salary, an app subscription) and choose "Make it repeat".</p>
        </Card>
      ) : (
        d.rules.map((r) => (
          <Card key={r.id} title={r.name} aside={<span className="text-xs font-semibold text-gray-500">{r.state}</span>}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-gray-700">
                {r.kind}
                {r.contactName ? ` · ${r.contactName}` : ""} · {r.schedule}
                {r.next && !r.paused ? ` · next on ${r.next}` : ""}
              </span>
              {r.total ? <Money value={r.total} className="font-semibold" /> : null}
            </div>
            {r.problem ? <Notice tone="warn">As it stands this can't be saved: {r.problem}. Make a new one from a corrected entry and stop this one.</Notice> : null}
            {r.lastMessage ? <p className="text-xs text-coral-700">{r.lastMessage}</p> : null}
            {d.canManage ? (
              d.editId === r.id ? (
                <Form method="post" className="grid gap-3 md:grid-cols-3">
                  <input type="hidden" name="id" value={r.id} />
                  <Field label="Name" htmlFor={`n-${r.id}`}>
                    <input id={`n-${r.id}`} name="name" required defaultValue={r.name} className={inputClass} />
                  </Field>
                  <Field label="How often" htmlFor={`f-${r.id}`}>
                    <select id={`f-${r.id}`} name="frequency" defaultValue={r.frequency} className={inputClass}>
                      {FREQUENCIES.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Every" htmlFor={`i-${r.id}`}>
                    <input id={`i-${r.id}`} name="interval" type="number" min={1} max={12} defaultValue={r.interval} className={inputClass} />
                  </Field>
                  <Field label="On day of the month" htmlFor={`d-${r.id}`}>
                    <input id={`d-${r.id}`} name="dayOfMonth" type="number" min={1} max={31} defaultValue={r.dayOfMonth ?? ""} className={inputClass} />
                  </Field>
                  <Field label="Starts" htmlFor={`s-${r.id}`}>
                    <input id={`s-${r.id}`} name="startDate" type="date" required defaultValue={r.startDate} className={inputClass} />
                  </Field>
                  <Field label="Ends (optional)" htmlFor={`e-${r.id}`}>
                    <input id={`e-${r.id}`} name="endDate" type="date" defaultValue={r.endDate ?? ""} className={inputClass} />
                  </Field>
                  <Field label="Each time" htmlFor={`m-${r.id}`}>
                    <select id={`m-${r.id}`} name="mode" defaultValue={r.mode} className={inputClass}>
                      <option value="draft">Make a draft to approve</option>
                      <option value="auto">Save it to the books</option>
                    </select>
                  </Field>
                  <span className="flex gap-2 md:col-span-3">
                    <button type="submit" name="intent" value="update" className={buttonClass} disabled={busy}>
                      Save
                    </button>
                    <Link to="?" className={quietButtonClass}>
                      Cancel
                    </Link>
                  </span>
                </Form>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Link to={`?edit=${r.id}`} className={quietButtonClass}>
                    Change
                  </Link>
                  {r.nextDate || r.paused ? (
                    <Form method="post">
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit" name="intent" value={r.paused ? "resume" : "pause"} className={quietButtonClass} disabled={busy}>
                        {r.paused ? "Resume" : "Pause"}
                      </button>
                    </Form>
                  ) : null}
                  <details>
                    <summary className={`${quietButtonClass} cursor-pointer list-none`}>Stop</summary>
                    <Form method="post" className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <input type="hidden" name="id" value={r.id} />
                      <span className="text-gray-600">No more entries will be made; the ones already made stay.</span>
                      <button type="submit" name="intent" value="delete" className={buttonClass} disabled={busy}>
                        Stop it
                      </button>
                    </Form>
                  </details>
                </div>
              )
            ) : null}
          </Card>
        ))
      )}
      <p className="text-xs text-gray-500">Pausing skips the dates it misses; resuming carries on from the next date after today.</p>
    </div>
  );
}
