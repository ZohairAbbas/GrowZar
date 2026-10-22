import type { Prisma } from "@prisma/client";
import { Form, useNavigation } from "react-router";
import { Play } from "lucide-react";

import type { Route } from "./+types/books.connectors.ad-spend";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { platformName, type AdSpendSettings } from "~/lib/books-app/connectors/ad-spend";
import { adPlatforms, adSpendDefaults, parseAdSpendForm, runAdSpend } from "~/lib/books-app/connectors/ad-spend.server";
import { getConnector, listRuns, runConnector, saveConnector } from "~/lib/books-app/connectors/runs.server";
import { BooksError, listAccounts } from "~/lib/books/books.server";
import { isMoneySubtype } from "~/lib/books/chart";
import { formatDate, todayIn } from "~/lib/books/dates";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Ad spend · Books · Growzar" }];
}

/**
 * Ad spend into the books (B3): which accounts each platform's spend, its
 * taxes and charges, and its payment go to; drafts or automatic; from which
 * day. Later corrections post as their own entries (D-74, D-84).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { book, canManage } = await requireBook(request, "view");
  const [connector, defaults, platforms, accounts, runs] = await Promise.all([getConnector(book, "ad_spend"), adSpendDefaults(book), adPlatforms(book), listAccounts(book), listRuns(book, "ad_spend")]);
  const saved = connector.exists ? (connector.settings as unknown as AdSpendSettings) : defaults;
  const live = accounts.filter((a) => !a.archived && !a.currency);
  const option = (a: (typeof live)[number]) => ({ id: a.id, name: `${a.code} · ${a.name}` });
  return {
    canManage,
    connector: { ...connector, startDate: connector.startDate ?? book.settings.startDate ?? todayIn(book.settings.timeZone) },
    platforms: [...new Set([...platforms, ...Object.keys(saved.platforms ?? {})])].map((p) => ({ key: p, name: platformName(p), mapping: saved.platforms?.[p] ?? defaults.platforms[p] ?? { advertising: "", fees: "", paidFrom: "" } })),
    expense: live.filter((a) => a.type === "expense").map(option),
    fees: live.filter((a) => a.type === "expense" || (a.type === "asset" && !isMoneySubtype(a.subtype))).map(option),
    paidFrom: live.filter((a) => isMoneySubtype(a.subtype) || (a.type === "liability" && a.subtype === "payable")).map(option),
    runs: runs.map((r) => ({ id: r.id, at: r.startedAt.toISOString(), status: r.status, trigger: r.trigger, message: r.message })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "run") {
      const r = await runConnector(book, "ad_spend", "manual", runAdSpend);
      return r ? { ok: r.status === "ok" ? "Ad spend is up to date." : "Done, with notes below." } : { error: "Ad spend is off, or already being brought in.", field: "" };
    }
    if (intent !== "save") return { error: "Nothing to do.", field: "" };
    const platforms: AdSpendSettings["platforms"] = {};
    for (const p of form.getAll("platform").map(String)) {
      platforms[p] = { advertising: String(form.get(`${p}.advertising`) ?? ""), fees: String(form.get(`${p}.fees`) ?? ""), paidFrom: String(form.get(`${p}.paidFrom`) ?? "") };
    }
    const today = todayIn(book.settings.timeZone);
    const input = await parseAdSpendForm(book, { enabled: form.get("enabled") === "on", mode: String(form.get("mode") ?? "draft"), startDate: String(form.get("startDate") ?? ""), platforms }, today);
    const drafts = await saveConnector(book, "ad_spend", { ...input, settings: input.settings as unknown as Prisma.InputJsonValue }, viewer.userId);
    return { ok: drafts ? `Saved. ${drafts.posted} waiting draft(s) saved to the books${drafts.left ? `, ${drafts.left} couldn't be` : ""}.` : "Saved." };
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

function AccountSelect({ name, value, options, label }: { name: string; value: string; options: Array<{ id: string; name: string }>; label: string }) {
  return (
    <select name={name} defaultValue={value} aria-label={label} className={inputClass}>
      <option value="">Choose…</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export default function AdSpendConnector({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const err = (f: string) => (actionData && "error" in actionData && actionData.field === f ? actionData.error : null);
  const c = d.connector;
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData && !/^(startDate|platforms\.)/.test(actionData.field ?? "") ? <Notice tone="warn">{actionData.error}</Notice> : null}

      <Card
        title="Ad spend"
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
          Each store's spend per platform per day, with the taxes and charges Financify adds, exactly as Finance shows it. When a platform later corrects a day you've saved, the difference comes in as its own entry, dated on that day while its month is open.
        </p>
        {c.exists ? (
          <p className="text-sm text-gray-500">
            {c.enabled ? "On" : "Off"}
            {c.syncedThrough ? `, brought in through ${formatDate(c.syncedThrough)}` : ""}
            {c.lastMessage ? `. Last run: ${c.lastMessage}` : ""}
          </p>
        ) : null}
      </Card>

      {d.canManage ? (
        <Form method="post" className="space-y-5">
          <input type="hidden" name="intent" value="save" />
          <Card title="Settings">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Bring in from" htmlFor="startDate" error={err("startDate")}>
                <input id="startDate" name="startDate" type="date" defaultValue={c.startDate} className={inputClass} />
              </Field>
              <Field label="New days arrive as" htmlFor="mode">
                <select id="mode" name="mode" defaultValue={c.mode} className={inputClass}>
                  <option value="draft">Drafts you check and save</option>
                  <option value="auto">Saved to the books automatically</option>
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 md:mt-8">
                <input type="checkbox" name="enabled" defaultChecked={c.enabled || !c.exists} className="h-4 w-4" /> Bring in ad spend
              </label>
            </div>
          </Card>

          {d.platforms.length === 0 ? <Notice>None of your stores has ad spend in Growzar yet. Connect Meta, TikTok, Google or Snapchat in Financify.</Notice> : null}
          {d.platforms.map((p) => (
            <Card key={p.key} title={p.name}>
              <input type="hidden" name="platform" value={p.key} />
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Spend goes to" error={err(`platforms.${p.key}.advertising`)}>
                  <AccountSelect name={`${p.key}.advertising`} value={p.mapping.advertising} options={d.expense} label={`${p.name} spend account`} />
                </Field>
                <Field label="Taxes and charges go to" error={err(`platforms.${p.key}.fees`)} help="A cost, or an asset if you claim the tax back.">
                  <AccountSelect name={`${p.key}.fees`} value={p.mapping.fees} options={d.fees} label={`${p.name} taxes and charges account`} />
                </Field>
                <Field label="Paid from" error={err(`platforms.${p.key}.paidFrom`)}>
                  <AccountSelect name={`${p.key}.paidFrom`} value={p.mapping.paidFrom} options={d.paidFrom} label={`${p.name} paid from`} />
                </Field>
              </div>
            </Card>
          ))}
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
    </div>
  );
}
