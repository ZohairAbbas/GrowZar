import { useMemo, useState } from "react";
import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/books.bank.import";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { minimiseStatement } from "~/lib/books-app/statement";
import { importStatement } from "~/lib/books/bank.server";
import { BooksError, listAccounts, updateBookSettings } from "~/lib/books/books.server";
import { isMoneySubtype } from "~/lib/books/chart";
import { formatDate } from "~/lib/books/dates";
import { formatAmount } from "~/lib/books/money";
import { DATE_FORMATS, MAX_STATEMENT_BYTES, guessMapping, parseCsv, readStatement, type StatementMapping } from "~/lib/books/statement-csv";
import { StatementFileError, statementFileToCsv } from "~/lib/books/statement-file";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Import a statement · Books · Growzar" }];
}

/**
 * Importing a statement (B5, D-72). The file (CSV, Excel .xlsx, or the HTML
 * ".xls" many banks export) is read here in the browser; the columns are
 * guessed, or taken from the last statement of the same account; only the
 * columns used are sent, with account and card numbers already hidden. The
 * file itself never leaves this page. Lines already imported are skipped.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const accounts = (await listAccounts(book)).filter((a) => isMoneySubtype(a.subtype) && !a.currency);
  return {
    decimals: book.decimals,
    currency: book.currency,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    account: url.searchParams.get("account") ?? accounts[0]?.id ?? "",
    remembered: book.settings.statementMappings ?? {},
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const accountId = String(form.get("accountId") ?? "");
  try {
    let mapping: unknown;
    let remember: StatementMapping | null = null;
    try {
      mapping = JSON.parse(String(form.get("mapping") ?? ""));
      remember = JSON.parse(String(form.get("remember") ?? "null")) as StatementMapping | null;
    } catch {
      return { error: "Something went wrong sending the statement. Try again.", field: "" };
    }
    const r = await importStatement(book, { accountId, fileName: String(form.get("fileName") ?? "") || null, text: String(form.get("text") ?? ""), mapping }, viewer.userId);
    // The columns as chosen on the full file, offered for this account's next statement.
    if (remember) await updateBookSettings(book, (cur) => ({ statementMappings: { ...(cur.statementMappings ?? {}), [accountId]: remember! } }));
    const q = new URLSearchParams({ added: String(r.added), duplicates: String(r.duplicates), problems: String(r.problemCount), possible: String(r.possibleDuplicates ?? 0) });
    throw redirect(`/books/bank/${accountId}?${q.toString()}`);
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

const NONE = "";

export default function ImportStatement({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [accountId, setAccountId] = useState(d.account);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<StatementMapping | null>(null);
  const rows = useMemo(() => (file ? parseCsv(file.text) : []), [file]);
  const read = useMemo(() => (mapping ? readStatement(rows, mapping, d.decimals) : null), [rows, mapping, d.decimals]);
  const sent = useMemo(() => (mapping ? minimiseStatement(rows, mapping) : null), [rows, mapping]);
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  const header = mapping && mapping.headerRow >= 0 ? rows[mapping.headerRow] ?? [] : [];
  const cols = [...Array(width).keys()].map((i) => ({ value: String(i), label: header[i] ? `${header[i]} (column ${i + 1})` : `Column ${i + 1}` }));
  const set = (patch: Partial<StatementMapping>) => setMapping((m) => (m ? { ...m, ...patch } : m));
  const num = (v: string) => (v === NONE ? null : Number(v));
  const fmt = (v: bigint) => formatAmount(v, d.decimals, { trimZeroFraction: false });

  const onFile = async (f: File | undefined) => {
    setFileError(null);
    setFile(null);
    setMapping(null);
    if (!f) return;
    if (f.size > MAX_STATEMENT_BYTES * 4) return setFileError("That file is too large. Export a shorter period.");
    let text: string;
    try {
      text = (await statementFileToCsv(f.name, new Uint8Array(await f.arrayBuffer()))).text;
    } catch (e) {
      return setFileError(e instanceof StatementFileError ? e.message : "This file couldn't be read. Save the statement as CSV and try again.");
    }
    const parsed = parseCsv(text);
    // This account's last columns, when the new file has the same header; else a fresh guess.
    const last = (d.remembered as Record<string, StatementMapping>)[accountId];
    const sameHeader = last && last.headerRow >= 0 && parsed[last.headerRow] && parsed[last.headerRow]!.length >= Math.max(last.dateCol, ...last.descCols, last.amountCol ?? 0, last.outCol ?? 0, last.inCol ?? 0, last.balanceCol ?? 0) + 1;
    setFile({ name: f.name, text });
    setMapping(sameHeader ? last! : guessMapping(parsed));
  };

  const Col = ({ label, value, onChange, optional }: { label: string; value: number | null; onChange: (v: number | null) => void; optional?: boolean }) => (
    <Field label={label}>
      <select className={inputClass} value={value === null ? NONE : String(value)} onChange={(e) => onChange(num(e.target.value))}>
        {optional ? <option value={NONE}>None</option> : null}
        {cols.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <Form method="post" className="space-y-5">
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      <Card title="Import a statement">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Account" htmlFor="accountId">
            <select id="accountId" name="accountId" className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {d.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Statement file" htmlFor="file" error={fileError} help="CSV, Excel (.xlsx) or the .xls many banks export. PDFs can't be read: export CSV or Excel instead.">
            <input id="file" type="file" accept=".csv,.txt,.xlsx,.xls,.xml,.htm,.html" className={inputClass} onChange={(e) => void onFile(e.target.files?.[0])} />
          </Field>
        </div>
        <p className="text-xs text-gray-500">The file is read here, in your browser. Only the date, description, amount and balance columns are sent, with account and card numbers hidden; the file itself is never kept.</p>
      </Card>

      {file && !mapping ? <Notice tone="warn">Books couldn't find the columns in this file. Check it's a statement with dates and amounts.</Notice> : null}

      {mapping ? (
        <Card title="Columns">
          <div className="grid gap-4 md:grid-cols-3">
            <Col label="Date" value={mapping.dateCol} onChange={(v) => set({ dateCol: v ?? 0 })} />
            <Field label="Dates are written">
              <select className={inputClass} value={mapping.dateFormat} onChange={(e) => set({ dateFormat: e.target.value as StatementMapping["dateFormat"] })}>
                {DATE_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            <Col label="Description" value={mapping.descCols[0] ?? 0} onChange={(v) => set({ descCols: [v ?? 0] })} />
            <Col label="Amount (one column)" value={mapping.amountCol} onChange={(v) => set({ amountCol: v })} optional />
            <Col label="Money out" value={mapping.outCol} onChange={(v) => set({ outCol: v })} optional />
            <Col label="Money in" value={mapping.inCol} onChange={(v) => set({ inCol: v })} optional />
            <Col label="Balance" value={mapping.balanceCol} onChange={(v) => set({ balanceCol: v })} optional />
            <label className="flex items-center gap-2 text-sm text-gray-700 md:mt-8">
              <input type="checkbox" className="h-4 w-4" checked={mapping.flip} onChange={(e) => set({ flip: e.target.checked })} /> Money out shows as positive
            </label>
          </div>
        </Card>
      ) : null}

      {read ? (
        <Card title={`${read.lines.length} line${read.lines.length === 1 ? "" : "s"} read${read.problems.length ? `, ${read.problems.length} couldn't be` : ""}`}>
          {read.problems.length ? <p className="text-xs text-coral-700">Row {read.problems[0]!.row}: {read.problems[0]!.message}</p> : null}
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {read.lines.slice(0, 8).map((l, i) => (
                <tr key={i}>
                  <td className="py-1 text-gray-500">{formatDate(l.date)}</td>
                  <td className="py-1 text-gray-800">{l.description}</td>
                  <td className={`py-1 text-right tabular-nums ${l.amount < 0n ? "text-coral-700" : ""}`}>{fmt(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sent ? (
            <>
              <input type="hidden" name="text" value={sent.text} />
              <input type="hidden" name="mapping" value={JSON.stringify(sent.mapping)} />
              <input type="hidden" name="remember" value={JSON.stringify(mapping)} />
              <input type="hidden" name="fileName" value={file?.name ?? ""} />
            </>
          ) : null}
          <button type="submit" className={buttonClass} disabled={busy || read.lines.length === 0}>
            {busy ? "Importing…" : `Import ${read.lines.length} line${read.lines.length === 1 ? "" : "s"}`}
          </button>
        </Card>
      ) : null}
    </Form>
  );
}
