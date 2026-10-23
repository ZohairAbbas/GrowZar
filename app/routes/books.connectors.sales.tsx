import type { Prisma } from "@prisma/client";
import { Form, useNavigation } from "react-router";
import { Play } from "lucide-react";

import type { Route } from "./+types/books.connectors.sales";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { COD_BASES } from "~/lib/books-app/setup";
import { parseSalesForm, recentGateways, runSales, salesDefaults, salesStores, type SalesSettings } from "~/lib/books-app/connectors/sales.server";
import { getConnector, listRuns, runConnector, saveConnector } from "~/lib/books-app/connectors/runs.server";
import { rebuildPreview, rebuildSales } from "~/lib/books-app/connectors/rebuild.server";
import { BooksError, listAccounts } from "~/lib/books/books.server";
import { isMoneySubtype } from "~/lib/books/chart";
import { isCodGateway, type SalesMapping } from "~/lib/books/connectors/shopify-sales";
import { addDays } from "~/lib/books/posting";
import { todayIn } from "~/lib/books/dates";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Sales · Books · Growzar" }];
}

/**
 * Sales into the books (B3): one summary per store per day from Financify's
 * orders, by Financify's sales rules, with cash-on-delivery sales counted
 * when the book says (D-69, D-83) and returned parcels taken back off.
 */
type Kind = "income" | "tax" | "owed" | "expense" | "stock";
const FIELDS: Array<{ key: keyof SalesMapping; label: string; kind: Kind; help?: string }> = [
  { key: "sales", label: "Sales", kind: "income" },
  { key: "shipping", label: "Shipping charged", kind: "income" },
  { key: "discounts", label: "Discounts given", kind: "income" },
  { key: "returns", label: "Returns", kind: "income" },
  { key: "tax", label: "Sales tax", kind: "tax" },
  { key: "cod", label: "Cash on delivery is owed by", kind: "owed" },
  { key: "prepaid", label: "Other payments are owed by", kind: "owed", help: "Card and wallet gateways, unless you map one below." },
  { key: "cogs", label: "Cost of what you sold", kind: "expense" },
  { key: "stock", label: "Stock", kind: "stock" },
];

export async function loader({ request, url }: Route.LoaderArgs) {
  const { book, canManage } = await requireBook(request, "view");
  // "Bring sales in again" (v1.1 V3): what it would cancel, shown before anything changes.
  const rebuildFrom = url.searchParams.get("rebuildFrom") ?? "";
  const rebuildStore = url.searchParams.get("rebuildStore") ?? "";
  let rebuild: { from: string; store: string; days: number; entries: number; drafts: number } | { from: string; store: string; error: string } | null = null;
  if (rebuildFrom && canManage) {
    try {
      rebuild = { from: rebuildFrom, store: rebuildStore, ...(await rebuildPreview(book, { from: rebuildFrom, storeId: rebuildStore || null })) };
    } catch (e) {
      if (!(e instanceof BooksError)) throw e;
      rebuild = { from: rebuildFrom, store: rebuildStore, error: e.message };
    }
  }
  const [connector, defaults, stores, accounts, gateways, runs] = await Promise.all([getConnector(book, "shopify_sales"), salesDefaults(book), salesStores(book), listAccounts(book), recentGateways(book), listRuns(book, "shopify_sales")]);
  const mapping = connector.exists ? (connector.settings as unknown as SalesSettings).mapping : defaults;
  const live = accounts.filter((a) => !a.archived && !a.currency);
  const option = (a: (typeof live)[number]) => ({ id: a.id, name: `${a.code} · ${a.name}` });
  const today = todayIn(book.settings.timeZone);
  return {
    canManage,
    connector: { ...connector, startDate: connector.startDate ?? book.settings.startDate ?? addDays(today, -1) },
    codBasis: COD_BASES.find((b) => b.value === (book.settings.codBasis ?? "delivery"))!,
    mapping,
    stores,
    gateways: gateways.map((g) => ({ name: g, cod: isCodGateway(g), account: mapping.gateways?.[g] ?? "" })),
    options: {
      income: live.filter((a) => a.type === "income").map(option),
      tax: live.filter((a) => a.type === "liability" && a.subtype === "tax").map(option),
      owed: live.filter((a) => (a.type === "asset" && (a.subtype === "receivable" || isMoneySubtype(a.subtype))) || (a.type === "liability" && /gift card/i.test(a.name))).map(option),
      expense: live.filter((a) => a.type === "expense").map(option),
      stock: live.filter((a) => a.type === "asset" && a.subtype === "stock").map(option),
    },
    runs: runs.map((r) => ({ id: r.id, at: r.startedAt.toISOString(), status: r.status, message: r.message })),
    rebuild,
    lockedThrough: book.lockedThrough,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "run") {
      const r = await runConnector(book, "shopify_sales", "manual", runSales);
      return r ? { ok: r.status === "ok" ? "Sales are up to date." : "Done, with notes below." } : { error: "Sales are off, or already being brought in.", field: "" };
    }
    if (intent === "rebuild") {
      if (form.get("confirm") !== "on") return { error: "Tick the box to say you've read what will be cancelled.", field: "confirm" };
      const r = await rebuildSales(book, { from: String(form.get("from") ?? ""), storeId: String(form.get("store") ?? "") || null }, viewer.userId);
      return { ok: `${r.cancelled} saved entr${r.cancelled === 1 ? "y" : "ies"} cancelled${r.discarded ? ` and ${r.discarded} draft${r.discarded === 1 ? "" : "s"} thrown away` : ""}. The days come back in with today's settings over the next runs, every half hour until caught up; or press "Bring in now".` };
    }
    if (intent !== "save") return { error: "Nothing to do.", field: "" };
    const previous = await getConnector(book, "shopify_sales");
    const base = previous.exists ? (previous.settings as unknown as SalesSettings).mapping : await salesDefaults(book);
    const gateways: Record<string, string> = {};
    for (const g of form.getAll("gateway").map(String)) {
      const id = String(form.get(`gateway:${g}`) ?? "");
      if (id) gateways[g] = id;
    }
    const pct = String(form.get("costFallbackPercent") ?? "").trim();
    const mapping: SalesMapping = {
      ...base,
      ...(Object.fromEntries(FIELDS.map((f) => [f.key, String(form.get(f.key) ?? "")])) as Partial<SalesMapping>),
      gateways,
      costFallbackPercent: pct === "" ? null : Number(pct),
      manualPayments: form.get("manualPayments") === "as_mapped" ? "as_mapped" : "detect",
      parcelReturns: form.get("parcelReturns") === "on",
    };
    const input = await parseSalesForm(book, previous, { enabled: form.get("enabled") === "on", mode: String(form.get("mode") ?? "draft"), startDate: String(form.get("startDate") ?? ""), mapping }, todayIn(book.settings.timeZone));
    const drafts = await saveConnector(book, "shopify_sales", { ...input, settings: input.settings as unknown as Prisma.InputJsonValue }, viewer.userId);
    return { ok: drafts ? `Saved. ${drafts.posted} waiting day(s) saved to the books${drafts.left ? `, ${drafts.left} couldn't be` : ""}.` : "Saved." };
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message, field: e.field ?? "" };
    throw e;
  }
}

export default function SalesConnector({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const err = (f: string) => (actionData && "error" in actionData && actionData.field === f ? actionData.error : null);
  const c = d.connector;
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData && !/^(startDate|mapping\.)/.test(actionData.field ?? "") ? <Notice tone="warn">{actionData.error}</Notice> : null}

      <Card
        title="Sales"
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
          One entry per store per day: orders, discounts, shipping, tax, gift cards, refunds and cancellations, split by how customers paid, with what each sale cost. Cash-on-delivery sales count <strong>{d.codBasis.label.toLowerCase()}</strong>; until then they wait in "COD sales held back". Parcels that come back are taken off again.
        </p>
        <ul className="space-y-1 text-sm">
          {d.stores.map((s) => (
            <li key={s.id} className="text-gray-700">
              {s.name}: {s.financify ? "orders from Financify" : "Financify isn't connected; enter its sales by hand"}
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
              <Field label="Bring in sales from" htmlFor="startDate" error={err("startDate")} help="Orders placed before this day are part of your opening balances.">
                <input id="startDate" name="startDate" type="date" defaultValue={c.startDate} className={inputClass} />
              </Field>
              <Field label="New days arrive as" htmlFor="mode">
                <select id="mode" name="mode" defaultValue={c.mode} className={inputClass}>
                  <option value="draft">Drafts you check and save</option>
                  <option value="auto">Saved to the books automatically</option>
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 md:mt-8">
                <input type="checkbox" name="enabled" defaultChecked={c.enabled || !c.exists} className="h-4 w-4" /> Bring in sales
              </label>
            </div>
          </Card>

          <Card title="Accounts">
            <div className="grid gap-4 md:grid-cols-2">
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={f.key} error={err(`mapping.${f.key}`)} help={f.help}>
                  <select id={f.key} name={f.key} defaultValue={String(d.mapping[f.key] ?? "")} className={inputClass}>
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
          </Card>

          {d.gateways.length ? (
            <Card title="How customers paid">
              <p className="text-sm text-gray-600">Each payment method on your recent orders. Leave one as it is to use the account above.</p>
              <div className="grid gap-4 md:grid-cols-2">
                {d.gateways.map((g) => (
                  <Field key={g.name} label={g.name} error={err(`mapping.gateways.${g.name}`)} help={g.cod ? "Cash on delivery" : undefined}>
                    <input type="hidden" name="gateway" value={g.name} />
                    <select name={`gateway:${g.name}`} defaultValue={g.account} aria-label={`${g.name} account`} className={inputClass}>
                      <option value="">{g.cod ? "As cash on delivery" : "As other payments"}</option>
                      {d.options.owed.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
            </Card>
          ) : null}

          <Card title="Costs and parcels">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="An item with no cost" htmlFor="costFallbackPercent" error={err("mapping.costFallbackPercent")} help="Financify's cost at sale is used, else Inventorify's. With neither, leave it out (empty) or estimate it at this % of the price.">
                <input id="costFallbackPercent" name="costFallbackPercent" inputMode="decimal" defaultValue={d.mapping.costFallbackPercent ?? ""} placeholder="Leave out" className={inputClass} />
              </Field>
              <Field label='Orders paid "manually"' htmlFor="manualPayments">
                <select id="manualPayments" name="manualPayments" defaultValue={d.mapping.manualPayments ?? "detect"} className={inputClass}>
                  <option value="detect">Cash on delivery when a courier carried them</option>
                  <option value="as_mapped">As mapped above</option>
                </select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" name="parcelReturns" defaultChecked={d.mapping.parcelReturns !== false} className="h-4 w-4" /> Take returned cash-on-delivery parcels back off
            </label>
          </Card>
          <button type="submit" className={buttonClass} disabled={busy}>
            Save
          </button>
        </Form>
      ) : null}

      {d.canManage && c.enabled ? (
        <Card title="Bring sales in again">
          <p className="text-sm text-gray-600">
            After you fix something behind past days (costs added in Shopify, an account mapped differently), bring them in again from a date: each saved day from then on is cancelled, its record kept, and brought in fresh with today's settings and data. Nothing in a closed month is touched.
          </p>
          <Form method="get" className="flex flex-wrap items-end gap-2">
            <Field label="From" htmlFor="rebuildFrom">
              <input id="rebuildFrom" name="rebuildFrom" type="date" defaultValue={d.rebuild?.from ?? ""} min={c.startDate} className={`${inputClass} w-44`} />
            </Field>
            {d.stores.length > 1 ? (
              <Field label="Store" htmlFor="rebuildStore">
                <select id="rebuildStore" name="rebuildStore" defaultValue={d.rebuild?.store ?? ""} className={`${inputClass} w-48`}>
                  <option value="">Every store</option>
                  {d.stores.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <button type="submit" className={quietButtonClass}>
              See what changes
            </button>
          </Form>
          {d.rebuild && "error" in d.rebuild ? <Notice tone="warn">{d.rebuild.error}</Notice> : null}
          {d.rebuild && !("error" in d.rebuild) ? (
            <Form method="post" className="space-y-3">
              <p className="text-sm text-gray-700">
                {d.rebuild.days} saved day{d.rebuild.days === 1 ? "" : "s"} ({d.rebuild.entries} entr{d.rebuild.entries === 1 ? "y" : "ies"} with their corrections) will be cancelled and brought in again
                {d.rebuild.drafts ? `, and ${d.rebuild.drafts} draft${d.rebuild.drafts === 1 ? "" : "s"} thrown away` : ""}.
              </p>
              <input type="hidden" name="from" value={d.rebuild.from} />
              <input type="hidden" name="store" value={d.rebuild.store} />
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" name="confirm" className="h-4 w-4 rounded border-gray-300" /> I've read what will be cancelled
              </label>
              <button type="submit" name="intent" value="rebuild" className={buttonClass} disabled={busy || d.rebuild.entries + d.rebuild.drafts === 0}>
                Bring in again
              </button>
            </Form>
          ) : null}
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
