import { Link } from "react-router";
import { Check, Clock, Lock } from "lucide-react";

import type { Route } from "./+types/section";
import { prisma } from "~/lib/db.server";
import { hasPermission, listVisibleStores, requireSection } from "~/lib/authorize.server";
import { inboxView } from "~/lib/insights/inbox.server";
import { SECTIONS, type Section } from "~/lib/permissions";
import {
  APP_LABELS,
  SECTION_DEFINITIONS,
  sectionState,
} from "~/lib/sections";
import { readStoreCookie } from "~/lib/store-cookie.server";
import { storeSummary } from "~/lib/metrics/summaries.server";
import {
  PERIODS,
  customersView,
  financeView,
  homeView,
  ordersView,
  parseOutcome,
  owedToday,
  periodFrom,
  shippingView,
  marketingView,
  storePayoutAgeing,
  financeDepth,
  shippingDepth,
} from "~/lib/metrics/screens.server";
import { confirmationFunnel, isConfirmationGroup } from "~/lib/metrics/matrices";
import {
  CustomersPanel,
  FinancePanel,
  MarketingPanel,
  HomePanel,
  OrdersPanel,
  ShippingPanel,
} from "~/components/metrics/SectionPanels";
import { CoverageLine } from "~/components/metrics/Metrics";
import { InventoryPanel } from "~/components/metrics/InventoryPanel";
import { inventorySection } from "~/lib/metrics/inventory.server";
import { messagingSection } from "~/lib/metrics/messaging.server";
import { MessagingPanel } from "~/components/metrics/MessagingPanel";
import { checkoutsSection, formAbandonmentsSection } from "~/lib/metrics/checkouts.server";
import { CheckoutsPanel } from "~/components/metrics/CheckoutsPanel";
import { consentSection } from "~/lib/metrics/consent.server";
import { ConsentPanel } from "~/components/metrics/ConsentPanel";
import { FilterBar } from "~/components/metrics/FilterBar";
import { previousPeriod, withoutComparison } from "~/lib/metrics/compare";
import { NO_SCOPE, parseScope, scopeQuery } from "~/lib/metrics/scope";
import { storeCoverage } from "~/lib/metrics/coverage.server";
import { coverageLine } from "~/lib/metrics/coverage";
import { orderFilterQuery, parseOrderFilter } from "~/lib/metrics/findings";

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

export async function loader({ request, url }: Route.LoaderArgs) {
  // `url`, not `request.url`: a client-side navigation requests
  // `/finance.data?_routes=…`, and reading that raw path made every section
  // fall back to Home's data while the address bar said Finance. React Router
  // normalises `url` for exactly this; `request.url` is the raw wire request.
  const section = sectionFromPath(url.pathname);
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

  // G-GZR2-5: an open section shows the metric layer for the active store.
  // One view per request, built from storeSummary; the order rows it reads
  // stay on the server.
  let metrics: Awaited<ReturnType<typeof buildMetrics>> = null;
  if (state.kind === "open" && active && METRIC_SECTIONS.has(section)) {
    metrics = await buildMetrics(section, active.id, url, async () => ({
      userId: viewer.userId,
      // Money on Home only for a role that may see Finance (staff may not).
      canSeeMoney: await hasPermission(request, viewer.organizationId, "finance", "view"),
      canManage: await hasPermission(request, viewer.organizationId, "home", "manage"),
    }));
  }

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
    metrics,
    filterStores: {
      activeId: active?.id ?? null,
      list: stores.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain })),
      returnTo: url.pathname,
    },
  };
}

const METRIC_SECTIONS = new Set<Section>(["home", "finance", "orders", "shipping", "customers", "marketing", "inventory"]);

async function buildMetrics(
  section: Section,
  storeId: string,
  url: URL,
  inboxViewer: () => Promise<Parameters<typeof inboxView>[2]>,
) {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { timezone: true } });
  const period = periodFrom(url, store.timezone);
  // Home's insights are store-wide, so Home takes no courier or city; stock
  // has neither.
  const storeWide = section === "home" || section === "inventory";
  const scope = storeWide ? NO_SCOPE : parseScope(url.searchParams);
  const before = previousPeriod(period.from, period.to);
  const [summary, prev, first] = await Promise.all([
    storeSummary(storeId, period.from, period.to, scope),
    // Orders compare by count in their own query; the rest against this.
    section === "orders" ? null : storeSummary(storeId, before.from, before.to, scope),
    prisma.orderGrain.aggregate({ where: { storeId }, _min: { localDay: true } }),
  ]);
  // No comparison against a period the store's history only partly covers.
  const historyFrom = first._min.localDay;
  const comparable = historyFrom !== null && historyFrom <= before.from;
  const compared = <T,>(view: T): T => (comparable ? view : withoutComparison(view));
  // A filter (a finding's evidence) survives a change of period.
  // A bare `city` is the filter bar's now (D2), not the city card's filter:
  // the two select the same orders, and one banner is enough.
  const parsed = section === "orders" ? parseOrderFilter(url.searchParams) : null;
  const filter = parsed?.kind === "city" ? null : parsed;
  const confirmation = section === "orders" && isConfirmationGroup(url.searchParams.get("confirmation")) ? url.searchParams.get("confirmation") : null;
  // So does an outcome picked from the Orders chips.
  const outcome = section === "orders" ? parseOutcome(url.searchParams) : null;
  // The finding filter's own city and courier travel in the scope query.
  const filterQuery = filter ? new URLSearchParams([...new URLSearchParams(orderFilterQuery(filter))].filter(([k]) => k !== "city" && k !== "courier")).toString() : "";
  const extra = [filterQuery, outcome ? `outcome=${outcome}` : "", confirmation ? `confirmation=${confirmation}` : ""].filter(Boolean).join("&");
  const keep = [extra, scopeQuery(scope)].filter(Boolean).join("&");
  // One line naming the gaps behind this section's numbers (D1).
  const coverage = coverageLine(await storeCoverage(summary), section);
  const base = {
    period,
    periods: PERIODS,
    keep,
    coverage,
    previous: before,
    historyFrom: comparable ? null : historyFrom,
    firstDay: historyFrom,
    scope,
    scopeOptions: storeWide ? null : summary.scopeOptions,
    /** Query parameters a change of courier or city keeps (the finding filter and outcome). */
    keepForScope: extra,
  };
  switch (section) {
    case "home": {
      const viewer = await inboxViewer();
      return {
        ...base,
        kind: "home" as const,
        view: compared(homeView(summary, prev!, viewer.canSeeMoney)),
        owed: viewer.canSeeMoney ? await owedToday(storeId) : null,
        inbox: await inboxView(summary, period.days, viewer),
      };
    }
    case "finance":
      return {
        ...base,
        kind: "finance" as const,
        view: compared(financeView(summary, prev!)),
        ageing: await storePayoutAgeing(storeId, summary.store.currency, scope),
        depth: await financeDepth(storeId, summary),
      };
    case "orders":
      return {
        ...base,
        kind: "orders" as const,
        view: compared(await ordersView(storeId, period.from, period.to, filter, outcome, scope, before, confirmation)),
        funnel: confirmationFunnel(summary.rows),
        confirmation,
      };
    case "shipping":
      return {
        ...base,
        kind: "shipping" as const,
        view: compared(shippingView(summary, prev!)),
        depth: await shippingDepth(storeId, summary),
      };
    case "customers": {
      // Gross profit in the cohorts only for a role that may see Finance.
      const viewer = await inboxViewer();
      return {
        ...base,
        kind: "customers" as const,
        view: compared(await customersView(storeId, summary, prev!, viewer.canSeeMoney)),
        canSeeMoney: viewer.canSeeMoney,
        consent: await consentSection(storeId, period),
      };
    }
    case "marketing": {
      const viewer = await inboxViewer();
      return {
        ...base,
        kind: "marketing" as const,
        view: await marketingView(storeId, summary),
        messaging: await messagingSection(storeId, period),
        checkouts: await checkoutsSection(storeId, period),
        formAbandonments: await formAbandonmentsSection(storeId, period),
        retainifyConnected: (await prisma.appConnection.count({ where: { storeId, app: "RETAINIFY", status: "CONNECTED" } })) > 0,
        canSeeMoney: viewer.canSeeMoney,
      };
    }
    case "inventory":
      return { ...base, kind: "inventory" as const, view: await inventorySection(storeId, period, summary.store.currency) };
    default:
      return null;
  }
}

export default function SectionPage({ loaderData }: Route.ComponentProps) {
  const { label, blurb, preview, state, section, homeStores, customerCount, metrics, storeName, filterStores } =
    loaderData;

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-gray-900">{label}</h1>
          <p className="mt-1 text-gray-600">{blurb}</p>
        </div>
      </header>

      {metrics ? (
        <div className="mb-6 space-y-4">
          <p className="text-xs text-gray-500">
            {storeName} · {metrics.period.from} to {metrics.period.to}, the store's own days (
            {metrics.period.timezoneKnown ? metrics.period.timezone : "timezone not reported yet, shown in UTC"})
          </p>
          <FilterBar
            section={section}
            stores={filterStores}
            period={metrics.period}
            firstDay={metrics.firstDay}
            periods={metrics.periods}
            previous={metrics.previous}
            historyFrom={metrics.historyFrom}
            scope={metrics.scope}
            options={metrics.scopeOptions}
            keep={metrics.keepForScope}
          />
          <CoverageLine gaps={metrics.coverage.gaps} period={metrics.period.query} />
          {metrics.kind === "home" ? <HomePanel view={metrics.view} owed={metrics.owed} inbox={metrics.inbox} period={metrics.period} /> : null}
          {metrics.kind === "finance" ? <FinancePanel view={metrics.view} ageing={metrics.ageing} depth={metrics.depth} period={metrics.period.query} scope={scopeQuery(metrics.scope)} /> : null}
          {metrics.kind === "marketing" ? <MarketingPanel view={metrics.view} period={metrics.period.query} scope={scopeQuery(metrics.scope)} /> : null}
          {metrics.kind === "marketing" && metrics.checkouts ? <CheckoutsPanel view={metrics.checkouts} canSeeMoney={metrics.canSeeMoney} /> : null}
          {metrics.kind === "marketing" && metrics.formAbandonments ? (
            <CheckoutsPanel view={metrics.formAbandonments} canSeeMoney={metrics.canSeeMoney} source="cod_form" retainifyConnected={metrics.retainifyConnected} />
          ) : null}
          {metrics.kind === "marketing" && metrics.messaging ? <MessagingPanel view={metrics.messaging} periodDays={metrics.period.days} /> : null}
          {metrics.kind === "orders" ? <OrdersPanel view={metrics.view} period={metrics.period.query} scope={scopeQuery(metrics.scope)} funnel={metrics.funnel} confirmation={metrics.confirmation} /> : null}
          {metrics.kind === "shipping" ? <ShippingPanel view={metrics.view} depth={metrics.depth} period={metrics.period.query} scope={metrics.scope} /> : null}
          {metrics.kind === "customers" ? <CustomersPanel view={metrics.view} canSeeMoney={metrics.canSeeMoney} canMessage={metrics.consent?.byCustomer ?? null} /> : null}
          {metrics.kind === "customers" && metrics.consent ? <ConsentPanel view={metrics.consent.view} periodDays={metrics.period.days} /> : null}
          {metrics.kind === "inventory" ? <InventoryPanel view={metrics.view} periodDays={metrics.period.days} /> : null}
        </div>
      ) : null}

      {state.kind === "locked" ? (
        <section className="rounded-2xl bg-white p-8">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100">
            <Lock className="h-6 w-6 text-gray-500" />
          </span>
          <h2 className="font-display text-lg font-bold text-gray-900">
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
          <h2 className="font-display text-base font-bold text-gray-900">
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
          {homeStores.length >= 2 ? (
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-gray-900">Your stores</h2>
              <Link to={`/compare?${metrics?.period.query ?? "days=30"}`} className="text-sm font-semibold text-accent-600 hover:underline">
                Compare stores side by side →
              </Link>
            </div>
          ) : null}
          {homeStores.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
              Nothing to show yet.
            </p>
          ) : (
            homeStores.map((store) => (
              <Link
                key={store.id}
                to={`/stores/${store.id}`}
                className="block rounded-2xl bg-white p-5 transition hover:shadow-md"
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

      {state.kind === "open" && section !== "home" && !metrics ? (
        <section className="rounded-2xl bg-white p-8">
          <h2 className="font-display text-lg font-bold text-gray-900">
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
