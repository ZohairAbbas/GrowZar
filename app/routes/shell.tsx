import { Fragment, useEffect, useState } from "react";
import { Form, Link, NavLink, Outlet, isRouteErrorResponse, useLocation, useRouteError } from "react-router";
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
  Compass,
  Download,
  Lightbulb,
  Menu,
  Share,
  X,
  Activity,
  MessageCircleQuestionMark,
  BookOpen,
} from "lucide-react";

import type { Route } from "./+types/shell";
import { auth } from "~/lib/auth.server";
import { reportClientError } from "~/lib/client-error";
import { readStoreCookie } from "~/lib/store-cookie.server";
import { prisma } from "~/lib/db.server";
import { askEnabled } from "~/lib/ask/loop.server";
import { planVisible } from "~/lib/forecast/plan-access.server";
import { booksVisible } from "~/lib/books-app/access.server";
import { getViewer, listVisibleStores, visibleSections } from "~/lib/authorize.server";
import { SECTIONS, type Section } from "~/lib/permissions";
import {
  ORDERED_SECTIONS,
  sectionState,
  type SectionState,
} from "~/lib/sections";
import { cn } from "~/lib/utils";
import { promptInstall, useInstallOffer } from "~/lib/install-app";
import { AppIcon } from "~/components/ui/AppIcon";

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
  plan: Compass,
  customers: Users,
  inventory: Boxes,
  marketing: Megaphone,
  inbox: Inbox,
  books: BookOpen,
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
  // Ask shows in the navigation only where it is on, for the server and the organization.
  const ask = askEnabled() && Boolean((await prisma.askSettings.findUnique({ where: { organizationId: viewer.organizationId }, select: { enabled: true } }))?.enabled);
  // Plan shows to every member with plan:view while its switch is on (pre-Wave-1 pack 2).
  const plan = planVisible(allowed.has("plan"));
  // Books shows behind its switches, to members whose role and store scope allow it (D-80, D-81, D-91).
  const books = allowed.has("books") && (await booksVisible(request, viewer));

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
    ask: ask && allowed.has("home"),
    sections: ORDERED_SECTIONS.filter((definition) =>
      allowed.has(definition.section) && (definition.section !== "plan" || plan) && (definition.section !== "books" || books),
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

/** The wordmark: Growzar's icon, then the name. */
export function Logo() {
  return (
    <>
      <AppIcon />
      <span className="font-display text-xl font-bold text-navy">growzar</span>
    </>
  );
}

/**
 * "Install the Growzar app", above Sign out (pre-Wave-1 pack 3). Only where the
 * browser can install it, or as the Add to Home Screen how-to on an iPhone;
 * never inside the installed app, and never as a pop-up.
 */
function InstallApp() {
  const offer = useInstallOffer();
  const row = "flex max-md:min-h-11 w-full items-center gap-3 rounded-full px-3.5 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-field hover:text-gray-900";
  if (offer === "prompt") {
    return (
      <button type="button" onClick={() => void promptInstall()} className={row}>
        <Download className="h-[18px] w-[18px]" />
        Install the Growzar app
      </button>
    );
  }
  if (offer === "ios") {
    return (
      <details className="group">
        <summary className={cn(row, "cursor-pointer list-none")}>
          <Download className="h-[18px] w-[18px]" />
          Install the Growzar app
        </summary>
        <p className="mx-3.5 mb-2 mt-1 rounded-xl bg-field px-3 py-2.5 text-sm leading-relaxed text-gray-700">
          Tap <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" /> Share at the bottom of Safari, then{" "}
          <strong>Add to Home Screen</strong>.
        </p>
      </details>
    );
  }
  return null;
}

/** The sidebar's contents: the switchers, the sections, Install and Sign out. The phone drawer shows the same. */
function Navigation({ loaderData }: { loaderData: Route.ComponentProps["loaderData"] }) {
  const { organization, organizations, stores, activeStoreId, sections, ask } =
    loaderData;
  // Switching a store keeps you on the page you were reading.
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}`;
  const activeStore = stores.find((store) => store.id === activeStoreId);

  return (
    <>
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
                  "block w-full truncate px-3 py-2 text-left max-md:py-3 text-sm transition hover:bg-gray-50",
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
            className="block border-t border-gray-100 px-3 py-2 text-sm max-md:py-3 font-medium text-accent-600 hover:bg-gray-50"
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
                    "block w-full truncate px-3 py-2 text-left max-md:py-3 text-sm transition hover:bg-gray-50",
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
              className="block border-t border-gray-100 px-3 py-2 text-sm max-md:py-3 font-medium text-accent-600 hover:bg-gray-50"
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
            <Fragment key={item.section}>
            <NavLink
              to={to}
              className={({ isActive }) =>
                cn(
                  "group flex max-md:min-h-11 items-center gap-3 rounded-full px-3.5 py-2.5 text-sm transition",
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
            {/* Every finding, under Home, which shows only what needs action. */}
            {item.section === "home" ? (
              <NavLink
                to="/insights"
                className={({ isActive }) =>
                  cn(
                    "group flex max-md:min-h-11 items-center gap-3 rounded-full px-3.5 py-2.5 text-sm transition",
                    isActive ? "active bg-navy font-semibold text-white" : "font-medium text-gray-700 hover:bg-field",
                  )
                }
              >
                <Lightbulb className="h-[18px] w-[18px] flex-shrink-0 group-[.active]:text-mint" />
                <span className="flex-1 truncate">Insights</span>
              </NavLink>
            ) : null}
            {/* Ask about your stores (G-GZR10-3), under Home, where it is turned on. */}
            {item.section === "home" && ask ? (
              <NavLink
                to="/ask"
                className={({ isActive }) =>
                  cn(
                    "group flex max-md:min-h-11 items-center gap-3 rounded-full px-3.5 py-2.5 text-sm transition",
                    isActive ? "active bg-navy font-semibold text-white" : "font-medium text-gray-700 hover:bg-field",
                  )
                }
              >
                <MessageCircleQuestionMark className="h-[18px] w-[18px] flex-shrink-0 group-[.active]:text-mint" />
                <span className="flex-1 truncate">Ask</span>
              </NavLink>
            ) : null}
            {/* What happened after findings were acted on (G-GZR9-5), also under Home. */}
            {item.section === "home" ? (
              <NavLink
                to="/results"
                className={({ isActive }) =>
                  cn(
                    "group flex max-md:min-h-11 items-center gap-3 rounded-full px-3.5 py-2.5 text-sm transition",
                    isActive ? "active bg-navy font-semibold text-white" : "font-medium text-gray-700 hover:bg-field",
                  )
                }
              >
                <Activity className="h-[18px] w-[18px] flex-shrink-0 group-[.active]:text-mint" />
                <span className="flex-1 truncate">Results</span>
              </NavLink>
            ) : null}
            </Fragment>
          );
        })}
      </nav>

      <div className="mt-auto pt-6">
      <InstallApp />
      <Form method="post" action="/auth/sign-out">
        <button
          type="submit"
          className="flex max-md:min-h-11 w-full items-center gap-3 rounded-full px-3.5 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-field hover:text-gray-900"
        >
          <LogOut className="h-[18px] w-[18px]" />
          Sign out
        </button>
      </Form>
      </div>
    </>
  );
}

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { stores, activeStoreId } = loaderData;
  const activeStore = stores.find((store) => store.id === activeStoreId);
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // The drawer closes on every navigation, and on Escape.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  return (
    <div className="min-h-screen bg-field">
      <div className="mx-auto flex max-w-[1440px] gap-5 p-3 md:p-4">
        <aside className="hidden w-60 flex-shrink-0 flex-col rounded-2xl bg-white p-4 md:sticky md:top-4 md:flex md:h-[calc(100vh-2rem)] md:overflow-y-auto">
          <Navigation loaderData={loaderData} />
        </aside>

        {/* A phone's menu (pre-Wave-1 pack 3): the sidebar, as a drawer from the left. */}
        {menuOpen ? (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <button type="button" aria-label="Close menu" className="absolute inset-0 bg-navy/40" onClick={() => setMenuOpen(false)} />
            <div className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col overflow-y-auto bg-white p-4 shadow-xl">
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
                className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full text-gray-500 hover:bg-field"
              >
                <X className="h-5 w-5" />
              </button>
              <Navigation loaderData={loaderData} />
            </div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 px-1 py-2 md:px-2">
          {/* The phone's top bar: the menu, the wordmark and the store. */}
          <div className="-mt-1 mb-4 flex items-center gap-1 md:hidden">
            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              className="-ml-2 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-navy hover:bg-white"
            >
              <Menu className="h-6 w-6" />
            </button>
            <Link to="/home" className="flex min-h-11 items-center gap-2">
              <Logo />
            </Link>
            {activeStore ? (
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                className="ml-auto flex min-h-11 min-w-0 items-center gap-1.5 text-sm text-gray-600"
              >
                <StoreIcon className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{activeStore.displayName ?? activeStore.shopDomain}</span>
              </button>
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
  const error = useRouteError();
  // A crash in the browser is sent to the server log; a loader's is logged there already.
  useEffect(() => {
    if (!isRouteErrorResponse(error)) reportClientError(error);
  }, [error]);
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
