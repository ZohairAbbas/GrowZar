import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/books.couriers._index";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { orderTotals } from "~/lib/books-app/connectors/parcels.server";
import { BooksError } from "~/lib/books/books.server";
import { OPEN_STAGES, type ParcelStage } from "~/lib/books/connectors/parcels";
import { courierOverview, markDamaged, saveStageRules, stageRules, writeOffParcels } from "~/lib/books/connectors/parcels.server";
import { formatDate, todayIn } from "~/lib/books/dates";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Field, Money, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Couriers · Books · Growzar" }];
}

/**
 * Couriers (B5b): what each courier still owes, parcel by parcel, by stage —
 * on the way, delivered and waiting for a payout, paid short, stuck — and how
 * the register squares with "Owed by couriers" in the books. Parcels a
 * courier will never pay for are written off from here; a return that came
 * back damaged takes its cost out of stock.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const today = todayIn(book.settings.timeZone);
  const o = await courierOverview(book, today);
  const stage = url.searchParams.get("stage") ?? "";
  const courier = url.searchParams.get("courier") ?? "";
  const shown = o.parcels.filter((p) => (stage ? p.stage === stage : OPEN_STAGES.includes(p.stage) || p.stage === "held")).filter((p) => !courier || p.courier === courier);
  return {
    canManage,
    today,
    stage,
    courier,
    rules: stageRules(book),
    labels: o.labels,
    salesOn: o.salesOn,
    ledger: m(o.ledger),
    registerOpen: m(o.registerOpen),
    difference: m(o.difference),
    differs: o.difference !== 0n,
    unlinkedPayouts: o.unlinkedPayouts,
    couriers: o.couriers.map((c) => ({
      courier: c.courier,
      open: m(c.open),
      stages: Object.entries(c.stages).map(([s, v]) => ({ stage: s as ParcelStage, count: v!.count, amount: m(v!.amount) })),
    })),
    unrecorded: o.unrecorded.map((u) => ({ ...u, day: formatDate(u.day), net: m(u.net) })),
    count: shown.length,
    parcels: shown.slice(0, 300).map((p) => ({
      id: p.id,
      orderName: p.orderName,
      placed: formatDate(p.placedDay),
      courier: p.courier,
      tracking: p.trackingNumber,
      stage: p.stage,
      open: m(p.open),
      owed: m(p.owed),
      canLose: ["stuck", "in_transit", "not_shipped", "delivered"].includes(p.stage) && p.open > 0n,
      canShort: p.stage === "short_paid" && p.open > 0n,
      canDamage: (p.stage === "came_back" || p.stage === "held") && !p.damagedDocId,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    switch (str("intent")) {
      case "writeoff": {
        const ids = form.getAll("parcel").map(String);
        const reason = str("reason") === "short_paid" ? "short_paid" : "lost";
        const rows = await import("~/lib/db.server").then(({ prisma }) => prisma.bkParcel.findMany({ where: { bookId: book.id, id: { in: ids } }, select: { orderId: true } }));
        const tax = await orderTotals(book.settings.storeIds ?? [], rows.map((r) => r.orderId));
        const r = await writeOffParcels(book, tax, { parcelIds: ids, reason, date: str("date") }, viewer.userId);
        return { ok: `${r.count} parcel${r.count === 1 ? "" : "s"} written off.` };
      }
      case "damaged":
        await markDamaged(book, { parcelId: str("parcelId"), amount: str("amount"), date: str("date") }, viewer.userId);
        return { ok: "Marked damaged; its cost has left stock." };
      case "rules":
        await saveStageRules(book, { stuckAfterDays: Number(str("stuckAfterDays")), unshippedAfterDays: Number(str("unshippedAfterDays")) }, viewer.userId);
        return { ok: "Saved." };
      default:
        return { error: "Nothing to do." };
    }
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message };
    throw e;
  }
}

export default function Couriers({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const chosen = d.parcels.filter((p) => picked.has(p.id));
  const reason = chosen.length && chosen.every((p) => p.canShort) ? "short_paid" : "lost";
  const canWriteOff = chosen.length > 0 && chosen.every((p) => (reason === "lost" ? p.canLose : p.canShort));
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      {!d.salesOn ? <Notice>The parcel register fills in from sales. Turn sales on under Where entries come from.</Notice> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-gray-900">Couriers</h2>
        <span className="flex gap-3 text-sm font-semibold">
          <Link to="/books/couriers/files?kind=settlement" className="text-accent-600">Settlement files</Link>
          <Link to="/books/couriers/files?kind=loadsheet" className="text-accent-600">Loadsheets</Link>
        </span>
      </div>

      <Card title="What couriers owe you">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-3">
          <dt className="text-gray-500">In the books</dt>
          <dd className="md:col-span-2"><Money value={d.ledger} /></dd>
          <dt className="text-gray-500">Parcel by parcel</dt>
          <dd className="md:col-span-2"><Money value={d.registerOpen} /></dd>
          <dt className="text-gray-500">Difference</dt>
          <dd className="md:col-span-2">
            <Money value={d.difference} />
            {d.differs ? <span className="ml-2 text-xs text-gray-500">Opening balances, payouts not tied to parcels ({d.unlinkedPayouts}) and entries that don't name an order make this.</span> : null}
          </dd>
        </dl>
        <ul className="divide-y divide-gray-100">
          {d.couriers.map((c) => (
            <li key={c.courier} className="py-2 text-sm">
              <div className="flex items-baseline justify-between">
                <Link to={`?courier=${encodeURIComponent(c.courier)}`} className="font-semibold text-gray-900 hover:text-accent-600">{c.courier}</Link>
                <Money value={c.open} />
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {c.stages.map((s) => (
                  <Link key={s.stage} to={`?courier=${encodeURIComponent(c.courier)}&stage=${s.stage}`} className="rounded-full bg-field px-2.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100">
                    {d.labels[s.stage]} · {s.count} · {s.amount}
                  </Link>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {d.unrecorded.length ? (
        <Card title="Paid by the courier, not in your books yet">
          <p className="text-sm text-gray-600">Courierify shows these payouts on your parcels; the courier-payout connector brings them in on its next run.</p>
          <ul className="text-sm">
            {d.unrecorded.map((u) => (
              <li key={u.ref}>{u.courier} · {u.ref} · {u.day} · {u.parcels} parcels · {u.net}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Form method="post">
        <Card
          title={`${d.stage ? d.labels[d.stage as ParcelStage] : "Still owed"}${d.courier ? ` · ${d.courier}` : ""} · ${d.count}`}
          aside={
            d.canManage && picked.size ? (
              <span className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="reason" value={reason} />
                <input type="date" name="date" defaultValue={d.today} max={d.today} aria-label="Date" className={`${inputClass} w-40`} />
                <button type="submit" name="intent" value="writeoff" className={buttonClass} disabled={busy || !canWriteOff}>
                  Write off {picked.size} as {reason === "lost" ? "lost" : "paid short"}
                </button>
              </span>
            ) : null
          }
        >
          {d.stage || d.courier ? <Link to="?" className="text-xs font-semibold text-accent-600">Show everything still owed</Link> : null}
          <ul className="divide-y divide-gray-100">
            {d.parcels.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                {d.canManage && (p.canLose || p.canShort) ? <input type="checkbox" name="parcel" value={p.id} checked={picked.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Choose ${p.orderName}`} className="h-4 w-4" /> : <span className="w-4" />}
                <span className="w-24 font-semibold text-gray-900">{p.orderName}</span>
                <span className="w-24 text-gray-500">{p.placed}</span>
                <span className="min-w-0 flex-1 truncate text-gray-700">
                  {p.courier}
                  {p.tracking ? <span className="text-gray-500"> · {p.tracking}</span> : null} · {d.labels[p.stage]}
                </span>
                <Money value={p.open} className="w-32 text-right" />
              </li>
            ))}
          </ul>
          {d.count > d.parcels.length ? <p className="text-xs text-gray-500">The first 300 are shown; choose a courier or stage to narrow it.</p> : null}
        </Card>
      </Form>

      {d.canManage && d.parcels.some((p) => p.canDamage) ? (
        <Card title="Came back damaged">
          <Form method="post" className="grid gap-3 md:grid-cols-[1fr_160px_160px_auto]">
            <select name="parcelId" required aria-label="Parcel" className={inputClass}>
              {d.parcels.filter((p) => p.canDamage).map((p) => (
                <option key={p.id} value={p.id}>{p.orderName} · {p.courier}</option>
              ))}
            </select>
            <input name="amount" inputMode="decimal" required placeholder="Cost of what's damaged" aria-label="Amount" className={inputClass} />
            <input name="date" type="date" defaultValue={d.today} max={d.today} aria-label="Date" className={inputClass} />
            <button type="submit" name="intent" value="damaged" className={quietButtonClass} disabled={busy}>Mark damaged</button>
          </Form>
        </Card>
      ) : null}

      {d.canManage ? (
        <Card title="When a parcel counts as stuck">
          <Form method="post" className="grid gap-3 md:grid-cols-[220px_220px_auto]">
            <Field label="No news on the way for (days)" htmlFor="stuck">
              <input id="stuck" name="stuckAfterDays" type="number" min={3} max={180} defaultValue={d.rules.stuckAfterDays} className={inputClass} />
            </Field>
            <Field label="Not shipped after (days)" htmlFor="unshipped">
              <input id="unshipped" name="unshippedAfterDays" type="number" min={3} max={180} defaultValue={d.rules.unshippedAfterDays} className={inputClass} />
            </Field>
            <button type="submit" name="intent" value="rules" className={`${quietButtonClass} md:mt-7`} disabled={busy}>Save</button>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}
