import { useMemo, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import { Plus, Trash2 } from "lucide-react";

import type { Route } from "./+types/books.new.$type";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { RECORD_TYPES, RecordError, isBlankRow, isRecordType, type RecordType } from "~/lib/books-app/record";
import { RECORD_FORMS, accountFits, type AccountFilter, type FieldSpec } from "~/lib/books-app/record-forms";
import { recordOptions, saveRecord, type RecordInput } from "~/lib/books-app/record.server";
import { BooksError } from "~/lib/books/books.server";
import { todayIn } from "~/lib/books/dates";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta({ params }: Route.MetaArgs) {
  const t = RECORD_TYPES.find((r) => r.type === params.type);
  return [{ title: `${t?.label ?? "Record"} · Books · Growzar` }];
}

/**
 * Recording by hand (B4): one screen for every kind of entry a person makes,
 * drawn from RECORD_FORMS. Saved straight to the books, or kept as a draft;
 * the posting engine checks it either way, and every refusal names its field.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  if (!isRecordType(params.type)) throw new Response("Not found", { status: 404 });
  const today = todayIn(book.settings.timeZone);
  return { type: params.type, today, options: await recordOptions(book, today) };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  if (!isRecordType(params.type)) throw new Response("Not found", { status: 404 });
  let input: RecordInput;
  try {
    input = { ...(JSON.parse(String((await readFormData(request)).get("payload") ?? "")) as RecordInput), type: params.type };
  } catch {
    return { error: "Something went wrong sending the form. Try again.", field: "" };
  }
  try {
    const r = await saveRecord(book, input, viewer.userId);
    if (r.error) return { error: r.error.message, field: r.error.field ?? "", draftId: r.doc.id };
    throw redirect(`/books/entries/${r.doc.id}?saved=${r.doc.status === "draft" ? "draft" : "posted"}`);
  } catch (e) {
    if (e instanceof BooksError || e instanceof RecordError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

type Options = Route.ComponentProps["loaderData"]["options"];
type Row = Record<string, string> & { key: string };
let rowKey = 0;
const newRow = (cols: string[]): Row => ({ key: String(++rowKey), ...Object.fromEntries(cols.map((c) => [c, ""])) });
const LINE_COLS = ["accountId", "amount", "description", "taxRateId"];

function AccountSelect({ id, value, onChange, filter, options, label }: { id?: string; value: string; onChange: (v: string) => void; filter: AccountFilter; options: Options; label: string }) {
  return (
    <select id={id} aria-label={label} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {options.accounts
        .filter((a) => accountFits(filter, a))
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} · {a.name}
          </option>
        ))}
    </select>
  );
}

function RowsEditor({ rows, setRows, cols, render, addLabel }: { rows: Row[]; setRows: (f: (r: Row[]) => Row[]) => void; cols: string[]; render: (r: Row, i: number, set: (k: string, v: string) => void) => React.ReactNode; addLabel: string }) {
  return (
    <div className="space-y-3">
      {rows.map((r, i) => (
        <div key={r.key} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{render(r, i, (k, v) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, [k]: v } : x))))}</div>
          <button type="button" aria-label="Remove" className={quietButtonClass} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} disabled={rows.length === 1}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" className={quietButtonClass} onClick={() => setRows((rs) => [...rs, newRow(cols)])}>
        <Plus className="h-4 w-4" /> {addLabel}
      </button>
    </div>
  );
}

export default function RecordEntry({ loaderData: d, actionData }: Route.ComponentProps) {
  const type = d.type as RecordType;
  const spec = RECORD_FORMS[type];
  const meta = RECORD_TYPES.find((r) => r.type === type)!;
  const o = d.options;
  const busy = useNavigation().state !== "idle";
  const [clientKey] = useState(() => `rec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const [date, setDate] = useState(d.today);
  const [memo, setMemo] = useState("");
  const [storeId, setStoreId] = useState(o.stores.length === 1 ? o.stores[0]!.id : "");
  const [contactId, setContactId] = useState("");
  const [newContact, setNewContact] = useState("");
  const [asDraft, setAsDraft] = useState(false);
  const initial = useMemo(() => {
    const v: Record<string, string> = {};
    for (const f of spec.fields) {
      if (f.kind === "account" && f.default) v[f.key] = (o.defaults as Record<string, string | null>)[f.default] ?? "";
      if (f.kind === "choice") v[f.key] = f.options[0]!.value;
    }
    return v;
  }, [spec, o]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [lines, setLines] = useState<Row[]>(() => [newRow(LINE_COLS)]);
  const [deductions, setDeductions] = useState<Row[]>(() => [newRow(LINE_COLS)]);
  const [journal, setJournal] = useState<Row[]>(() => [newRow(["accountId", "debit", "credit", "description"]), newRow(["accountId", "debit", "credit", "description"])]);
  const [parcels, setParcels] = useState<Row[]>(() => [newRow(["orderName", "amount"])]);
  const [taxLines, setTaxLines] = useState<Row[]>(() => (o.taxOwed.length ? o.taxOwed.map((t) => ({ key: String(++rowKey), accountId: t.accountId, amount: t.amount })) : [newRow(["accountId", "amount"])]));
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [withheld, setWithheld] = useState({ rateId: "", amount: "" });
  const [taxAmount, setTaxAmount] = useState("");

  const err = (f: string) => (actionData && "error" in actionData && actionData.field === f ? actionData.error : null);
  const errUnder = (prefix: string) => (actionData && "error" in actionData && actionData.field.startsWith(prefix) ? actionData.error : null);
  const contactKind = spec.contact?.kind;
  const contacts = o.contacts.filter((c) => !contactKind || c.kinds.includes(contactKind) || c.kinds.includes("other"));
  const bills = o.bills.filter((b) => b.contactId === contactId);
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const clean = (rows: Row[]) => rows.map(({ key: _k, ...r }) => r).filter((r) => !isBlankRow(r));

  const data: Record<string, unknown> = { ...values };
  for (const f of spec.fields) {
    if (f.kind === "lines") data[f.key] = clean(f.key === "lines" ? lines : deductions);
    if (f.kind === "journal") data.lines = clean(journal);
    if (f.kind === "taxLines") data.lines = clean(taxLines);
    if (f.kind === "parcels") data.parcels = clean(parcels);
    if (f.kind === "allocations") data.allocations = Object.entries(alloc).filter(([, v]) => v.trim()).map(([billId, amount]) => ({ billId, amount }));
    if (f.kind === "withheld") data.withheld = withheld.rateId ? withheld : null;
  }
  if (type === "parcel_writeoff") data.taxAmount = taxAmount;
  const payload: Omit<RecordInput, "type"> = { date, memo, storeId: storeId || null, contactId: contactId || null, newContactName: contactId ? null : newContact || null, clientKey, data, asDraft };
  const known = new Set(["date", "memo", "storeId", "contactId", ...spec.fields.flatMap((f) => ("key" in f ? [f.key] : []))]);
  const general = actionData && "error" in actionData && !known.has(actionData.field.split(".")[0] ?? "") && !/^(lines|deductions|allocations|parcels|withheld|tax)/.test(actionData.field) ? actionData.error : null;

  const renderField = (f: FieldSpec) => {
    switch (f.kind) {
      case "account":
        return (
          <Field key={f.key} label={f.label} htmlFor={f.key} error={err(f.key)} help={f.help}>
            <AccountSelect id={f.key} value={values[f.key] ?? ""} onChange={(v) => set(f.key, v)} filter={type === "parcel_writeoff" && f.key === "account" ? (values.reason === "lost" ? "incomeOnly" : "expenseOnly") : f.filter} options={o} label={f.label} />
          </Field>
        );
      case "amount":
        return (
          <Field key={f.key} label={`${f.label} (${o.currency})`} htmlFor={f.key} error={err(f.key)} help={f.help}>
            <input id={f.key} inputMode="decimal" className={inputClass} value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
          </Field>
        );
      case "text":
        return (
          <Field key={f.key} label={f.label} htmlFor={f.key} error={err(f.key)} help={f.help}>
            <input id={f.key} className={inputClass} value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
          </Field>
        );
      case "date":
        return (
          <Field key={f.key} label={f.label} htmlFor={f.key} error={err(f.key)} help={f.help}>
            <input id={f.key} type="date" className={inputClass} value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />
          </Field>
        );
      case "choice":
        return (
          <Field key={f.key} label={f.label} htmlFor={f.key} error={err(f.key)}>
            <select
              id={f.key}
              className={inputClass}
              value={values[f.key] ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                // A write-off's account follows its reason: Returns when lost; when paid short, Books' "Courier shortfalls" unless one is chosen.
                setValues((x) => ({ ...x, [f.key]: v, ...(type === "parcel_writeoff" && f.key === "reason" ? { account: v === "lost" ? o.defaults.returns ?? "" : o.defaults.shortfall ?? "" } : {}) }));
              }}
            >
              {f.options.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          </Field>
        );
      default:
        return null;
    }
  };

  const block = (f: FieldSpec) => {
    switch (f.kind) {
      case "lines": {
        const rows = f.key === "lines" ? lines : deductions;
        const setRows = f.key === "lines" ? setLines : setDeductions;
        const taxRates = f.taxKind ? o.rates.filter((r) => r.kind === f.taxKind) : [];
        return (
          <Card key={f.key} title={f.label}>
            {errUnder(f.key) ? <p className="text-xs font-medium text-coral-700">{errUnder(f.key)}</p> : null}
            <RowsEditor
              rows={rows}
              setRows={setRows}
              cols={LINE_COLS}
              addLabel="Add a line"
              render={(r, i, setCell) => (
                <div className={`grid gap-2 ${taxRates.length ? "md:grid-cols-[1.3fr_140px_160px_1fr]" : "md:grid-cols-[1.3fr_140px_1fr]"}`}>
                  <AccountSelect value={r.accountId ?? ""} onChange={(v) => setCell("accountId", v)} filter={f.filter} options={o} label={`Line ${i + 1} account`} />
                  <input aria-label={`Line ${i + 1} amount`} inputMode="decimal" placeholder={taxRates.length ? "Before tax" : "Amount"} className={inputClass} value={r.amount ?? ""} onChange={(e) => setCell("amount", e.target.value)} />
                  {taxRates.length ? (
                    <select aria-label={`Line ${i + 1} tax`} className={inputClass} value={r.taxRateId ?? ""} onChange={(e) => setCell("taxRateId", e.target.value)}>
                      <option value="">No tax</option>
                      {taxRates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <input aria-label={`Line ${i + 1} note`} placeholder="Note (optional)" className={inputClass} value={r.description ?? ""} onChange={(e) => setCell("description", e.target.value)} />
                </div>
              )}
            />
          </Card>
        );
      }
      case "journal":
        return (
          <Card key="journal" title={f.label}>
            {errUnder("lines") ? <p className="text-xs font-medium text-coral-700">{errUnder("lines")}</p> : null}
            <RowsEditor
              rows={journal}
              setRows={setJournal}
              cols={["accountId", "debit", "credit", "description"]}
              addLabel="Add a line"
              render={(r, i, setCell) => (
                <div className="grid gap-2 md:grid-cols-[1.3fr_130px_130px_1fr]">
                  <AccountSelect value={r.accountId ?? ""} onChange={(v) => setCell("accountId", v)} filter="any" options={o} label={`Line ${i + 1} account`} />
                  <input aria-label={`Line ${i + 1} debit`} inputMode="decimal" placeholder="Debit" className={inputClass} value={r.debit ?? ""} onChange={(e) => setCell("debit", e.target.value)} />
                  <input aria-label={`Line ${i + 1} credit`} inputMode="decimal" placeholder="Credit" className={inputClass} value={r.credit ?? ""} onChange={(e) => setCell("credit", e.target.value)} />
                  <input aria-label={`Line ${i + 1} note`} placeholder="Note (optional)" className={inputClass} value={r.description ?? ""} onChange={(e) => setCell("description", e.target.value)} />
                </div>
              )}
            />
          </Card>
        );
      case "taxLines":
        return (
          <Card key="taxLines" title={f.label}>
            <p className="text-sm text-gray-600">Each tax account with what you're settling: tax owed is paid off, claimable tax is set against it, and the difference is what leaves the bank. Filled in with today's balances.</p>
            {errUnder("lines") ? <p className="text-xs font-medium text-coral-700">{errUnder("lines")}</p> : null}
            <RowsEditor
              rows={taxLines}
              setRows={setTaxLines}
              cols={["accountId", "amount"]}
              addLabel="Add a tax account"
              render={(r, i, setCell) => (
                <div className="grid gap-2 md:grid-cols-[1.3fr_160px]">
                  <AccountSelect value={r.accountId ?? ""} onChange={(v) => setCell("accountId", v)} filter="tax" options={o} label={`Tax ${i + 1} account`} />
                  <input aria-label={`Tax ${i + 1} amount`} inputMode="decimal" className={inputClass} value={r.amount ?? ""} onChange={(e) => setCell("amount", e.target.value)} />
                </div>
              )}
            />
          </Card>
        );
      case "parcels":
        return (
          <Card key="parcels" title={f.label}>
            {errUnder("parcels") ? <p className="text-xs font-medium text-coral-700">{errUnder("parcels")}</p> : null}
            <RowsEditor
              rows={parcels}
              setRows={setParcels}
              cols={["orderName", "amount"]}
              addLabel="Add a parcel"
              render={(r, i, setCell) => (
                <div className="grid gap-2 md:grid-cols-[1fr_160px]">
                  <input aria-label={`Parcel ${i + 1} order`} placeholder="Order number, like #1234" className={inputClass} value={r.orderName ?? ""} onChange={(e) => setCell("orderName", e.target.value)} />
                  <input aria-label={`Parcel ${i + 1} amount`} inputMode="decimal" placeholder={values.reason === "lost" ? "Amount owed" : "Amount short"} className={inputClass} value={r.amount ?? ""} onChange={(e) => setCell("amount", e.target.value)} />
                </div>
              )}
            />
            {values.reason === "lost" ? (
              <Field label={`Sales tax included in it (${o.currency})`} htmlFor="taxAmount" error={err("taxAmount") ?? err("tax.amount")} help="Optional: the tax on those sales comes off what you owe the tax office too.">
                <input id="taxAmount" inputMode="decimal" className={inputClass} value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} />
              </Field>
            ) : null}
          </Card>
        );
      case "allocations":
        return (
          <Card key="allocations" title={f.label}>
            {errUnder("allocations") ? <p className="text-xs font-medium text-coral-700">{errUnder("allocations")}</p> : null}
            {!contactId ? (
              <p className="text-sm text-gray-500">Choose the supplier to see their open bills.</p>
            ) : bills.length === 0 ? (
              <p className="text-sm text-gray-500">This supplier has no bills left to pay.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {bills.map((b) => (
                  <li key={b.id} className="grid items-center gap-2 py-2 text-sm md:grid-cols-[1fr_140px_160px]">
                    <span className="text-gray-800">
                      {b.number}
                      {b.reference ? <span className="ml-1.5 text-gray-500">{b.reference}</span> : null}
                      <span className="ml-1.5 text-xs text-gray-500">{b.date}</span>
                    </span>
                    <span className="tabular-nums text-gray-600">{b.open} open</span>
                    <input aria-label={`Pay ${b.number}`} inputMode="decimal" placeholder="Paying" className={inputClass} value={alloc[b.id] ?? ""} onChange={(e) => setAlloc((a) => ({ ...a, [b.id]: e.target.value }))} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      case "withheld": {
        const rates = o.rates.filter((r) => r.kind === "withholding");
        if (rates.length === 0) return null;
        return (
          <Card key="withheld" title={f.label}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Rate" htmlFor="withheldRate" error={err("withheld.rateId")}>
                <select id="withheldRate" className={inputClass} value={withheld.rateId} onChange={(e) => setWithheld((w) => ({ ...w, rateId: e.target.value }))}>
                  <option value="">None</option>
                  {rates.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Amount (${o.currency})`} htmlFor="withheldAmount" error={err("withheld.amount")} help="Leave empty to work it out from the rate.">
                <input id="withheldAmount" inputMode="decimal" className={inputClass} value={withheld.amount} onChange={(e) => setWithheld((w) => ({ ...w, amount: e.target.value }))} disabled={!withheld.rateId} />
              </Field>
            </div>
          </Card>
        );
      }
      default:
        return null;
    }
  };

  const simple = spec.fields.filter((f) => ["account", "amount", "text", "date", "choice"].includes(f.kind));
  const blocks = spec.fields.filter((f) => !["account", "amount", "text", "date", "choice"].includes(f.kind));

  return (
    <Form method="post" className="space-y-5">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-display text-xl font-bold text-gray-900">{meta.label}</h2>
          <p className="text-sm text-gray-600">{meta.help}</p>
        </div>
        <Link to="/books/new" className="text-sm font-semibold text-accent-600">
          Something else
        </Link>
      </div>
      {general ? <Notice tone="warn">{general}</Notice> : null}

      <Card>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Date" htmlFor="date" error={err("date")}>
            <input id="date" type="date" className={inputClass} value={date} max={d.today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {spec.contact ? (
            <Field label={spec.contact.label} htmlFor="contact" error={err("contactId")} help={contactId ? undefined : "Choose one, or type a new name."}>
              <select id="contact" className={inputClass} value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">{spec.contact.required ? "Choose…" : "None"}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {!contactId ? <input aria-label="New name" placeholder="Or a new name" className={`${inputClass} mt-2`} value={newContact} onChange={(e) => setNewContact(e.target.value)} /> : null}
            </Field>
          ) : null}
          {o.stores.length > 1 ? (
            <Field label="Store" htmlFor="storeId" error={err("storeId")} help="Leave as the whole business for shared costs like rent.">
              <select id="storeId" className={inputClass} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">The whole business</option>
                {o.stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {simple.map(renderField)}
        </div>
        <Field label="Memo (optional)" htmlFor="memo">
          <input id="memo" className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
      </Card>

      {blocks.map(block)}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass} disabled={busy} onClick={() => setAsDraft(false)}>
          {busy && !asDraft ? "Saving…" : "Save to the books"}
        </button>
        <button type="submit" className={quietButtonClass} disabled={busy} onClick={() => setAsDraft(true)}>
          Keep as a draft
        </button>
        {actionData && "draftId" in actionData && actionData.draftId ? (
          <Link to={`/books/entries/${actionData.draftId}`} className="text-sm font-semibold text-accent-600">
            It was kept as a draft — open it
          </Link>
        ) : null}
      </div>
    </Form>
  );
}
