import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/books.taxes";
import { Forbidden } from "~/lib/authorize.server";
import { readFormData } from "~/lib/form.server";
import { requireBook } from "~/lib/books-app/access.server";
import { BooksError, listAccounts } from "~/lib/books/books.server";
import { TAX_KINDS, TAX_KIND_LABELS, formatRate, parseRate, suggestedRates, type TaxKind } from "~/lib/books/tax";
import { listTaxRates, saveTaxRate, setTaxRateArchived } from "~/lib/books/taxes.server";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Tax rates · Books · Growzar" }];
}

/**
 * Tax rates (Books v1.1 V2): the rates you charge, pay and withhold, and
 * where each goes in the books. Entries copy the rate when they're made, so
 * editing one here never changes past entries. Ported from Financify's
 * settings.taxes; the form opens for one rate at a time (?edit=<id>|new&kind=).
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { book, canManage } = await requireBook(request, "view");
  const [rates, accounts] = await Promise.all([listTaxRates(book, { includeArchived: true }), listAccounts(book)]);
  const names = new Set(rates.map((r) => r.name.toLowerCase()));
  const taxAccounts = accounts.filter((a) => a.subtype === "tax" && (a.type === "asset" || a.type === "liability")).map((a) => ({ id: a.id, name: a.name, type: a.type, code: a.code }));
  const editId = url.searchParams.get("edit");
  const kind = (TAX_KINDS as readonly string[]).includes(url.searchParams.get("kind") ?? "") ? (url.searchParams.get("kind") as TaxKind) : "sales";
  const editing = editId === "new" ? { id: "", name: url.searchParams.get("name") ?? "", kind, rate: url.searchParams.get("rate") ?? "", accountId: "" } : (() => {
    const r = rates.find((x) => x.id === editId);
    return r ? { id: r.id, name: r.name, kind: r.kind, rate: formatRate(r.rateBp).replace("%", ""), accountId: r.accountId ?? "" } : null;
  })();
  const accountsFor = (k: TaxKind) => taxAccounts.filter((a) => (k === "purchase" ? a.type === "asset" : a.type === "liability"));
  const preferred = (k: TaxKind) => {
    const list = accountsFor(k);
    const code = k === "sales" ? "2100" : k === "withholding" ? "2110" : "1300";
    return (list.find((a) => a.code === code) ?? list[0])?.id ?? "";
  };
  return {
    canManage,
    showArchived: url.searchParams.get("archived") === "1",
    rates: rates.map((r) => ({ ...r, rate: formatRate(r.rateBp), account: r.accountId ? taxAccounts.find((a) => a.id === r.accountId)?.name ?? "Unknown account" : "Part of the cost (not claimed)" })),
    suggestions: suggestedRates(book.currency).filter((s) => !names.has(s.name.toLowerCase())).map((s) => ({ ...s, rate: formatRate(s.rateBp).replace("%", "") })),
    editing: editing ? { ...editing, accountId: editing.accountId || preferred(editing.kind), choices: accountsFor(editing.kind) } : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    const intent = str("intent");
    if (intent === "save") {
      const rateBp = parseRate(str("rate"));
      if (rateBp === null) return { error: "Enter a rate like 18 or 4.5", field: "rateBp" };
      await saveTaxRate(book, { id: str("id") || null, name: str("name"), kind: str("kind") as TaxKind, rateBp, accountId: str("accountId") || null }, viewer.userId);
      return { ok: "Saved." };
    }
    if (intent === "archive" || intent === "restore") {
      await setTaxRateArchived(book, str("id"), intent === "archive", viewer.userId);
      return { ok: intent === "archive" ? "Archived. Past entries keep it." : "Back in use." };
    }
    return { error: "Nothing to do.", field: "" };
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

export default function Taxes({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const err = actionData && "error" in actionData ? actionData : null;
  const visible = d.rates.filter((r) => d.showArchived || !r.archived);
  const e = d.editing;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/books/reports/tax-summary" className="text-xs font-semibold text-accent-600">
            ← Tax summary
          </Link>
          <h2 className="font-display text-xl font-bold text-gray-900">Tax rates</h2>
          <p className="text-sm text-gray-600">Rates you charge, pay and withhold. Entries copy the rate when they're made, so changing one here never changes past entries.</p>
        </div>
        {d.rates.some((r) => r.archived) ? (
          <Link to={d.showArchived ? "?" : "?archived=1"} className="text-sm font-semibold text-accent-600">
            {d.showArchived ? "Hide archived" : "Show archived"}
          </Link>
        ) : null}
      </div>
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {err && !e ? <Notice tone="warn">{err.error}</Notice> : null}

      {d.canManage && e ? (
        <Card title={e.id ? `Change ${e.name}` : `Add a rate: ${TAX_KIND_LABELS[e.kind].label.toLowerCase()}`}>
          <Form method="post" className="grid gap-3 md:grid-cols-[1fr_140px_1fr_auto] md:items-end">
            <input type="hidden" name="id" value={e.id} />
            <input type="hidden" name="kind" value={e.kind} />
            <Field label="Name" htmlFor="name" error={err?.field === "name" ? err.error : null}>
              <input id="name" name="name" defaultValue={e.name} required maxLength={100} className={inputClass} />
            </Field>
            <Field label="Rate (%)" htmlFor="rate" error={err?.field === "rateBp" ? err.error : null}>
              <input id="rate" name="rate" defaultValue={e.rate} inputMode="decimal" required className={inputClass} />
            </Field>
            <Field label="Goes to" htmlFor="accountId" error={err?.field === "accountId" ? err.error : null}>
              <select id="accountId" name="accountId" defaultValue={e.accountId} className={inputClass}>
                {e.choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                {e.kind === "purchase" ? <option value="">Part of the cost (not claimed)</option> : null}
              </select>
            </Field>
            <span className="flex gap-2">
              <button type="submit" name="intent" value="save" className={buttonClass} disabled={busy}>
                Save
              </button>
              <Link to="?" className={quietButtonClass}>
                Cancel
              </Link>
            </span>
          </Form>
        </Card>
      ) : null}

      {d.canManage && d.suggestions.length ? (
        <Card title="Common rates to start from">
          <p className="text-xs text-gray-500">These only fill in the form. Rates change and depend on what you sell; check them with your tax adviser.</p>
          <div className="flex flex-wrap gap-2">
            {d.suggestions.map((s) => (
              <Link key={s.name} to={`?${new URLSearchParams({ edit: "new", kind: s.kind, name: s.name, rate: s.rate }).toString()}`} className={quietButtonClass}>
                {s.name} · {TAX_KIND_LABELS[s.kind].label.toLowerCase()}
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {TAX_KINDS.map((kind) => {
        const rows = visible.filter((r) => r.kind === kind);
        return (
          <Card
            key={kind}
            title={TAX_KIND_LABELS[kind].label}
            aside={
              d.canManage ? (
                <Link to={`?edit=new&kind=${kind}`} className="text-sm font-semibold text-accent-600">
                  Add
                </Link>
              ) : null
            }
          >
            <p className="text-xs text-gray-500">{TAX_KIND_LABELS[kind].help}</p>
            {rows.length === 0 ? (
              <p className="text-sm text-gray-500">None yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100 text-sm">
                {rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className={r.archived ? "text-gray-400" : "text-gray-900"}>
                      <span className="font-semibold">{r.name}</span> · {r.rate} · {r.account}
                      {r.archived ? " · archived" : ""}
                    </span>
                    {d.canManage ? (
                      <span className="flex gap-2">
                        {!r.archived ? (
                          <Link to={`?edit=${r.id}`} className={quietButtonClass}>
                            Change
                          </Link>
                        ) : null}
                        <Form method="post">
                          <input type="hidden" name="id" value={r.id} />
                          <button type="submit" name="intent" value={r.archived ? "restore" : "archive"} className={quietButtonClass} disabled={busy}>
                            {r.archived ? "Use again" : "Archive"}
                          </button>
                        </Form>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}
