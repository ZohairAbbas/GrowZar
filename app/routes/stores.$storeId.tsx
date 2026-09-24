import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";

import type { Route } from "./+types/stores.$storeId";
import { requireStore } from "~/lib/authorize.server";
import { prisma } from "~/lib/db.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `${loaderData.store.shopDomain} · Growzar`
        : "Store · Growzar",
    },
  ];
}

/**
 * The acceptance case for G-GZR-2 lives here: reaching this URL for a store
 * outside the viewer's scope returns 403 from the loader, before anything is
 * queried or rendered.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { store } = await requireStore(request, params.storeId, "home", "view");

  const connections = await prisma.appConnection.findMany({
    where: { storeId: store.id },
    orderBy: { app: "asc" },
    select: { app: true, status: true, lastSyncedAt: true },
  });

  return {
    store: {
      id: store.id,
      shopDomain: store.shopDomain,
      displayName: store.displayName,
      currency: store.currency,
      timezone: store.timezone,
    },
    connections: connections.map((connection) => ({
      app: connection.app,
      status: connection.status,
      lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
    })),
  };
}

export default function StoreDetail({ loaderData }: Route.ComponentProps) {
  const { store, connections } = loaderData;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link
        to="/stores"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" />
        All stores
      </Link>

      <h1 className="mt-4 text-2xl font-semibold text-gray-900">
        {store.displayName ?? store.shopDomain}
      </h1>
      <p className="mt-1 text-sm text-gray-600">{store.shopDomain}</p>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Currency
          </dt>
          {/* Both come from the owning app, never a default (rules #4, #5). */}
          <dd className="mt-1 text-sm font-semibold text-gray-900">
            {store.currency ?? "Not reported yet"}
          </dd>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Timezone
          </dt>
          <dd className="mt-1 text-sm font-semibold text-gray-900">
            {store.timezone ?? "Not reported yet"}
          </dd>
        </div>
      </dl>

      <h2 className="mt-8 text-lg font-semibold text-gray-900">Connected apps</h2>
      {connections.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600">
          No apps connected to this store yet.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white">
          {connections.map((connection) => (
            <li
              key={connection.app}
              className="flex items-center justify-between gap-4 px-5 py-3"
            >
              <span className="text-sm font-medium capitalize text-gray-900">
                {connection.app.toLowerCase()}
              </span>
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
                {connection.status.toLowerCase().replace(/_/g, " ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
