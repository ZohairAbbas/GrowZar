import { Form, Link, NavLink, Outlet, useLocation } from "react-router";
import {
  BarChart3,
  Boxes,
  ChevronDown,
  Home,
  Inbox,
  LogOut,
  Megaphone,
  Package,
  Settings,
  ShoppingCart,
  Store as StoreIcon,
  Truck,
  Users,
  Wallet,
} from "lucide-react";

import type { Route } from "./+types/shell";
import { auth } from "~/lib/auth.server";
import { readStoreCookie } from "~/lib/store-cookie.server";
import { prisma } from "~/lib/db.server";
import { getViewer, listVisibleStores, visibleSections } from "~/lib/authorize.server";
import { SECTIONS, type Section } from "~/lib/permissions";
import {
  ORDERED_SECTIONS,
  sectionState,
  type SectionState,
} from "~/lib/sections";
import { cn } from "~/lib/utils";

/**
 * The app shell (G-GZR-6).
 *
 * Navigation over the nine sections, an organization switcher and a store
 * switcher. Sections the merchant's apps cannot fill yet are shown **locked**,
 * with what they would contain — never hidden, and never opened onto an empty
 * screen (D-04, D-16, D-43).
 *
 * Locked is a presentation state, not a permission. A section the viewer's
 * ROLE cannot see is absent entirely, and the enforcement for that is in the
 * loaders (G-GZR-2), not here.
 */
const SECTION_ICONS: Record<Section, typeof Home> = {
  home: Home,
  orders: ShoppingCart,
  shipping: Truck,
  finance: Wallet,
  customers: Users,
  inventory: Boxes,
  marketing: Megaphone,
  inbox: Inbox,
  settings: Settings,
};

export async function loader({ request }: Route.LoaderArgs) {
  const viewer = await getViewer(request);

  const [stores, organizations, allowed] = await Promise.all([
    listVisibleStores(viewer),
    auth.api.listOrganizations({ headers: request.headers }),
    visibleSections(request, viewer.organizationId, SECTIONS),
  ]);

  // The remembered store, but only if it is still one the viewer may see —
  // a cookie is not a permission, and scope can be narrowed after it was set.
  const remembered = readStoreCookie(request);
  const active =
    stores.find((store) => store.id === remembered) ?? stores[0] ?? null;

  const connections = active
    ? await prisma.appConnection.findMany({
        where: { storeId: active.id },
        select: { app: true, status: true, lastSyncedAt: true },
      })
    : [];

  const organization = organizations.find((o) => o.id === viewer.organizationId);

  return {
    user: { name: viewer.userId, role: viewer.role },
    organization: {
      id: viewer.organizationId,
      name: organization?.name ?? "Your organization",
    },
    organizations: organizations.map((o) => ({ id: o.id, name: o.name })),
    stores: stores.map((store) => ({
      id: store.id,
      shopDomain: store.shopDomain,
      displayName: store.displayName,
    })),
    activeStoreId: active?.id ?? null,
    sections: ORDERED_SECTIONS.filter((definition) =>
      allowed.has(definition.section),
    ).map((definition) => ({
      section: definition.section,
      label: definition.label,
      state: sectionState(definition, connections) as SectionState,
    })),
  };
}

function Switcher({
  label,
  current,
  children,
}: {
  label: string;
  current: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl bg-field px-3 py-2 text-left transition hover:bg-gray-100">
        <span className="min-w-0">
          <span className="block text-xs text-gray-500">
            {label}
          </span>
          <span className="block truncate text-sm font-semibold text-gray-900">
            {current}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-400 transition group-open:rotate-180" />
      </summary>
      <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-lg">
        {children}
      </div>
    </details>
  );
}

/** The wordmark: a navy tile with a mint "g", then the name. */
export function Logo() {
  return (
    <>
      <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-navy font-display text-lg font-bold leading-none text-mint">
        g
      </span>
      <span className="font-display text-xl font-bold text-navy">growzar</span>
    </>
  );
}

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { organization, organizations, stores, activeStoreId, sections } =
    loaderData;
  // Switching a store keeps you on the page you were reading.
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}`;
  const activeStore = stores.find((store) => store.id === activeStoreId);

  return (
    <div className="min-h-screen bg-field">
      <div className="mx-auto flex max-w-[1440px] gap-5 p-3 md:p-4">
        <aside className="hidden w-60 flex-shrink-0 flex-col rounded-2xl bg-white p-4 md:sticky md:top-4 md:flex md:h-[calc(100vh-2rem)] md:overflow-y-auto">
          <Link to="/home" className="mb-5 flex items-center gap-2.5 px-1.5">
            <Logo />
          </Link>

          <div className="space-y-2">
            <Switcher label="Organization" current={organization.name}>
              {organizations.map((candidate) => (
                <Form method="post" key={candidate.id} action="/switch">
                  <input type="hidden" name="intent" value="switch-organization" />
                  <input type="hidden" name="organizationId" value={candidate.id} />
                  <button
                    type="submit"
                    className={cn(
                      "block w-full truncate px-3 py-2 text-left text-sm transition hover:bg-gray-50",
                      candidate.id === organization.id
                        ? "font-semibold text-primary-700"
                        : "text-gray-700",
                    )}
                  >
                    {candidate.name}
                  </button>
                </Form>
              ))}
              <Link
                to="/organizations/new"
                className="block border-t border-gray-100 px-3 py-2 text-sm font-medium text-accent-600 hover:bg-gray-50"
              >
                New organization
              </Link>
            </Switcher>

            {stores.length > 0 ? (
              <Switcher
                label="Store"
                current={activeStore?.displayName ?? activeStore?.shopDomain ?? "No store"}
              >
                {stores.map((store) => (
                  <Form method="post" key={store.id} action="/switch">
                    <input type="hidden" name="intent" value="switch-store" />
                    <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <button
                      type="submit"
                      className={cn(
                        "block w-full truncate px-3 py-2 text-left text-sm transition hover:bg-gray-50",
                        store.id === activeStoreId
                          ? "font-semibold text-primary-700"
                          : "text-gray-700",
                      )}
                    >
                      {store.displayName ?? store.shopDomain}
                    </button>
                  </Form>
                ))}
                <Link
                  to="/stores"
                  className="block border-t border-gray-100 px-3 py-2 text-sm font-medium text-accent-600 hover:bg-gray-50"
                >
                  All stores
                </Link>
              </Switcher>
            ) : null}
          </div>

          <nav className="mt-5 space-y-1">
            {sections.map((item) => {
              const Icon = SECTION_ICONS[item.section];
              const to = item.section === "settings" ? "/settings" : `/${item.section}`;

              return (
                <NavLink
                  key={item.section}
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      "group flex items-center gap-3 rounded-full px-3.5 py-2.5 text-sm transition",
                      isActive
                        ? "active bg-navy font-semibold text-white"
                        : item.state.kind === "locked"
                          ? "font-medium text-gray-500 hover:bg-field"
                          : "font-medium text-gray-700 hover:bg-field",
                    )
                  }
                >
                  <Icon className="h-[18px] w-[18px] flex-shrink-0 group-[.active]:text-mint" />
                  <span className="flex-1 truncate">{item.label}</span>
                  {/*
                    A locked section stays in the navigation, greyed rather than
                    hidden. Hiding it would mean a merchant never discovers what
                    the rest of the suite would give them (D-04).
                  */}
                  {item.state.kind === "locked" ? (
                    <span className="rounded-full bg-field px-2 py-0.5 text-[11px] font-semibold text-gray-500 group-[.active]:bg-navy-surface group-[.active]:text-navy-muted">
                      Locked
                    </span>
                  ) : null}
                  {item.state.kind === "reconnect" ? (
                    <span className="rounded-full bg-coral-200 px-2 py-0.5 text-[11px] font-bold text-coral-700">
                      Stale
                    </span>
                  ) : null}
                </NavLink>
              );
            })}
          </nav>

          <Form method="post" action="/auth/sign-out" className="mt-auto pt-6">
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-full px-3.5 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-field hover:text-gray-900"
            >
              <LogOut className="h-[18px] w-[18px]" />
              Sign out
            </button>
          </Form>
        </aside>

        <main className="min-w-0 flex-1 px-1 py-2 md:px-2">
          {/* The same switchers, for a phone. */}
          <div className="mb-4 flex items-center gap-2 md:hidden">
            <Link to="/home" className="flex items-center gap-2">
              <Logo />
            </Link>
            {activeStore ? (
              <span className="ml-auto flex items-center gap-1.5 truncate text-sm text-gray-600">
                <StoreIcon className="h-4 w-4 flex-shrink-0" />
                {activeStore.displayName ?? activeStore.shopDomain}
              </span>
            ) : null}
          </div>

          {stores.length === 0 ? (
            <div className="mb-4 flex items-start gap-3 rounded-2xl bg-mint-100 p-4">
              <BarChart3 className="mt-0.5 h-5 w-5 flex-shrink-0 text-accent-600" />
              <p className="text-sm text-accent-900">
                No store connected yet. Open Growzar from inside Courierify,
                Financify or any other app you already use, and it will appear
                here.
              </p>
            </div>
          ) : null}

          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return (
    <main className="mx-auto max-w-lg px-6 py-24">
      <h1 className="font-display text-3xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-gray-600">
        The error has been logged.{" "}
        <Link to="/home" className="font-medium text-accent-500">
          Go back
        </Link>
        .
      </p>
    </main>
  );
}

export { SECTION_ICONS };
