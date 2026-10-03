import { Link } from "react-router";
import { Store as StoreIcon } from "lucide-react";

import type { Route } from "./+types/stores._index";
// One import, and only what the loader actually uses. An unused binding from a
// `.server` module is not free: React Router strips server code from `loader`,
// `action`, `middleware` and `headers`, and anything it cannot attribute to
// those is assumed to be needed by the client — which fails the build.
import { listVisibleStores, requireSection } from "~/lib/authorize.server";
import { RoleBadge } from "~/components/ui/RoleBadge";

export function meta() {
  return [{ title: "Stores · Growzar" }];
}

/**
 * The list is built from `listVisibleStores`, never from a plain findMany on
 * the organization. A member scoped to one store sees one row here, and the
 * rows they cannot see are not fetched at all rather than fetched and hidden.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "home", "view");
  const stores = await listVisibleStores(viewer);

  return {
    role: viewer.role,
    scoped: viewer.scopedStoreIds !== null,
    stores: stores.map((store) => ({
      id: store.id,
      shopDomain: store.shopDomain,
      displayName: store.displayName,
      currency: store.currency,
    })),
  };
}

export default function Stores({ loaderData }: Route.ComponentProps) {
  const { stores, scoped, role } = loaderData;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-gray-900">Stores</h1>
          <p className="mt-1 text-sm text-gray-600">
            {scoped
              ? "The stores you have been given access to."
              : "Every store in your organization."}
          </p>
        </div>
        <RoleBadge role={role} />
      </div>

      {stores.length === 0 ? (
        <p className="mt-8 rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
          No stores yet. Open Growzar from inside one of your apps to connect
          one.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {stores.map((store) => (
            <li key={store.id}>
              <Link
                to={`/stores/${store.id}`}
                className="flex items-center gap-4 rounded-2xl bg-white p-5 transition hover:shadow-md"
              >
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gray-100">
                  <StoreIcon className="h-5 w-5 text-gray-600" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-gray-900">
                    {store.displayName ?? store.shopDomain}
                  </span>
                  <span className="block truncate text-sm text-gray-500">
                    {store.shopDomain}
                  </span>
                </span>
                {store.currency ? (
                  <span className="text-sm font-medium text-gray-500">
                    {store.currency}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
