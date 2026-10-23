import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/books.stock";
import { Forbidden } from "~/lib/authorize.server";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { checkStock, inventorifyStock, lastChecks, prepareStockAdjustment, proposedChange, stockCounters } from "~/lib/books-app/stock.server";
import { bookStores } from "~/lib/books-app/reports.server";
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
 * saved from To approve.
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
  const out = [];
  for (const s of stores) {
    const snap = checks[s.id];
    const inv = withInventorify.has(s.id);
    const items = inv ? (await inventorifyStock(book, s.id)).items : [];
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
