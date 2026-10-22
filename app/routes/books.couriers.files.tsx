import { useState } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/books.couriers.files";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { minimiseSheet } from "~/lib/books-app/statement";
import { BooksError, listAccounts } from "~/lib/books/books.server";
import { isMoneySubtype } from "~/lib/books/chart";
import { listCourierSheets, loadsheetProgress, previewLoadsheet, previewSettlement, recordLoadsheet, recordSettlement, removeLoadsheet, undoSettlement } from "~/lib/books/courier-sheets.server";
import { formatDate, todayIn } from "~/lib/books/dates";
import { StatementFileError, statementFileToCsv } from "~/lib/books/statement-file";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Courier files · Books · Growzar" }];
}

/**
 * Couriers' own files (B5b): a settlement file (a payment report) becomes one
 * "Courier paid me" per account and store, its parcels marked paid or
 * returned; a loadsheet dates when parcels were handed over. For couriers
 * whose payouts don't come through Courierify. The file is read in the
 * browser and only the columns Books uses are sent: buyers' names, phones and
 * addresses never leave the page (D-72's rule).
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const kind = url.searchParams.get("kind") === "loadsheet" ? ("loadsheet" as const) : ("settlement" as const);
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const [sheets, progress, accounts] = await Promise.all([
    kind === "settlement" ? listCourierSheets(book, "settlement") : Promise.resolve([]),
    kind === "loadsheet" ? loadsheetProgress(book) : Promise.resolve([]),
    listAccounts(book),
  ]);
  return {
    kind,
    canManage,
    today: todayIn(book.settings.timeZone),
    money: accounts.filter((a) => !a.archived && !a.currency && isMoneySubtype(a.subtype)).map((a) => ({ id: a.id, name: a.name })),
    settlements: sheets.map((s) => ({ id: s.id, courier: s.courier, ref: s.ref, date: formatDate(s.date), fileName: s.fileName, number: s.documentNumber, documentId: s.documentId, cancelled: s.cancelled })),
    loadsheets: progress.map((p) => ({ id: p.id, courier: p.courier, ref: p.ref, date: formatDate(p.date), parcels: p.parcels, cod: m(p.cod), counts: p.counts })),
  };
}

export async function action({ request, url }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "");
  const kind = url.searchParams.get("kind") === "loadsheet" ? "loadsheet" : "settlement";
  const fmt = (v: bigint) => money(book, v, false);
  try {
    switch (str("intent")) {
      case "preview": {
        if (kind === "settlement") {
          const p = await previewSettlement(book, { text: str("text"), courier: str("courier"), ref: str("ref") });
          return {
            preview: {
              lines: p.lines.length,
              matched: p.matched,
              unmatched: p.unmatched.count,
              alreadyPaid: p.alreadyPaid.count,
              delivered: p.totals.delivered,
              returned: p.totals.returned,
              collected: fmt(p.totals.collected),
              kept: fmt(p.totals.delivery + p.totals.returnFee + p.totals.salesTax + p.totals.withheld + p.totals.otherFees),
              net: fmt(p.totals.net),
              unexplained: p.totals.unexplained !== 0n ? fmt(p.totals.unexplained) : null,
              short: p.short.count ? `${p.short.count} paid short by ${fmt(p.short.amount)}` : null,
              duplicate: !!p.duplicateOf,
              date: p.date,
              ref: p.ref,
              problems: p.problems.slice(0, 5),
            },
          };
        }
        const p = await previewLoadsheet(book, { text: str("text"), courier: str("courier"), ref: str("ref") });
        return { preview: { lines: p.parcels, matched: p.matched, unmatched: p.unmatched, again: p.again, cod: fmt(p.cod), differs: p.differs.count, duplicate: !!p.duplicateOf, date: p.date, ref: p.ref, problems: p.problems.slice(0, 5) } };
      }
      case "record": {
        if (kind === "settlement") {
          const r = await recordSettlement(book, { text: str("text"), fileName: str("fileName") || null, courier: str("courier"), ref: str("ref"), date: str("date"), receivedIn: str("receivedIn"), unmatched: str("unmatched") === "apart" ? "apart" : "owed", formKey: str("formKey") }, viewer.userId);
          return { ok: r.again ? "Already recorded." : `Recorded as ${r.documents.map((x) => x.number).join(", ")}${r.skipped ? `; ${r.skipped} parcels already paid were left out` : ""}.` };
        }
        await recordLoadsheet(book, { text: str("text"), fileName: str("fileName") || null, courier: str("courier"), ref: str("ref"), date: str("date"), formKey: str("formKey") }, viewer.userId);
        return { ok: "Loadsheet recorded." };
      }
      case "undo":
        await undoSettlement(book, str("id"), viewer.userId);
        return { ok: "Settlement undone: its payout is cancelled and its parcels are owed again." };
      case "remove":
        await removeLoadsheet(book, str("id"));
        return { ok: "Loadsheet removed." };
      default:
        return { error: "Nothing to do." };
    }
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message };
    throw e;
  }
}

export default function CourierFiles({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [formKey] = useState(() => `cf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const settlement = d.kind === "settlement";
  const preview = actionData && "preview" in actionData ? actionData.preview : null;

  const onFile = async (f: File | undefined) => {
    setFileError(null);
    setText("");
    if (!f) return;
    try {
      const csv = (await statementFileToCsv(f.name, new Uint8Array(await f.arrayBuffer()))).text;
      const small = minimiseSheet(csv, d.kind);
      if (!small) return setFileError("Couldn't find a tracking number or order number column, so the rows can't be matched to your orders.");
      setText(small);
      setFileName(f.name);
    } catch (e) {
      setFileError(e instanceof StatementFileError ? e.message : "This file couldn't be read. Save it as CSV and try again.");
    }
  };

  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      <h2 className="font-display text-xl font-bold text-gray-900">{settlement ? "Courier settlement files" : "Loadsheets"}</h2>
      {d.canManage ? (
        <Form method="post" className="space-y-5">
          <input type="hidden" name="text" value={text} />
          <input type="hidden" name="fileName" value={fileName} />
          <input type="hidden" name="formKey" value={formKey} />
          <Card>
            <p className="text-sm text-gray-600">
              {settlement
                ? "A courier's payment report: each parcel it paid for, came back, or charged. For couriers whose payouts don't come through Courierify."
                : "The list of parcels handed to the courier on a day. With sales counted when dispatched, they count from that day."}{" "}
              Only the tracking, order, status, amount, date and reference columns are sent; buyers' details stay on this page.
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="File" htmlFor="file" error={fileError}>
                <input id="file" type="file" accept=".csv,.txt,.xlsx,.xls,.xml,.htm,.html" className={inputClass} onChange={(e) => void onFile(e.target.files?.[0])} />
              </Field>
              <Field label="Courier" htmlFor="courier">
                <input id="courier" name="courier" required className={inputClass} placeholder="PostEx, Leopards, TCS…" />
              </Field>
              <Field label={settlement ? "Payment number (if any)" : "Loadsheet number (if any)"} htmlFor="ref">
                <input id="ref" name="ref" defaultValue={preview?.ref ?? ""} className={inputClass} />
              </Field>
              <Field label={settlement ? "Paid on" : "Handed over on"} htmlFor="date">
                <input id="date" name="date" type="date" defaultValue={preview?.date ?? d.today} max={d.today} className={inputClass} />
              </Field>
              {settlement ? (
                <>
                  <Field label="Money arrived in" htmlFor="receivedIn">
                    <select id="receivedIn" name="receivedIn" className={inputClass}>
                      {d.money.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Parcels not in your orders" htmlFor="unmatched">
                    <select id="unmatched" name="unmatched" className={inputClass}>
                      <option value="owed">From before your books: take off what couriers owe</option>
                      <option value="apart">Not yours: hold apart</option>
                    </select>
                  </Field>
                </>
              ) : null}
            </div>
            <div className="flex gap-3">
              <button type="submit" name="intent" value="preview" className={quietButtonClass} disabled={busy || !text}>Check the file</button>
              <button type="submit" name="intent" value="record" className={buttonClass} disabled={busy || !text || !preview || preview.duplicate}>Record it</button>
            </div>
          </Card>
          {preview ? (
            <Card title="What's in it">
              {preview.duplicate ? <Notice tone="warn">This {settlement ? "settlement" : "loadsheet"} is already in your books.</Notice> : null}
              <ul className="space-y-1 text-sm text-gray-700">
                <li>{preview.lines} parcels; {preview.matched} matched to your orders, {preview.unmatched} not</li>
                {"delivered" in preview ? (
                  <>
                    <li>{preview.delivered} delivered, {preview.returned} came back{preview.alreadyPaid ? `; ${preview.alreadyPaid} already paid in your books (left out)` : ""}</li>
                    <li>Collected {preview.collected}, kept {preview.kept}, paid {preview.net}</li>
                    {preview.unexplained ? <li className="text-coral-700">The file's own sums are off by {preview.unexplained}: that goes to "Courier shortfalls"</li> : null}
                    {preview.short ? <li>{preview.short}</li> : null}
                  </>
                ) : (
                  <li>COD {preview.cod}{preview.again ? `; ${preview.again} already on an earlier loadsheet` : ""}{preview.differs ? `; ${preview.differs} with a COD different from the order` : ""}</li>
                )}
                {preview.problems.map((p, i) => (
                  <li key={i} className="text-xs text-coral-700">{p}</li>
                ))}
              </ul>
            </Card>
          ) : null}
        </Form>
      ) : null}

      {settlement ? (
        <Card title="Recorded">
          {d.settlements.length === 0 ? <p className="text-sm text-gray-500">None yet.</p> : null}
          <ul className="divide-y divide-gray-100">
            {d.settlements.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="flex-1">{s.date} · {s.courier}{s.ref ? ` · ${s.ref}` : ""}{s.number ? ` · ${s.number}` : ""}{s.cancelled ? " · cancelled" : ""}</span>
                {d.canManage && !s.cancelled ? (
                  <Form method="post">
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" name="intent" value="undo" className={quietButtonClass} disabled={busy}>Undo</button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card title="Recorded loadsheets">
          {d.loadsheets.length === 0 ? <p className="text-sm text-gray-500">None yet.</p> : null}
          <ul className="divide-y divide-gray-100">
            {d.loadsheets.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="flex-1">
                  {s.date} · {s.courier}{s.ref ? ` · ${s.ref}` : ""} · {s.parcels} parcels, {s.cod}: {s.counts.paid} paid, {s.counts.delivered} delivered, {s.counts.returned} back, {s.counts.moving} on the way{s.counts.loose ? `, ${s.counts.loose} not matched yet` : ""}
                </span>
                {d.canManage ? (
                  <Form method="post">
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" name="intent" value="remove" className={quietButtonClass} disabled={busy}>Remove</button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
