import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/books.stock";
import { Forbidden } from "~/lib/authorize.server";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { checkStock, inventorifyStock, lastChecks, prepareStockAdjustment, proposedChange, stockCounters } from "~/lib/books-app/stock.server";
import { bookStores } from "~/lib/books-app/reports.server";
import { confirmCosts, costsStoreIds, dropPreview, heldPreview, itemsWithNoCost, MAX_ITEMS, previewCosts, type CostResult } from "~/lib/books-app/stock-costs.server";
import { BooksError } from "~/lib/books/books.server";
import { todayIn } from "~/lib/books/dates";
import { decimalToMinor } from "~/lib/books/connectors/shopify-sales";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, Money, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Stock · Books · Growzar" }];
}

/**
 * Stock (Books v1.1 V4, D-97): what the books say each store's stock is
 * worth, checked against Inventorify (or a count). A difference becomes a
 * stock adjustment, always a draft: nothing changes in the books until it's
 * saved from To approve. Items with no cost can get one in Shopify through
 * Inventorify (V7), previewed and confirmed.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const m = (v: bigint) => money(book, v, isAccountantRole(viewer.role));
  const [stores, checks, connections, waiting] = await Promise.all([
    bookStores(book),
    lastChecks(book),
    prisma.appConnection.findMany({ where: { storeId: { in: book.settings.storeIds ?? [] }, app: "INVENTORIFY", status: "CONNECTED" }, select: { storeId: true } }),
    prisma.bkDocument.findFirst({ where: { bookId: book.id, type: "stock_adjustment", status: "draft" }, select: { id: true } }),
  ]);
  const withInventorify = new Set(connections.map((c) => c.storeId));
  const withCosts = canManage ? await costsStoreIds(book) : new Set<string>();
  const out = [];
  for (const s of stores) {
    const snap = checks[s.id];
    const inv = withInventorify.has(s.id);
    const items = inv ? (await inventorifyStock(book, s.id)).items : [];
    const costs = withCosts.has(s.id) ? { items: (await itemsWithNoCost(book, s.id)).slice(0, MAX_ITEMS), preview: await heldPreview(book, s.id, viewer.userId) } : null;
    out.push({
      id: s.id,
      name: s.name,
      inventorify: inv,
      check: snap
        ? {
            at: new Date(snap.at).toLocaleString("en-GB", { timeZone: book.settings.timeZone ?? "UTC" }),
            fresh: Date.now() - Date.parse(snap.at) < 30 * 60 * 1000,
            counted: m(BigInt(snap.counted)),
            books: m(BigInt(snap.booksValue)),
            pending: m(BigInt(snap.pending)),
            held: BigInt(snap.held) !== 0n ? m(BigInt(snap.held)) : null,
            notTied: BigInt(snap.notTied) !== 0n ? m(BigInt(snap.notTied)) : null,
            change: m(proposedChange(snap)),
            matches: proposedChange(snap) === 0n,
            itemsNoCost: snap.itemsNoCost,
            unitsNoCost: snap.unitsNoCost,
            oversoldUnits: snap.oversoldUnits,
            otherCurrency: snap.otherCurrency,
          }
        : null,
      items: items
        .filter((i) => i.units !== 0 || i.state === "no_cost")
        .slice(0, 25)
        .map((i) => ({ id: i.variantId, name: i.name, sku: i.sku, units: i.units, cost: i.unitCost === null ? null : m(i.unitCost), value: m(i.value), state: i.state })),
      itemCount: items.filter((i) => i.units !== 0).length,
      costs: costs ? { ...costs, more: Math.max(0, items.filter((i) => i.state === "no_cost" && i.units > 0).length - MAX_ITEMS) } : null,
    });
  }
  return { canManage, today: todayIn(book.settings.timeZone), waiting: waiting?.id ?? null, stores: out, counters: await stockCounters(book) };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const storeId = str("storeId");
  const today = todayIn(book.settings.timeZone);
  try {
    switch (str("intent")) {
      case "check":
        await checkStock(book, storeId);
        return { ok: "Checked against Inventorify." };
      case "cost-preview": {
        const wanted = [...form.entries()].filter(([k]) => k.startsWith("cost:")).map(([k, v]) => ({ variantId: k.slice(5), cost: String(v) }));
        await previewCosts(book, storeId, wanted, viewer.userId);
        return { ok: "Here's what would change in Shopify. Nothing has changed yet." };
      }
      case "cost-confirm":
        return { costs: { storeId, ...(await confirmCosts(book, storeId, viewer.userId)) } };
      case "cost-drop":
        await dropPreview(book, storeId);
        return { ok: "Preview cleared. Nothing was changed." };
      case "adjust":
      case "count": {
        const counted = str("intent") === "count" ? decimalToMinor(str("counted").replace(/,/g, "") || "x", book.decimals).toString() : undefined;
        const r = await prepareStockAdjustment(book, { storeId, method: str("intent") === "count" ? "count" : "inventorify", counted, date: str("date") || undefined, counter: str("counter") || null }, today, viewer.userId);
        return { ok: r.waiting ? "A stock adjustment is already waiting for approval: save or discard it first." : "The adjustment is ready as a draft. Nothing changes in your books until it's saved.", entry: r.id };
      }
      default:
        return { error: "Nothing to do." };
    }
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message };
    if (e instanceof Error && /Not a money amount/.test(e.message)) return { error: "Enter what the stock was worth, like 1250000" };
    throw e;
  }
}

export default function Stock({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const counterSelect = (id: string) => (
    <Field label="The difference goes to" htmlFor={id}>
      <select id={id} name="counter" defaultValue={d.counters.defaultId ?? ""} className={inputClass}>
        {d.counters.choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? (
        <Notice>
          {actionData.ok}{" "}
          {"entry" in actionData && actionData.entry ? (
            <Link to={`/books/entries/${actionData.entry}`} className="font-semibold underline">
              Open it
            </Link>
          ) : null}
        </Notice>
      ) : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      {actionData && "costs" in actionData && actionData.costs ? <CostResults result={actionData.costs} /> : null}
      {d.waiting && !(actionData && "entry" in actionData) ? (
        <Notice>
          A stock adjustment is waiting for approval.{" "}
          <Link to={`/books/entries/${d.waiting}`} className="font-semibold underline">
            Open it
          </Link>
        </Notice>
      ) : null}
      {d.counters.firstCount ? (
        <Notice tone="warn">
          Your books have no opening stock yet, so most of a first difference is stock you already had on your first day, not a cost. It goes to "Opening balance (first count)" unless you choose otherwise; or enter your opening stock under Opening balances first.
        </Notice>
      ) : null}
      <p className="text-sm text-gray-600">
        Check what your books say stock is worth against Inventorify, or a count. A difference becomes a stock adjustment, always as a draft first: nothing changes until it's saved under To approve.
      </p>
      {d.stores.map((s) => (
        <Card
          key={s.id}
          title={s.name}
          aside={
            d.canManage && s.inventorify ? (
              <Form method="post">
                <input type="hidden" name="storeId" value={s.id} />
                <button type="submit" name="intent" value="check" className={quietButtonClass} disabled={busy}>
                  Check against Inventorify
                </button>
              </Form>
            ) : null
          }
        >
          {s.check ? (
            <div className="space-y-3">
              <table className="w-full text-sm">
                <tbody>
                  <tr>
                    <td className="py-1">Inventorify: available stock at cost</td>
                    <td className="py-1 text-right">
                      <Money value={s.check.counted} />
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1">Stock in the books</td>
                    <td className="py-1 text-right">
                      <Money value={s.check.books} />
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1 text-gray-600">Sold, not in the books yet{s.check.held ? `, less COD orders held back (${s.check.held})` : ""}</td>
                    <td className="py-1 text-right">
                      <Money value={s.check.pending} />
                    </td>
                  </tr>
                  <tr className="border-y-2 border-gray-700 font-semibold">
                    <td className="py-2">{s.check.matches ? "Stock matches" : "Adjustment the books need"}</td>
                    <td className="py-2 text-right">{s.check.matches ? null : <Money value={s.check.change} />}</td>
                  </tr>
                </tbody>
              </table>
              <p className="text-xs text-gray-500">
                Checked {s.check.at}.
                {s.check.itemsNoCost ? ` ${s.check.itemsNoCost} item${s.check.itemsNoCost === 1 ? "" : "s"} (${s.check.unitsNoCost} units) have no cost in Inventorify and aren't valued.` : ""}
                {s.check.oversoldUnits ? ` ${-s.check.oversoldUnits} units are oversold and left out.` : ""}
                {s.check.otherCurrency ? ` ${s.check.otherCurrency} item${s.check.otherCurrency === 1 ? " has" : "s have"} a cost in another currency and ${s.check.otherCurrency === 1 ? "is" : "are"} left out.` : ""}
                {s.check.notTied ? ` Stock in the books not tied to a store (${s.check.notTied}, opening stock usually) is left out of each store's check.` : ""}
              </p>
              {d.canManage && !s.check.matches ? (
                s.check.fresh ? (
                  <Form method="post" className="grid gap-3 md:grid-cols-[260px_auto] md:items-end">
                    <input type="hidden" name="storeId" value={s.id} />
                    {counterSelect(`counter-${s.id}`)}
                    <button type="submit" name="intent" value="adjust" className={buttonClass} disabled={busy}>
                      Prepare the adjustment
                    </button>
                  </Form>
                ) : (
                  <p className="text-xs text-gray-500">This check is more than 30 minutes old: check again before preparing the adjustment.</p>
                )
              ) : null}
            </div>
          ) : s.inventorify ? (
            <p className="text-sm text-gray-600">Not checked yet.</p>
          ) : (
            <p className="text-sm text-gray-600">Inventorify isn't connected for this store: count the stock and enter its value below.</p>
          )}

          {s.items.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold text-accent-600">Inventorify's items ({s.itemCount} with stock), most valuable first</summary>
              <table className="mt-2 w-full">
                <thead>
                  <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-1 text-left font-semibold">Item</th>
                    <th className="py-1 text-right font-semibold">Available</th>
                    <th className="py-1 text-right font-semibold">Cost each</th>
                    <th className="py-1 text-right font-semibold">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {s.items.map((i) => (
                    <tr key={i.id} className="border-b border-gray-50">
                      <td className="py-1">
                        {i.name}
                        {i.sku ? <span className="text-xs text-gray-500"> · {i.sku}</span> : null}
                      </td>
                      <td className={`py-1 text-right tabular-nums ${i.units < 0 ? "text-coral-700" : ""}`}>{i.units}</td>
                      <td className="py-1 text-right">{i.cost ? <Money value={i.cost} /> : <span className="text-xs text-coral-700">no cost</span>}</td>
                      <td className="py-1 text-right">
                        <Money value={i.value} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}

          {s.costs ? <CostsCard storeId={s.id} costs={s.costs} busy={busy} /> : null}

          {d.canManage ? (
            <Form method="post" className="grid gap-3 border-t border-gray-100 pt-3 md:grid-cols-[180px_200px_240px_auto] md:items-end">
              <input type="hidden" name="storeId" value={s.id} />
              <Field label="Counted on" htmlFor={`date-${s.id}`}>
                <input id={`date-${s.id}`} name="date" type="date" defaultValue={d.today} max={d.today} className={inputClass} />
              </Field>
              <Field label="Worth at cost" htmlFor={`counted-${s.id}`}>
                <input id={`counted-${s.id}`} name="counted" inputMode="decimal" placeholder="1250000" className={inputClass} />
              </Field>
              {counterSelect(`count-counter-${s.id}`)}
              <button type="submit" name="intent" value="count" className={quietButtonClass} disabled={busy}>
                Prepare from a count
              </button>
            </Form>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

type Costs = NonNullable<Route.ComponentProps["loaderData"]["stores"][number]["costs"]>;

/** Items with no cost: type each one's cost, preview it through Inventorify, then confirm (V7). */
function CostsCard({ storeId, costs, busy }: { storeId: string; costs: Costs; busy: boolean }) {
  const p = costs.preview;
  if (p) {
    const setting = p.items.filter((i) => i.change === "set").length;
    const until = new Date(p.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return (
      <div className="space-y-2 border-t border-gray-100 pt-3 text-sm">
        <p className="font-semibold">Cost per item in Shopify: the preview</p>
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
              <th className="py-1 text-left font-semibold">Item</th>
              <th className="py-1 text-right font-semibold">Now</th>
              <th className="py-1 text-right font-semibold">New ({p.currency})</th>
              <th className="py-1 text-left font-semibold pl-3">What happens</th>
            </tr>
          </thead>
          <tbody>
            {p.items.map((i) => (
              <tr key={i.variantId} className="border-b border-gray-50">
                <td className="py-1">
                  {i.name}
                  {i.sku ? <span className="text-xs text-gray-500"> · {i.sku}</span> : null}
                </td>
                <td className="py-1 text-right tabular-nums">{i.current ?? <span className="text-xs text-gray-500">none</span>}</td>
                <td className="py-1 text-right tabular-nums">{i.proposed}</td>
                <td className={`py-1 pl-3 ${i.change === "refused" ? "text-coral-700" : "text-gray-600"}`}>{i.change === "set" ? "Will be set" : i.change === "same" ? "Already this" : `Won't be set: ${i.reason}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-gray-500">
          Shopify uses a cost for orders from now on; sales already in your books keep theirs. Confirm by {until}, or preview again.
        </p>
        <Form method="post" className="flex flex-wrap gap-2">
          <input type="hidden" name="storeId" value={storeId} />
          {setting ? (
            <button type="submit" name="intent" value="cost-confirm" className={buttonClass} disabled={busy}>
              Set {setting} cost{setting === 1 ? "" : "s"} in Shopify
            </button>
          ) : null}
          <button type="submit" name="intent" value="cost-drop" className={quietButtonClass} disabled={busy}>
            {setting ? "Cancel" : "Close"}
          </button>
        </Form>
      </div>
    );
  }
  if (costs.items.length === 0) return null;
  return (
    <details className="border-t border-gray-100 pt-3 text-sm">
      <summary className="cursor-pointer font-semibold text-accent-600">Give items with no cost a cost in Shopify ({costs.items.length + costs.more})</summary>
      <Form method="post" className="mt-2 space-y-2">
        <input type="hidden" name="storeId" value={storeId} />
        <p className="text-xs text-gray-500">
          Type what each item cost you, in the store's currency. Inventorify shows what would change first; nothing changes in Shopify until you confirm. Leave an item empty to skip it.
          {costs.more ? ` The ${costs.items.length} with the most units are shown; set these first, then the rest appear.` : ""}
        </p>
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
              <th className="py-1 text-left font-semibold">Item</th>
              <th className="py-1 text-right font-semibold">Available</th>
              <th className="py-1 text-right font-semibold">Cost each</th>
            </tr>
          </thead>
          <tbody>
            {costs.items.map((i) => (
              <tr key={i.variantId} className="border-b border-gray-50">
                <td className="py-1">
                  {i.name}
                  {i.sku ? <span className="text-xs text-gray-500"> · {i.sku}</span> : null}
                </td>
                <td className="py-1 text-right tabular-nums">{i.units}</td>
                <td className="py-1 text-right">
                  <input name={`cost:${i.variantId}`} inputMode="decimal" aria-label={`Cost of ${i.name}`} className={`${inputClass} w-28 text-right`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="submit" name="intent" value="cost-preview" className={quietButtonClass} disabled={busy}>
          Preview in Shopify
        </button>
      </Form>
    </details>
  );
}

function CostResults({ result }: { result: CostResult & { storeId: string } }) {
  const failed = result.items.filter((i) => !i.ok);
  return (
    <Notice tone={failed.length ? "warn" : undefined}>
      {result.set ? `Set ${result.set} cost${result.set === 1 ? "" : "s"} in Shopify. Inventorify's list here catches up within a few minutes; check stock again after that.` : "No cost was set."}
      {failed.length ? (
        <ul className="mt-1 list-disc pl-5">
          {failed.map((i) => (
            <li key={i.variantId}>
              {i.name}: {i.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </Notice>
  );
}
