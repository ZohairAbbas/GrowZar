import { Link } from "react-router";
import { Check, Clock, Lock } from "lucide-react";

import type { Route } from "./+types/section";
import { prisma } from "~/lib/db.server";
import { listVisibleStores, requireSection } from "~/lib/authorize.server";
import { SECTIONS, type Section } from "~/lib/permissions";
import {
  APP_LABELS,
  SECTION_DEFINITIONS,
  sectionState,
} from "~/lib/sections";
import { readStoreCookie } from "~/lib/store-cookie.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `${loaderData.label} · Growzar` : "Growzar" }];
}

/**
 * One module for all eight non-settings sections.
 *
 * In Phase 1 a section is either **locked**, with a preview of what connecting
 * the app would give (D-04, D-16), or **open** and honest that its content
 * arrives in Phases 2 and 3. What it is never is a half-built screen (D-43).
 *
 * The permission check is `requireSection`, so a role that cannot see Finance
 * gets 403 from this loader — not a hidden nav item.
 */
function sectionFromPath(pathname: string): Section {
  const candidate = pathname.split("/").filter(Boolean)[0] ?? "home";
  return (SECTIONS as readonly string[]).includes(candidate)
    ? (candidate as Section)
    : "home";
}

export async function loader({ request }: Route.LoaderArgs) {
  const section = sectionFromPath(new URL(request.url).pathname);
  const definition = SECTION_DEFINITIONS[section];

  const viewer = await requireSection(request, section, "view");

  const stores = await listVisibleStores(viewer);
  const remembered = readStoreCookie(request);
  const active = stores.find((s) => s.id === remembered) ?? stores[0] ?? null;

  const connections = active
    ? await prisma.appConnection.findMany({
        where: { storeId: active.id },
        select: { app: true, status: true, lastSyncedAt: true },
      })
    : [];

  const state = sectionState(definition, connections);

  // Home is the one section with something real to show in Phase 1: the
  // stores, and whether their apps are talking.
  const homeStores =
    section === "home"
      ? await Promise.all(
          stores.map(async (store) => ({
            id: store.id,
            shopDomain: store.shopDomain,
            displayName: store.displayName,
            currency: store.currency,
            connections: await prisma.appConnection.findMany({
              where: { storeId: store.id },
              select: { app: true, status: true, lastSyncedAt: true },
              orderBy: { app: "asc" },
            }),
          })),
        )
      : [];

  const customerCount =
    section === "customers" && active
      ? await prisma.customer.count({
          where: { storeId: active.id, mergedIntoId: null },
        })
      : null;

  return {
    section,
    label: definition.label,
    blurb: definition.blurb,
    preview: definition.preview,
    state: {
      kind: state.kind,
      apps:
        state.kind === "locked"
          ? state.missing.map((app) => APP_LABELS[app])
          : state.kind === "reconnect"
            ? state.apps.map((app) => APP_LABELS[app])
            : [],
      asOf: state.kind === "reconnect" ? (state.asOf?.toISOString() ?? null) : null,
    },
    storeName: active?.displayName ?? active?.shopDomain ?? null,
    homeStores: homeStores.map((store) => ({
      ...store,
      connections: store.connections.map((c) => ({
        app: c.app,
        status: c.status,
        lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      })),
    })),
    customerCount,
  };
}

export default function SectionPage({ loaderData }: Route.ComponentProps) {
  const { label, blurb, preview, state, section, homeStores, customerCount } =
    loaderData;

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{label}</h1>
        <p className="mt-1 text-sm text-gray-600">{blurb}</p>
      </header>

      {state.kind === "locked" ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-8">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100">
            <Lock className="h-6 w-6 text-gray-500" />
          </span>
          <h2 className="text-lg font-semibold text-gray-900">
            Connect {state.apps.join(" or ")} to get insights
          </h2>
          <p className="mt-1.5 text-sm text-gray-600">
            Here is what this section would show you.
          </p>

          {/*
            A preview rather than an empty screen (D-43): a single-app merchant
            should be able to see what the rest of the suite is for without
            installing it first.
          */}
          <ul className="mt-5 space-y-2.5">
            {preview.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-sm text-gray-700">
                <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
                {line}
              </li>
            ))}
          </ul>

          <p className="mt-6 text-xs text-gray-500">
            Install {state.apps.join(" or ")} on your Shopify store, then press
            “Open in Growzar” inside it. Nothing to copy or paste.
          </p>
        </section>
      ) : null}

      {state.kind === "reconnect" ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100">
            <Clock className="h-5 w-5 text-amber-700" />
          </span>
          <h2 className="text-base font-semibold text-gray-900">
            {state.apps.join(" and ")} {state.apps.length > 1 ? "were" : "was"}{" "}
            uninstalled
          </h2>
          {/*
            Reconnect mode (D-17): the data stays, stamped, and actions are
            disabled. Nothing is deleted on uninstall.
          */}
          <p className="mt-1.5 text-sm text-amber-900">
            Showing what we had
            {state.asOf
              ? ` as of ${new Date(state.asOf).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}`
              : " from before"}
            . Nothing has been deleted. Reinstall to start updating it again.
          </p>
        </section>
      ) : null}

      {state.kind === "open" && section === "home" ? (
        <section className="space-y-3">
          {homeStores.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
              Nothing to show yet.
            </p>
          ) : (
            homeStores.map((store) => (
              <Link
                key={store.id}
                to={`/stores/${store.id}`}
                className="block rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-gray-300 hover:shadow-sm"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-gray-900">
                    {store.displayName ?? store.shopDomain}
                  </span>
                  <span className="text-sm text-gray-500">
                    {/* From the app, never defaulted (rule #4). */}
                    {store.currency ?? "currency not reported yet"}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-gray-500">
                  {store.shopDomain}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {store.connections.length === 0 ? (
                    <span className="text-xs text-gray-500">No apps connected</span>
                  ) : (
                    store.connections.map((connection) => (
                      <span
                        key={connection.app}
                        className={
                          connection.status === "CONNECTED"
                            ? "rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700"
                            : "rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700"
                        }
                      >
                        {APP_LABELS[connection.app as keyof typeof APP_LABELS]}
                      </span>
                    ))
                  )}
                </div>
              </Link>
            ))
          )}
        </section>
      ) : null}

      {state.kind === "open" && section !== "home" ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-8">
          <h2 className="text-lg font-semibold text-gray-900">
            Connected and collecting
          </h2>
          <p className="mt-1.5 text-sm text-gray-600">
            Growzar is syncing this store's data now.
            {section === "customers" && customerCount !== null ? (
              <>
                {" "}
                <strong className="text-gray-900">
                  {customerCount.toLocaleString()}
                </strong>{" "}
                {customerCount === 1 ? "buyer" : "buyers"} so far, counted once
                each however they spell their phone number.
              </>
            ) : null}{" "}
            The numbers and the insights arrive in the next two phases — this
            section stays deliberately empty until they can be trusted.
          </p>

          <ul className="mt-5 space-y-2.5">
            {preview.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-sm text-gray-600">
                <Clock className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
                {line}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
