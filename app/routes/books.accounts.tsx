import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { Archive, Pencil, Plus, RotateCcw } from "lucide-react";

import type { Route } from "./+types/books.accounts";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money, typeLabel } from "~/lib/books-app/format";
import { BooksError, createAccount, createMoneyAccount, listAccounts, setAccountArchived, updateAccount } from "~/lib/books/books.server";
import { ACCOUNT_TYPES, MONEY_KINDS, SUBTYPES_FOR_TYPE, SUBTYPE_LABELS, isMoneySubtype, type AccountType } from "~/lib/books/chart";
import { todayIn } from "~/lib/books/dates";
import { parseAmount } from "~/lib/books/money";
import { isIsoDate } from "~/lib/books/posting";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, Money, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Accounts · Books · Growzar" }];
}

/**
 * The chart of accounts (B2): every account with its balance today, grouped by
 * type. Adding, renaming, re-kinding and archiving follow the engine's rules
 * (Books' own accounts keep their kind and can't be archived; an account with
 * a balance can't be archived).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const today = todayIn(book.settings.timeZone);
  const accounts = await listAccounts(book, { includeArchived: true, asOf: today });
  return {
    canManage,
    today,
    startDate: book.settings.startDate ?? today,
    currency: book.currency,
    groups: ACCOUNT_TYPES.map((type) => ({
      type,
      label: typeLabel(type, accountant),
      accounts: accounts
        .filter((a) => a.type === type)
        .map((a) => ({
          id: a.id,
          code: a.code,
          name: a.name,
          subtype: a.subtype,
          kind: SUBTYPE_LABELS[a.subtype] ?? a.subtype,
          parentId: a.parentId,
          system: !!a.systemKey,
          archived: a.archived,
          balance: money(book, type === "asset" || type === "expense" ? a.balance : -a.balance, accountant),
        })),
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "").trim();
  try {
    switch (str("intent")) {
      case "create": {
        const type = str("type") as AccountType;
        if (!ACCOUNT_TYPES.includes(type)) return { error: "Choose a type", field: "type" };
        const subtype = str("subtype");
        if (isMoneySubtype(subtype)) {
          const raw = str("opening").replace(/,/g, "");
          const neg = /^[-−]/.test(raw);
          const v = raw === "" ? 0n : parseAmount(neg ? raw.slice(1) : raw, book.decimals);
          if (v === null) return { error: "Enter the balance as an amount, like 25000", field: "opening" };
          const date = str("date");
          if (!isIsoDate(date)) return { error: "Choose the day of that balance", field: "date" };
          await createMoneyAccount(book, { subtype, name: str("name"), opening: neg ? -v : v, date }, viewer.userId);
        } else {
          await createAccount(book, { name: str("name"), type, subtype, parentId: str("parentId") || null }, viewer.userId);
        }
        return { ok: `Added "${str("name")}".` };
      }
      case "update":
        await updateAccount(book, str("id"), { name: str("name"), subtype: str("subtype"), parentId: str("parentId") || null }, viewer.userId);
        return { ok: "Saved." };
      case "archive":
      case "restore":
        await setAccountArchived(book, str("id"), str("intent") === "archive", viewer.userId);
        return { ok: str("intent") === "archive" ? "Archived." : "Restored." };
      default:
        return { error: "Nothing to do.", field: "" };
    }
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

type Account = Route.ComponentProps["loaderData"]["groups"][number]["accounts"][number];

function EditAccount({ a, type, parents, onDone }: { a: Account; type: AccountType; parents: Account[]; onDone: () => void }) {
  return (
    <Form method="post" className="grid gap-2 py-2 md:grid-cols-[1fr_180px_200px_auto_auto]" onSubmit={onDone}>
      <input type="hidden" name="intent" value="update" />
      <input type="hidden" name="id" value={a.id} />
      <input name="name" defaultValue={a.name} aria-label="Name" className={inputClass} />
      <select name="subtype" defaultValue={a.subtype} aria-label="Kind" className={inputClass} disabled={a.system}>
        {SUBTYPES_FOR_TYPE[type].map((s) => (
          <option key={s} value={s}>
            {SUBTYPE_LABELS[s] ?? s}
          </option>
        ))}
      </select>
      {a.system ? <input type="hidden" name="subtype" value={a.subtype} /> : null}
      <select name="parentId" defaultValue={a.parentId ?? ""} aria-label="Under" className={inputClass}>
        <option value="">Not under another</option>
        {parents
          .filter((p) => p.id !== a.id && !p.parentId && !p.archived)
          .map((p) => (
            <option key={p.id} value={p.id}>
              Under {p.name}
            </option>
          ))}
      </select>
      <button type="submit" className={buttonClass}>
        Save
      </button>
      <button type="button" className={quietButtonClass} onClick={onDone}>
        Cancel
      </button>
    </Form>
  );
}

export default function BooksAccounts({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [editing, setEditing] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [type, setType] = useState<AccountType>("expense");
  const [subtype, setSubtype] = useState(SUBTYPES_FOR_TYPE.expense[0]!);
  const err = (f: string) => (actionData && "error" in actionData && actionData.field === f ? actionData.error : null);
  const isMoney = isMoneySubtype(subtype);

  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData && !["name", "type", "subtype", "parentId", "opening", "date"].includes(actionData.field ?? "") ? <Notice tone="warn">{actionData.error}</Notice> : null}

      {d.groups.map((g) => {
        const rows = g.accounts.filter((a) => showArchived || !a.archived);
        return (
          <Card key={g.type} title={g.label}>
            <ul className="divide-y divide-gray-100">
              {rows.map((a) => (
                <li key={a.id} className={a.parentId ? "pl-6" : undefined}>
                  {editing === a.id ? (
                    <EditAccount a={a} type={g.type} parents={g.accounts} onDone={() => setEditing(null)} />
                  ) : (
                    <div className="flex flex-wrap items-center gap-3 py-2 text-sm">
                      <span className="w-14 tabular-nums text-gray-500">{a.code}</span>
                      <span className={`flex-1 ${a.archived ? "text-gray-400 line-through" : "text-gray-900"}`}>
                        {a.name}
                        <span className="ml-2 text-xs text-gray-500">{a.kind}</span>
                        {a.system ? <span className="ml-2 rounded-full bg-field px-2 py-0.5 text-[11px] font-semibold text-gray-500">Books uses this</span> : null}
                      </span>
                      <Money value={a.balance} className="w-36 text-right" />
                      {d.canManage ? (
                        <span className="flex gap-1">
                          <button type="button" aria-label={`Edit ${a.name}`} className={quietButtonClass} onClick={() => setEditing(a.id)} disabled={a.archived}>
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {a.system ? null : (
                            <Form method="post">
                              <input type="hidden" name="id" value={a.id} />
                              <button type="submit" name="intent" value={a.archived ? "restore" : "archive"} aria-label={a.archived ? `Restore ${a.name}` : `Archive ${a.name}`} className={quietButtonClass} disabled={busy}>
                                {a.archived ? <RotateCcw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                              </button>
                            </Form>
                          )}
                        </span>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        );
      })}

      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input type="checkbox" className="h-4 w-4" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived accounts
      </label>

      {d.canManage ? (
        <Card title="Add an account">
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="create" />
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Type" htmlFor="type" error={err("type")}>
                <select
                  id="type"
                  name="type"
                  className={inputClass}
                  value={type}
                  onChange={(e) => {
                    const t = e.target.value as AccountType;
                    setType(t);
                    setSubtype(SUBTYPES_FOR_TYPE[t][0]!);
                  }}
                >
                  {d.groups.map((g) => (
                    <option key={g.type} value={g.type}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Kind" htmlFor="subtype" error={err("subtype")}>
                <select id="subtype" name="subtype" className={inputClass} value={subtype} onChange={(e) => setSubtype(e.target.value)}>
                  {SUBTYPES_FOR_TYPE[type].map((s) => (
                    <option key={s} value={s}>
                      {MONEY_KINDS.find((k) => k.subtype === s)?.label ?? SUBTYPE_LABELS[s] ?? s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Name" htmlFor="name" error={err("name")}>
                <input id="name" name="name" className={inputClass} required />
              </Field>
            </div>
            {isMoney ? (
              <div className="grid gap-4 md:grid-cols-3">
                <Field label={`Balance (${d.currency})`} htmlFor="opening" error={err("opening")} help="What was in it on that day. Leave empty for none.">
                  <input id="opening" name="opening" inputMode="decimal" className={inputClass} />
                </Field>
                <Field label="On" htmlFor="date" error={err("date")}>
                  <input id="date" name="date" type="date" defaultValue={d.today} max={d.today} min={d.startDate} className={inputClass} />
                </Field>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Under" htmlFor="parentId" error={err("parentId")} help="Optional: a sub-account adds up into its parent in reports.">
                  <select id="parentId" name="parentId" className={inputClass} defaultValue="">
                    <option value="">Not under another</option>
                    {(d.groups.find((g) => g.type === type)?.accounts ?? [])
                      .filter((a) => !a.parentId && !a.archived)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
            )}
            <button type="submit" className={buttonClass} disabled={busy}>
              <Plus className="h-4 w-4" /> Add account
            </button>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}
