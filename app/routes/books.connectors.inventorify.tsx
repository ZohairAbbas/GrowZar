import type { Prisma } from "@prisma/client";
import { Form, useNavigation } from "react-router";
import { Play } from "lucide-react";

import type { Route } from "./+types/books.connectors.inventorify";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { inventorifyStores, parseInventorifyForm, runInventorify, type InventorifySettings } from "~/lib/books-app/connectors/inventorify.server";
import { getConnector, listRuns, runConnector, saveConnector } from "~/lib/books-app/connectors/runs.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { BooksError } from "~/lib/books/books.server";
import { formatDate, todayIn } from "~/lib/books/dates";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Inventorify · Books · Growzar" }];
}

/**
 * Goods received and the supplier ledger from Inventorify (B3, D-88): each
 * delivery becomes a supplier bill; payments made in Inventorify are listed to
 * match against the bank, never posted twice.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const [connector, stores, runs] = await Promise.all([getConnector(book, "inventorify"), inventorifyStores(book), listRuns(book, "inventorify")]);
  const s = connector.settings as InventorifySettings;
  const accountant = isAccountantRole(viewer.role);
  return {
    canManage,
    connector: { ...connector, startDate: connector.startDate ?? book.settings.startDate ?? todayIn(book.settings.timeZone) },
    stores,
    payments: (s.payments ?? []).slice(0, 50).map((p) => ({ ...p, date: formatDate(p.date), amount: money(book, BigInt(p.amount), accountant) })),
    runs: runs.map((r) => ({ id: r.id, at: r.startedAt.toISOString(), status: r.status, message: r.message })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "run") {
      const r = await runConnector(book, "inventorify", "manual", (b, c) => runInventorify(b, c));
      return r ? { ok: r.status === "ok" ? "Inventorify is up to date." : "Done, with notes below." } : { error: "Inventorify is off, or already being brought in.", field: "" };
    }
    if (intent !== "save") return { error: "Nothing to do.", field: "" };
    const previous = await getConnector(book, "inventorify");
    const input = await parseInventorifyForm(book, previous, { enabled: form.get("enabled") === "on", mode: String(form.get("mode") ?? "draft"), startDate: String(form.get("startDate") ?? "") }, todayIn(book.settings.timeZone));
    const drafts = await saveConnector(book, "inventorify", { ...input, settings: input.settings as unknown as Prisma.InputJsonValue }, viewer.userId);
    return { ok: drafts ? `Saved. ${drafts.posted} waiting draft(s) saved to the books${drafts.left ? `, ${drafts.left} couldn't be` : ""}.` : "Saved." };
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

export default function InventorifyConnector({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const err = (f: string) => (actionData && "error" in actionData && actionData.field === f ? actionData.error : null);
  const c = d.connector;
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData && actionData.field !== "startDate" ? <Notice tone="warn">{actionData.error}</Notice> : null}

      <Card
        title="Goods received (Inventorify)"
        aside={
          c.enabled && d.canManage ? (
            <Form method="post">
              <button type="submit" name="intent" value="run" className={quietButtonClass} disabled={busy || c.running}>
                <Play className="h-3.5 w-3.5" /> {c.running ? "Bringing it in…" : "Bring in now"}
              </button>
            </Form>
          ) : null
        }
      >
        <p className="text-sm text-gray-600">
          Each delivery against a purchase order becomes a supplier bill: good units into Stock, damaged ones held until the supplier's claim settles. Supplier credits and adjustments follow. Payments you make in Inventorify aren't posted twice; they're listed below to match with your bank.
        </p>
        <ul className="space-y-1 text-sm">
          {d.stores.map((s) => (
            <li key={s.id} className="text-gray-700">
              {s.name}: {s.feeds ? "goods received available" : s.connected ? "Inventorify needs an update for this" : "Inventorify isn't connected"}
            </li>
          ))}
        </ul>
        {c.exists && c.lastMessage ? <p className="text-sm text-gray-500">Last run: {c.lastMessage}</p> : null}
      </Card>

      {d.canManage ? (
        <Form method="post" className="space-y-5">
          <input type="hidden" name="intent" value="save" />
          <Card title="Settings">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Bring in from" htmlFor="startDate" error={err("startDate")}>
                <input id="startDate" name="startDate" type="date" defaultValue={c.startDate} className={inputClass} />
              </Field>
              <Field label="New bills arrive as" htmlFor="mode">
                <select id="mode" name="mode" defaultValue={c.mode} className={inputClass}>
                  <option value="draft">Drafts you check and save</option>
                  <option value="auto">Saved to the books automatically</option>
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 md:mt-8">
                <input type="checkbox" name="enabled" defaultChecked={c.enabled || !c.exists} className="h-4 w-4" /> Bring in goods received
              </label>
            </div>
            <p className="text-xs text-gray-500">Books adds "Damaged stock awaiting supplier claims" and "Purchase differences and charges" the first time it needs them.</p>
          </Card>
          <button type="submit" className={buttonClass} disabled={busy}>
            Save
          </button>
        </Form>
      ) : null}

      {d.payments.length ? (
        <Card title="Payments recorded in Inventorify">
          <ul className="divide-y divide-gray-100 text-sm">
            {d.payments.map((p) => (
              <li key={p.id} className="grid gap-1 py-2 md:grid-cols-[110px_1fr_140px]">
                <span className="text-gray-500">{p.date}</span>
                <span className="text-gray-800">
                  {p.kind === "refund" ? "Refund from" : "Paid to"} {p.supplierName}
                  {p.reference ? <span className="ml-1.5 text-xs text-gray-500">{p.reference}</span> : null}
                </span>
                <span className="text-right tabular-nums">{p.amount}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {d.runs.length ? (
        <Card title="Recent runs">
          <ul className="divide-y divide-gray-100 text-sm">
            {d.runs.map((r) => (
              <li key={r.id} className="grid gap-1 py-2 md:grid-cols-[170px_80px_1fr]">
                <span className="text-gray-500">{new Date(r.at).toLocaleString("en-GB")}</span>
                <span className={r.status === "ok" ? "text-mint-700" : r.status === "partial" ? "text-gray-700" : "text-coral-700"}>{r.status === "ok" ? "Done" : r.status === "partial" ? "With notes" : r.status === "running" ? "Running" : "Failed"}</span>
                <span className="text-gray-700">{r.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
