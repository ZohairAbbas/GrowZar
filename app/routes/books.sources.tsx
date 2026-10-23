import { Form, Link, useNavigation } from "react-router";
import { CheckCircle2, Download, PenLine, RefreshCw } from "lucide-react";

import type { Route } from "./+types/books.sources";
import { prisma } from "~/lib/db.server";
import { getConnector } from "~/lib/books-app/connectors/runs.server";
import { formatDate } from "~/lib/books/dates";
import { requireBook } from "~/lib/books-app/access.server";
import { SOURCE_LABELS, installHref, storeCoverage, type SourceStatus } from "~/lib/books-app/coverage";
import { APP_LABELS } from "~/lib/sections";
import { Card, quietButtonClass } from "~/components/books/BooksUi";
import { Notice } from "~/components/metrics/Metrics";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { BooksError } from "~/lib/books/books.server";
import { addStore } from "~/lib/books-app/stores.server";

export function meta() {
  return [{ title: "Where entries come from · Books · Growzar" }];
}

/**
 * Where each store's entries come from (B2, D-66, D-78): automatic from an app
 * Growzar reads, missing (with the tracked install button), or by hand. The
 * page says what will post before anything does.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  // The organization's other stores, which can join these books (v1.1 V1, D-96).
  const others = await prisma.store.findMany({
    where: { organizationId: viewer.organizationId, id: { notIn: book.settings.storeIds ?? [] } },
    orderBy: { shopDomain: "asc" },
    select: { id: true, shopDomain: true, displayName: true, currency: true },
  });
  const stores = await prisma.store.findMany({
    where: { id: { in: book.settings.storeIds ?? [] }, organizationId: viewer.organizationId },
    orderBy: { shopDomain: "asc" },
    select: { id: true, shopDomain: true, displayName: true, connections: { select: { app: true, status: true, capabilities: true } } },
  });
  const [sales, adSpend, payouts, inventorify] = await Promise.all([getConnector(book, "shopify_sales"), getConnector(book, "ad_spend"), getConnector(book, "courierify_payouts"), getConnector(book, "inventorify")]);
  const state = (c: typeof adSpend) => (!c.exists ? "Not set up" : !c.enabled ? "Off" : `On${c.mode === "auto" ? ", saving automatically" : ", as drafts"}${c.syncedThrough ? `, through ${formatDate(c.syncedThrough)}` : ""}`);
  return {
    // The connectors built so far (B3); the rest join this list as they land.
    connectors: [
      { key: "shopify_sales", name: "Sales", to: "/books/connectors/sales", state: state(sales) },
      {
        key: "ad_spend",
        name: "Ad spend",
        to: "/books/connectors/ad-spend",
        state: state(adSpend),
      },
      { key: "courierify_payouts", name: "Courier payouts", to: "/books/connectors/courier-payouts", state: state(payouts) },
      { key: "inventorify", name: "Goods received (Inventorify)", to: "/books/connectors/inventorify", state: state(inventorify) },
    ],
    canManage,
    currency: book.currency,
    others: others.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain, currency: s.currency })),
    stores: stores.map((s) => ({
      id: s.id,
      name: s.displayName ?? s.shopDomain,
      sources: storeCoverage(s.connections).map((c) => ({ ...c, ...SOURCE_LABELS[c.source] })),
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  if (String(form.get("intent") ?? "") !== "add_store") return { error: "Nothing to do." };
  try {
    const r = await addStore(book, viewer.organizationId, String(form.get("storeId") ?? ""), viewer.userId);
    return { ok: `${r.name} is in these books now. Its days come in on the connectors' next runs${r.currency !== book.currency ? `, converted from ${r.currency} into ${book.currency} at each day's rate` : ""}.` };
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message };
    throw e;
  }
}

function Status({ storeId, status }: { storeId: string; status: SourceStatus }) {
  switch (status.kind) {
    case "auto":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-mint-700">
          <CheckCircle2 className="h-4 w-4" /> Automatic from {status.note ?? APP_LABELS[status.app]}
        </span>
      );
    case "missing":
      return (
        <span className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
          <a href={installHref(storeId, status.app)} className="inline-flex items-center gap-1.5 rounded-full bg-navy px-3 py-1 text-xs font-semibold text-white hover:bg-navy-surface">
            <Download className="h-3.5 w-3.5" /> Install {APP_LABELS[status.app]}
          </a>
          or {status.byHand.charAt(0).toLowerCase() + status.byHand.slice(1)}
        </span>
      );
    case "update":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-gray-600">
          <RefreshCw className="h-4 w-4" /> {APP_LABELS[status.app]} needs an update for this. {status.byHand}
        </span>
      );
    case "by_hand":
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-gray-600">
          <PenLine className="h-4 w-4" /> By hand. {status.byHand}
        </span>
      );
  }
}

export default function BooksSources({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <div className="space-y-5">
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      <p className="text-sm text-gray-600">What reaches your books from each store. Automatic entries arrive each day as drafts you check and save, or saved for you once you trust them.</p>
      <Card title="Connections">
        <ul className="divide-y divide-gray-100">
          {d.connectors.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="font-semibold text-gray-900">{c.name}</span>
              <span className="flex items-center gap-3 text-gray-600">
                {c.state}
                <Link to={c.to} className="font-semibold text-accent-600">
                  {c.state === "Not set up" ? "Set up" : "Settings"}
                </Link>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {d.canManage && d.others.length ? (
        <Card title="Your other stores">
          <ul className="divide-y divide-gray-100">
            {d.others.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-semibold text-gray-900">{o.name}</span>
                  {o.currency && o.currency !== d.currency ? <span className="text-gray-500"> · in {o.currency}, converted into {d.currency} at each day's rate</span> : null}
                  {!o.currency ? <span className="text-gray-500"> · Growzar doesn't know its currency yet</span> : null}
                </span>
                {o.currency ? (
                  <Form method="post">
                    <input type="hidden" name="storeId" value={o.id} />
                    <button type="submit" name="intent" value="add_store" className={quietButtonClass} disabled={busy}>
                      Add to these books
                    </button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500">Its sales, payouts and ad spend come in from each connector's start date. Days already in the books aren't posted again.</p>
        </Card>
      ) : null}
      {d.stores.map((s) => (
        <Card key={s.id} title={s.name}>
          <ul className="divide-y divide-gray-100">
            {s.sources.map((src) => (
              <li key={src.source} className="grid gap-1 py-2.5 md:grid-cols-[220px_1fr]">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{src.label}</p>
                  <p className="text-xs text-gray-500">{src.what}</p>
                </div>
                <div className="md:pt-0.5">
                  <Status storeId={s.id} status={src.status} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
