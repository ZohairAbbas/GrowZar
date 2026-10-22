import type { Prisma } from "@prisma/client";
import { Form, useNavigation } from "react-router";
import { Play } from "lucide-react";

import type { Route } from "./+types/books.connectors.courier-payouts";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import type { PayoutMapping } from "~/lib/books-app/connectors/courier-payouts";
import { parsePayoutForm, payoutDefaults, payoutStores, runCourierPayouts, type CourierPayoutSettings } from "~/lib/books-app/connectors/courier-payouts.server";
import { getConnector, listRuns, runConnector, saveConnector } from "~/lib/books-app/connectors/runs.server";
import { BooksError, listAccounts } from "~/lib/books/books.server";
import { isMoneySubtype } from "~/lib/books/chart";
import { formatDate, todayIn } from "~/lib/books/dates";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Courier payouts · Books · Growzar" }];
}

/**
 * Courier payouts into the books (B3, D-86, D-87, D-92): what arrived, what
 * the courier kept by kind, money kept back for later, and the part of a
 * shared batch that isn't this store's.
 */
const FIELDS: Array<{ key: keyof PayoutMapping; label: string; help?: string; kind: "receivable" | "money" | "cost" }> = [
  { key: "receivable", label: "What couriers owe you", kind: "receivable" },
  { key: "receivedIn", label: "Payouts arrive in", kind: "money" },
  { key: "delivery", label: "Delivery and COD charges", kind: "cost" },
  { key: "returns", label: "Return charges", kind: "cost" },
  { key: "tax", label: "Tax the courier withheld", help: "A cost, or \"Tax you can claim back\" if you claim it.", kind: "cost" },
  { key: "other", label: "Other charges", kind: "cost" },
];

export async function loader({ request }: Route.LoaderArgs) {
  const { book, canManage } = await requireBook(request, "view");
  const [connector, defaults, stores, accounts, runs] = await Promise.all([getConnector(book, "courierify_payouts"), payoutDefaults(book), payoutStores(book), listAccounts(book), listRuns(book, "courierify_payouts")]);
  const saved = connector.exists ? (connector.settings as unknown as CourierPayoutSettings).mapping : defaults;
  const live = accounts.filter((a) => !a.archived && !a.currency);
  const option = (a: (typeof live)[number]) => ({ id: a.id, name: `${a.code} · ${a.name}` });
  return {
    canManage,
    connector: { ...connector, startDate: connector.startDate ?? book.settings.startDate ?? todayIn(book.settings.timeZone) },
    mapping: saved,
    stores,
    options: {
      receivable: live.filter((a) => a.type === "asset" && a.subtype === "receivable").map(option),
      money: live.filter((a) => isMoneySubtype(a.subtype)).map(option),
      cost: live.filter((a) => a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype) && a.subtype !== "receivable")).map(option),
    },
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
      const r = await runConnector(book, "courierify_payouts", "manual", (b, c) => runCourierPayouts(b, c));
      return r ? { ok: r.status === "ok" ? "Courier payouts are up to date." : "Done, with notes below." } : { error: "Courier payouts are off, or already being brought in.", field: "" };
    }
    if (intent !== "save") return { error: "Nothing to do.", field: "" };
    const mapping = Object.fromEntries(FIELDS.map((f) => [f.key, String(form.get(f.key) ?? "")])) as unknown as PayoutMapping;
    const previous = await getConnector(book, "courierify_payouts");
    const input = await parsePayoutForm(book, previous, { enabled: form.get("enabled") === "on", mode: String(form.get("mode") ?? "draft"), startDate: String(form.get("startDate") ?? ""), mapping }, todayIn(book.settings.timeZone));
    const drafts = await saveConnector(book, "courierify_payouts", { ...input, settings: input.settings as unknown as Prisma.InputJsonValue }, viewer.userId);
    return { ok: drafts ? `Saved. ${drafts.posted} waiting draft(s) saved to the books${drafts.left ? `, ${drafts.left} couldn't be` : ""}.` : "Saved." };
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

export default function CourierPayoutsConnector({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const err = (f: string) => (actionData && "error" in actionData && actionData.field === f ? actionData.error : null);
  const c = d.connector;
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData && !/^(startDate|mapping\.)/.test(actionData.field ?? "") ? <Notice tone="warn">{actionData.error}</Notice> : null}

      <Card
        title="Courier payouts"
        aside={
          c.enabled && d.canManage ? (
            <Form method="post">
              <button type="submit" name="intent" value="run" className={quietButtonClass} disabled={busy || c.running}>
                <Play className="h-3.5 w-3.5" /> {c.running ? "Bringing them in…" : "Bring in now"}
              </button>
            </Form>
          ) : null
        }
      >
        <p className="text-sm text-gray-600">
          Each payout from Courierify: what reached you, what the courier kept for delivery, returns and tax, and what it kept back for a later payout. Where a courier account is shared with another business, only your parcels come off what couriers owe you; the rest is held apart.
        </p>
        <ul className="space-y-1 text-sm">
          {d.stores.map((s) => (
            <li key={s.id} className="text-gray-700">
              {s.name}: {s.lines ? "payout details available" : s.connected ? "Courierify connected, payout details not available yet" : "Courierify isn't connected"}
            </li>
          ))}
        </ul>
        {c.exists ? (
          <p className="text-sm text-gray-500">
            {c.enabled ? "On" : "Off"}
            {c.lastMessage ? `. Last run: ${c.lastMessage}` : ""}
          </p>
        ) : null}
      </Card>

      {d.canManage ? (
        <Form method="post" className="space-y-5">
          <input type="hidden" name="intent" value="save" />
          <Card title="Settings">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Bring in payouts from" htmlFor="startDate" error={err("startDate")} help="Payouts before this day are part of your opening balances.">
                <input id="startDate" name="startDate" type="date" defaultValue={c.startDate} className={inputClass} />
              </Field>
              <Field label="New payouts arrive as" htmlFor="mode">
                <select id="mode" name="mode" defaultValue={c.mode} className={inputClass}>
                  <option value="draft">Drafts you check and save</option>
                  <option value="auto">Saved to the books automatically</option>
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 md:mt-8">
                <input type="checkbox" name="enabled" defaultChecked={c.enabled || !c.exists} className="h-4 w-4" /> Bring in courier payouts
              </label>
            </div>
          </Card>
          <Card title="Accounts">
            <div className="grid gap-4 md:grid-cols-2">
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={f.key} error={err(`mapping.${f.key}`)} help={f.help}>
                  <select id={f.key} name={f.key} defaultValue={d.mapping[f.key]} className={inputClass}>
                    <option value="">Choose…</option>
                    {d.options[f.kind].map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <p className="text-xs text-gray-500">Books adds "Held by courier", "Courier charges not explained" and "Courier money not for your orders" the first time a payout needs them.</p>
          </Card>
          <button type="submit" className={buttonClass} disabled={busy}>
            Save
          </button>
        </Form>
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
      {c.syncedThrough ? <p className="text-xs text-gray-500">Last brought in {formatDate(c.syncedThrough)}.</p> : null}
    </div>
  );
}
