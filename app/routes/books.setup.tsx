import { useState } from "react";
import { Form, redirect, useNavigation } from "react-router";
import { Plus, Trash2 } from "lucide-react";

import type { Route } from "./+types/books.setup";
import { readFormData } from "~/lib/form.server";
import { requireBooks } from "~/lib/books-app/access.server";
import { COD_BASES, checkSetup, type SetupInput } from "~/lib/books-app/setup";
import { createBook, setupContext } from "~/lib/books-app/setup.server";
import { BooksError } from "~/lib/books/books.server";
import { MONEY_KINDS } from "~/lib/books/chart";
import { MONTH_NAMES, formatDate } from "~/lib/books/dates";
import { TAX_KIND_LABELS, TAX_KINDS } from "~/lib/books/tax";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Set up your books · Growzar" }];
}

/**
 * Setting up the organization's book (B2; D-65, D-69, D-75, D-83, D-89, D-90).
 * One screen: when the books start, the year, the stores, where money is kept
 * (with its balance on the start day), when COD sales count, and tax rates.
 * Nothing is saved until the person presses Set up.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer } = await requireBooks(request, "manage");
  return setupContext(viewer);
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book } = await requireBooks(request, "manage");
  if (book) throw redirect("/books");
  const ctx = await setupContext(viewer);
  let input: SetupInput;
  try {
    input = JSON.parse(String((await readFormData(request)).get("payload") ?? "")) as SetupInput;
  } catch {
    return { error: "Something went wrong sending the form. Try again.", field: "" };
  }
  const plan = checkSetup(input, {
    currency: ctx.currency,
    today: ctx.today,
    stores: [...ctx.stores.included, ...ctx.stores.excluded],
    timeZones: ctx.timeZones,
  });
  if ("error" in plan) return plan;
  try {
    await createBook(viewer, plan);
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
  throw redirect("/books/opening?welcome=1");
}

type MoneyRow = { key: number; subtype: string; name: string; opening: string };
type RateRow = { key: number; name: string; kind: string; rate: string };
let rowKey = 0;

export default function BooksSetup({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [startDate, setStartDate] = useState(d.startDate);
  const [fyMonth, setFyMonth] = useState(d.fiscalYearStartMonth);
  const [timeZone, setTimeZone] = useState(d.timeZone ?? "");
  const [codBasis, setCodBasis] = useState("delivery");
  const [storeIds, setStoreIds] = useState(() => d.stores.included.map((s) => s.id));
  const [money, setMoney] = useState<MoneyRow[]>(() => [
    { key: ++rowKey, subtype: "bank", name: "Main bank account", opening: "" },
    { key: ++rowKey, subtype: "cash", name: "Cash in hand", opening: "" },
  ]);
  const [rates, setRates] = useState<RateRow[]>(() => d.taxRates.map((r) => ({ key: ++rowKey, ...r })));

  const err = (field: string) => (actionData && actionData.field === field ? actionData.error : null);
  const rowErr = (prefix: string, i: number, f: string) => err(`${prefix}.${i}.${f}`);
  const payload: SetupInput = {
    startDate,
    fiscalYearStartMonth: fyMonth,
    timeZone,
    codBasis,
    storeIds,
    moneyAccounts: money.map(({ subtype, name, opening }) => ({ subtype, name, opening })),
    taxRates: rates.map(({ name, kind, rate }) => ({ name, kind, rate })),
  };
  const general = actionData && !/^(startDate|fiscalYearStartMonth|timeZone|codBasis|storeIds|moneyAccounts|taxRates)/.test(actionData.field) ? actionData.error : null;

  if (d.stores.included.length === 0) {
    return (
      <Notice tone="warn">
        None of your stores can go in these books yet. Books keeps one currency, {d.currency}, and{" "}
        {d.stores.excluded.length ? d.stores.excluded.map((s) => `${s.name}: ${s.reason}`).join(" ") : "you have no stores connected."}
      </Notice>
    );
  }

  return (
    <Form method="post" className="space-y-5">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      {general ? <Notice tone="warn">{general}</Notice> : null}

      <Card title="1. When your books start">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Start date" htmlFor="startDate" error={err("startDate")} help="Everything from this day is brought in. Balances you enter are as of this day.">
            <input id="startDate" type="date" className={inputClass} value={startDate} max={d.today} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="Financial year starts in" htmlFor="fy" error={err("fiscalYearStartMonth")} help={`Your year runs ${MONTH_NAMES[fyMonth - 1]} to ${MONTH_NAMES[(fyMonth + 10) % 12]}.`}>
            <select id="fy" className={inputClass} value={fyMonth} onChange={(e) => setFyMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Time zone"
            htmlFor="tz"
            error={err("timeZone")}
            help={d.timeZone ? "Your stores' time zone. It decides which day a sale falls on." : "Your stores are in different time zones. Choose the one your books follow."}
          >
            <select id="tz" className={inputClass} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              {d.timeZone ? null : <option value="">Choose…</option>}
              {d.timeZones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="text-sm text-gray-600">
          Books are kept in <strong>{d.currency}</strong>, your organization's currency. Today is {formatDate(d.today)}.
        </p>
      </Card>

      <Card title="2. Which stores">
        <div className="space-y-2">
          {d.stores.included.map((s) => (
            <label key={s.id} className="flex items-center gap-2.5 text-sm text-gray-800">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300"
                checked={storeIds.includes(s.id)}
                onChange={(e) => setStoreIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))}
              />
              {s.name}
              {s.currency && s.currency !== d.currency ? <span className="text-xs text-gray-500">In {s.currency}: converted into {d.currency} at each day's rate</span> : null}
            </label>
          ))}
          {d.stores.excluded.map((s) => (
            <p key={s.id} className="text-sm text-gray-500">
              {s.name} can't go in yet. {s.reason}
            </p>
          ))}
          {err("storeIds") ? <p className="text-xs font-medium text-coral-700">{err("storeIds")}</p> : null}
        </div>
        <p className="text-xs text-gray-500">One set of books covers these stores; every entry records which store it belongs to, so reports can show each store or all of them.</p>
      </Card>

      <Card title="3. Where you keep money">
        <p className="text-sm text-gray-600">Each bank account, cash box, wallet or card, with what was in it at the start of {formatDate(startDate)}. Leave a balance empty if you'll add it later.</p>
        {err("moneyAccounts") ? <p className="text-xs font-medium text-coral-700">{err("moneyAccounts")}</p> : null}
        <div className="space-y-3">
          {money.map((m, i) => (
            <div key={m.key} className="grid items-start gap-3 md:grid-cols-[180px_1fr_200px_auto]">
              <Field label={i === 0 ? "Kind" : ""} error={rowErr("moneyAccounts", i, "subtype")}>
                <select aria-label="Kind" className={inputClass} value={m.subtype} onChange={(e) => setMoney((rs) => rs.map((r) => (r.key === m.key ? { ...r, subtype: e.target.value } : r)))}>
                  {MONEY_KINDS.map((k) => (
                    <option key={k.subtype} value={k.subtype}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={i === 0 ? "Name" : ""} error={rowErr("moneyAccounts", i, "name")}>
                <input aria-label="Name" className={inputClass} value={m.name} placeholder={MONEY_KINDS.find((k) => k.subtype === m.subtype)?.example} onChange={(e) => setMoney((rs) => rs.map((r) => (r.key === m.key ? { ...r, name: e.target.value } : r)))} />
              </Field>
              <Field label={i === 0 ? `Balance (${d.currency})` : ""} error={rowErr("moneyAccounts", i, "opening")}>
                <input aria-label="Balance" inputMode="decimal" className={inputClass} value={m.opening} placeholder={m.subtype === "card" ? "What you owe on it" : "0"} onChange={(e) => setMoney((rs) => rs.map((r) => (r.key === m.key ? { ...r, opening: e.target.value } : r)))} />
              </Field>
              <button type="button" aria-label="Remove" className={`${quietButtonClass} ${i === 0 ? "md:mt-7" : ""}`} onClick={() => setMoney((rs) => rs.filter((r) => r.key !== m.key))} disabled={money.length === 1}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={quietButtonClass} onClick={() => setMoney((rs) => [...rs, { key: ++rowKey, subtype: "bank", name: "", opening: "" }])}>
          <Plus className="h-4 w-4" /> Add another
        </button>
      </Card>

      <Card title="4. When cash-on-delivery sales count">
        <div className="space-y-2">
          {COD_BASES.map((b) => (
            <label key={b.value} className="flex items-start gap-2.5 text-sm">
              <input type="radio" name="codBasisChoice" className="mt-0.5 h-4 w-4" checked={codBasis === b.value} onChange={() => setCodBasis(b.value)} />
              <span>
                <span className="font-semibold text-gray-900">{b.label}</span> <span className="text-gray-600">{b.help}</span>
              </span>
            </label>
          ))}
          {err("codBasis") ? <p className="text-xs font-medium text-coral-700">{err("codBasis")}</p> : null}
        </div>
        <p className="text-xs text-gray-500">Prepaid orders count the day they're placed. You can change this later; days already saved keep theirs.</p>
      </Card>

      <Card title="5. Tax rates">
        <p className="text-sm text-gray-600">The rates you charge, can claim back, or have withheld. Remove any you don't use; you can add more later.</p>
        <div className="space-y-3">
          {rates.map((r, i) => (
            <div key={r.key} className="grid items-start gap-3 md:grid-cols-[1fr_200px_120px_auto]">
              <Field label={i === 0 ? "Name" : ""} error={rowErr("taxRates", i, "name")}>
                <input aria-label="Name" className={inputClass} value={r.name} onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))} />
              </Field>
              <Field label={i === 0 ? "Kind" : ""} error={rowErr("taxRates", i, "kind")}>
                <select aria-label="Kind" className={inputClass} value={r.kind} onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, kind: e.target.value } : x)))}>
                  {TAX_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {TAX_KIND_LABELS[k].label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={i === 0 ? "Rate %" : ""} error={rowErr("taxRates", i, "rate")}>
                <input aria-label="Rate" inputMode="decimal" className={inputClass} value={r.rate} onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, rate: e.target.value } : x)))} />
              </Field>
              <button type="button" aria-label="Remove" className={`${quietButtonClass} ${i === 0 ? "md:mt-7" : ""}`} onClick={() => setRates((rs) => rs.filter((x) => x.key !== r.key))}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={quietButtonClass} onClick={() => setRates((rs) => [...rs, { key: ++rowKey, name: "", kind: "sales", rate: "" }])}>
          <Plus className="h-4 w-4" /> Add a rate
        </button>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass} disabled={busy}>
          {busy ? "Setting up…" : "Set up my books"}
        </button>
        <p className="text-sm text-gray-500">Next you'll add what else you had on the start day: stock, what couriers owed you, what you owed suppliers.</p>
      </div>
    </Form>
  );
}
