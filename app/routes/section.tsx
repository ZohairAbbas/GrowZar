import { Link, redirect } from "react-router";
import { Check, Clock, Lock } from "lucide-react";

import type { Route } from "./+types/section";
import { prisma } from "~/lib/db.server";
import { askEnabled } from "~/lib/ask/loop.server";
import { sectionPreview } from "~/lib/metrics/section-preview.server";
import { SUITE_APPS, type LinkedApp } from "~/lib/apps/app-links";
import { getViewer, hasPermission, listVisibleStores, requireSection } from "~/lib/authorize.server";
import { booksVisible } from "~/lib/books-app/access.server";
import { inboxView } from "~/lib/insights/inbox.server";
import { resultCounts } from "~/lib/outcomes/line";
import { outcomeLinesOf } from "~/lib/outcomes/results.server";
import { SECTIONS, type Section } from "~/lib/permissions";
import {
  APP_LABELS,
  SECTION_DEFINITIONS,
  sectionState,
} from "~/lib/sections";
import { readStoreCookie, rememberLinkedStore } from "~/lib/store-cookie.server";
import { loadSettledHistory, storeSummary } from "~/lib/metrics/summaries.server";
import {
  PERIODS,
  customersView,
  financeView,
  homeView,
  ordersView,
  parseOutcome,
  homeCards,
  periodFrom,
  shippingView,
  marketingView,
  storePayoutAgeing,
  financeDepth,
  shippingDepth,
  productProfit,
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
import { CoverageLine, DataHealth } from "~/components/metrics/Metrics";
import { InventoryPanel } from "~/components/metrics/InventoryPanel";
import { inventorySection } from "~/lib/metrics/inventory.server";
import { parseStockState } from "~/lib/metrics/inventory";
import { messagingSection } from "~/lib/metrics/messaging.server";
import { MessagingPanel } from "~/components/metrics/MessagingPanel";
import { checkoutsSection, formAbandonmentsSection } from "~/lib/metrics/checkouts.server";
import { CheckoutsPanel } from "~/components/metrics/CheckoutsPanel";
import { offersSection } from "~/lib/metrics/offers.server";
import { OffersPanel } from "~/components/metrics/OffersPanel";
import { consentSection } from "~/lib/metrics/consent.server";
import { ConsentPanel } from "~/components/metrics/ConsentPanel";
import { buyerHistorySection } from "~/lib/metrics/buyer-history.server";
import { BuyerHistoryPanel } from "~/components/metrics/BuyerHistoryPanel";
import { nextAppSection } from "~/lib/metrics/next-app.server";
import { buyerNetworkSection, loadNetworkAnswers } from "~/lib/metrics/buyer-network.server";
import { lineOf, type BuyerNetworkLine } from "~/lib/metrics/buyer-network";
import { BuyerNetworkPanel } from "~/components/metrics/BuyerNetworkPanel";
import { conversationsSection } from "~/lib/metrics/conversations.server";
import { ConversationsPanel } from "~/components/metrics/ConversationsPanel";
import { FilterBar } from "~/components/metrics/FilterBar";
import { previousPeriod, withoutComparison } from "~/lib/metrics/compare";
import { NO_SCOPE, parseScope, scopeQuery } from "~/lib/metrics/scope";
import { storeCoverage } from "~/lib/metrics/coverage.server";
import { coverageLine } from "~/lib/metrics/coverage";
import { orderFilterQuery, parseOrderFilter } from "~/lib/metrics/findings";
import { riskActions, riskVisible, storeRisk } from "~/lib/forecast/return-risk.server";
import { receivedInBank } from "~/lib/books-app/bank-receipts.server";
import { draftsWaiting } from "~/lib/books-app/access.server";

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

  // Sign-in lands on Home; an accountant (D-70) has no Home, so lands on Books, else Finance.
  if (section === "home") {
    const who = await getViewer(request);
    if (!(await hasPermission(request, who.organizationId, "home", "view"))) {
      if (await booksVisible(request, who)) throw redirect("/books");
      if (await hasPermission(request, who.organizationId, "finance", "view")) throw redirect("/finance");
    }
  }

  const viewer = await requireSection(request, section, "view");

  const stores = await listVisibleStores(viewer);
  const linked = rememberLinkedStore(url, stores);
  if (linked) throw linked;
  const remembered = readStoreCookie(request);
  const active = stores.find((s) => s.id === remembered) ?? stores[0] ?? null;

  const connections = active
    ? await prisma.appConnection.findMany({
        where: { storeId: active.id },
        select: { app: true, status: true, lastSyncedAt: true },
      })
    : [];

  const state = sectionState(definition, connections);


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

  // A locked section shows what Growzar already sees in this store's own
  // numbers beside what connecting adds (G-GZR6-4).
  const lockedPreview =
    state.kind === "locked" && active
      ? await sectionPreview(section, { id: active.id, currency: active.currency ?? null }, await hasPermission(request, viewer.organizationId, "finance", "view"))
      : null;

  // Home's Ask box, where Ask is on for the server and the organization (G-GZR10-3).
  const ask = section === "home" && askEnabled() && Boolean((await prisma.askSettings.findUnique({ where: { organizationId: viewer.organizationId }, select: { enabled: true } }))?.enabled);
  // Books' drafts waiting (B7): on Home for a viewer who can open Books.
  const booksDrafts = section === "home" ? await draftsWaiting(request, viewer) : null;

  return {
    ask,
    booksDrafts,
    section,
    label: definition.label,
    blurb: definition.blurb,
    preview: definition.preview,
    lockedPreview,
    storeId: active?.id ?? null,
    /** The missing apps' keys, for their Install buttons. */
    missingApps: state.kind === "locked" ? state.missing.filter((a): a is LinkedApp => Object.hasOwn(SUITE_APPS, a)) : [],
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
    storeCount: stores.length,
    // Home greets by the store's own clock, worked out here so the page
    // does not change after it loads.
    greeting: section === "home" ? greetingAt(active?.timezone ?? null) : null,
    customerCount,
    metrics,
    filterStores: {
      activeId: active?.id ?? null,
      list: stores.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain })),
      returnTo: url.pathname,
    },
  };
}

const METRIC_SECTIONS = new Set<Section>(["home", "finance", "orders", "shipping", "customers", "marketing", "inventory", "inbox"]);

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
  const storeWide = section === "home" || section === "inventory" || section === "inbox";
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
  // Return risk (G-GZR11-4): behind its switch, for every organization on stores with Courierify (pre-Wave-1 pack 2).
  const riskOn = section === "orders" && (await riskVisible(storeId));
  const filter = parsed?.kind === "city" || (parsed?.kind === "risk_high" && !riskOn) ? null : parsed;
  const confirmation = section === "orders" && isConfirmationGroup(url.searchParams.get("confirmation")) ? url.searchParams.get("confirmation") : null;
  // So does an outcome picked from the Orders chips.
  const outcome = section === "orders" ? parseOutcome(url.searchParams) : null;
  // The finding filter's own city and courier travel in the scope query.
  const filterQuery = filter ? new URLSearchParams([...new URLSearchParams(orderFilterQuery(filter))].filter(([k]) => k !== "city" && k !== "courier")).toString() : "";
  // And a stock state picked from the Inventory chips.
  const stock = section === "inventory" ? parseStockState(url.searchParams) : null;
  const extra = [filterQuery, outcome ? `outcome=${outcome}` : "", confirmation ? `confirmation=${confirmation}` : "", stock ? `stock=${stock}` : ""].filter(Boolean).join("&");
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
      const inbox = await inboxView(summary, period.days, viewer);
      return {
        ...base,
        kind: "home" as const,
        view: compared(homeView(summary, prev!, viewer.canSeeMoney)),
        cards: await homeCards(storeId, summary, viewer.canSeeMoney),
        inbox,
        // Cross-sell (G-GZR6-3): the store's own figures for the apps it lacks.
        nextApp: await nextAppSection(summary.store, new Set(inbox.connected), viewer),
        // One Results row once anything is measured (G-GZR9-5).
        results: resultCounts(await outcomeLinesOf([storeId], viewer)),
      };
    }
    case "finance":
      return {
        ...base,
        kind: "finance" as const,
        view: compared(financeView(summary, prev!)),
        ageing: await storePayoutAgeing(storeId, summary.store.currency, scope),
        depth: await financeDepth(storeId, summary),
        // Rule #17's second stage, from Books where statements are matched (B7); null elsewhere.
        bank: !scope.courier && !scope.city ? await receivedInBank(storeId, period.from, period.to) : null,
      };
    case "orders": {
      const risk = riskOn ? await storeRisk(storeId) : null;
      const highRisk = risk ? new Set([...risk.orders].filter(([, r]) => r.band === "high").map(([id]) => id)) : undefined;
      const view = await ordersView(storeId, period.from, period.to, filter, outcome, scope, before, confirmation, highRisk);
      return {
        ...base,
        kind: "orders" as const,
        view: compared(view),
        funnel: confirmationFunnel(summary.rows),
        confirmation,
        risk: risk
          ? {
              rows: Object.fromEntries(view.rows.flatMap((r) => (risk.orders.has(r.orderId) ? [[r.orderId, risk.orders.get(r.orderId)!]] : []))),
              high: highRisk!.size,
              actions: await riskActions(storeId, summary.store.shopDomain),
              storeId,
              storeRate: risk.cuts.storeRate,
            }
          : null,
      };
    }
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
      const view = await customersView(storeId, summary, prev!, viewer.canSeeMoney);
      // Courierify's network, when it has answered for any buyer (G-GZR5-16).
      const network = await buyerNetworkSection(storeId, new Set(summary.rows.map((r) => r.customerId).filter((c): c is string => !!c)));
      const topAnswers = network ? await loadNetworkAnswers(storeId, view.top.map((t) => t.customerId)) : null;
      return {
        ...base,
        kind: "customers" as const,
        view: compared(view),
        canSeeMoney: viewer.canSeeMoney,
        network,
        topNetwork: topAnswers
          ? Object.fromEntries(view.top.map((t) => [t.customerId, (topAnswers.get(t.customerId) && lineOf(topAnswers.get(t.customerId)!)) ?? null])) as Record<string, BuyerNetworkLine | null>
          : null,
        consent: await consentSection(storeId, period),
        buyerHistory: await buyerHistorySection(storeId, period),
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
        offers: await offersSection(storeId, period),
        reminderAppConnected: (await prisma.appConnection.count({ where: { storeId, app: { in: ["RETAINIFY", "WHATKABOT"] }, status: "CONNECTED" } })) > 0,
        canSeeMoney: viewer.canSeeMoney,
      };
    }
    case "inbox": {
      const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { shopDomain: true } });
      return {
        ...base,
        kind: "inbox" as const,
        view: await conversationsSection(storeId, period),
        // WhatKaBot's app in the merchant's own Shopify admin; it exports no link to a single conversation.
        whatkabotUrl: `https://admin.shopify.com/store/${store.shopDomain.replace(/\.myshopify\.com$/, "")}/apps/whatkabot`,
      };
    }
    case "inventory": {
      // Profit by variant only for a role that may see Finance.
      const viewer = await inboxViewer();
      const [history, profit] = await Promise.all([loadSettledHistory(storeId, period.today), viewer.canSeeMoney ? productProfit(storeId, summary) : null]);
      return {
        ...base,
        kind: "inventory" as const,
        view: await inventorySection(storeId, period, summary.store.currency, undefined, stock, { history, profit }),
        canSeeMoney: viewer.canSeeMoney,
      };
    }
    default:
      return null;
  }
}

function greetingAt(timezone: string | null, at = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: timezone ?? "UTC" }).format(at));
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

const periodWords = (p: { days: number; custom: boolean; from: string; to: string }) =>
  p.custom ? `from ${p.from} to ${p.to}` : `over the last ${p.days} days`;

export default function SectionPage({ loaderData }: Route.ComponentProps) {
  const { label, blurb, preview, state, section, storeCount, greeting, customerCount, metrics, storeName, filterStores, lockedPreview, storeId, missingApps } =
    loaderData;

  if (metrics?.kind === "home") {
    // Home: what needs the merchant, then how the store is doing. Filters,
    // coverage and currency notes sit behind the period picker and the
    // data chip; the detail is one click away in each section.
    return (
      <div>
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight text-gray-900">{greeting ?? label}</h1>
            <p className="mt-1 text-gray-600">
              Here&apos;s {storeName ?? "your store"} {periodWords(metrics.period)}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {storeCount >= 2 ? (
              <Link to={`/compare?${metrics.period.query}`} className="px-2 text-sm font-semibold text-accent-600 hover:underline">
                Compare stores
              </Link>
            ) : null}
            <FilterBar
              section={section}
              stores={filterStores}
              period={metrics.period}
              firstDay={metrics.firstDay}
              periods={metrics.periods}
              previous={metrics.previous}
              historyFrom={metrics.historyFrom}
              scope={metrics.scope}
              options={null}
              keep=""
              compact
            />
            <DataHealth gaps={metrics.coverage.gaps} fx={metrics.view.fx} period={metrics.period.query} />
          </div>
        </header>
        <HomePanel view={metrics.view} inbox={metrics.inbox} cards={metrics.cards} period={metrics.period} nextApp={metrics.nextApp} results={metrics.results} ask={loaderData.ask} booksDrafts={loaderData.booksDrafts} />
      </div>
    );
  }

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
          {metrics.kind === "finance" ? <FinancePanel view={metrics.view} ageing={metrics.ageing} depth={metrics.depth} bank={metrics.bank} period={metrics.period.query} scope={scopeQuery(metrics.scope)} /> : null}
          {metrics.kind === "marketing" ? <MarketingPanel view={metrics.view} period={metrics.period.query} scope={scopeQuery(metrics.scope)} /> : null}
          {metrics.kind === "marketing" && metrics.checkouts ? <CheckoutsPanel view={metrics.checkouts} canSeeMoney={metrics.canSeeMoney} /> : null}
          {metrics.kind === "marketing" && metrics.formAbandonments ? (
            <CheckoutsPanel view={metrics.formAbandonments} canSeeMoney={metrics.canSeeMoney} source="cod_form" reminderAppConnected={metrics.reminderAppConnected} />
          ) : null}
          {metrics.kind === "marketing" && metrics.offers ? <OffersPanel view={metrics.offers} canSeeMoney={metrics.canSeeMoney} /> : null}
          {metrics.kind === "marketing" && metrics.messaging ? <MessagingPanel view={metrics.messaging} periodDays={metrics.period.days} /> : null}
          {metrics.kind === "orders" ? <OrdersPanel view={metrics.view} period={metrics.period.query} scope={scopeQuery(metrics.scope)} funnel={metrics.funnel} confirmation={metrics.confirmation} risk={metrics.risk} /> : null}
          {metrics.kind === "shipping" ? <ShippingPanel view={metrics.view} depth={metrics.depth} period={metrics.period.query} scope={metrics.scope} /> : null}
          {metrics.kind === "customers" ? <CustomersPanel view={metrics.view} canSeeMoney={metrics.canSeeMoney} canMessage={metrics.consent?.byCustomer ?? null} network={metrics.topNetwork} /> : null}
          {metrics.kind === "customers" && metrics.network ? <BuyerNetworkPanel view={metrics.network} period={metrics.period.query} /> : null}
          {metrics.kind === "customers" && metrics.buyerHistory ? <BuyerHistoryPanel view={metrics.buyerHistory} /> : null}
          {metrics.kind === "customers" && metrics.consent ? <ConsentPanel view={metrics.consent.view} periodDays={metrics.period.days} /> : null}
          {metrics.kind === "inbox" && metrics.view ? <ConversationsPanel view={metrics.view} periodDays={metrics.period.days} whatkabotUrl={metrics.whatkabotUrl} /> : null}
          {metrics.kind === "inbox" && !metrics.view ? (
            <section className="rounded-2xl bg-white p-8 text-sm text-gray-600">WhatKaBot is connected; its conversations arrive with the next sync.</section>
          ) : null}
          {metrics.kind === "inventory" ? <InventoryPanel view={metrics.view} periodDays={metrics.period.days} period={metrics.period.query} canSeeMoney={metrics.canSeeMoney} /> : null}
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
            {lockedPreview ? `What Growzar already sees for ${storeName ?? "this store"}, and what connecting adds.` : "Here is what this section would show you."}
          </p>

          {lockedPreview?.facts.length ? (
            <dl className="mt-5 grid gap-3 sm:grid-cols-3">
              {lockedPreview.facts.map((f) => (
                <div key={f.label} className="min-w-0 rounded-xl bg-field p-4">
                  <dt className="text-xs font-semibold text-gray-500">{f.label}</dt>
                  <dd className="mt-1 font-semibold tabular-nums text-gray-900">{f.value}</dd>
                  {f.note ? <dd className="mt-0.5 text-xs text-gray-500">{f.note}</dd> : null}
                </div>
              ))}
            </dl>
          ) : null}
          {lockedPreview?.rows.length ? (
            <div className="mt-5 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
                  <tr>
                    <th className="py-2 pr-4">Best sellers, last {lockedPreview.days} days</th>
                    <th className="py-2 pr-4">Selling</th>
                    <th className="py-2">{lockedPreview.missingColumn}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lockedPreview.rows.map((r) => (
                    <tr key={r.name}>
                      <td className="py-2 pr-4 font-medium text-gray-900">{r.name}</td>
                      <td className="py-2 pr-4 tabular-nums text-gray-700">{r.known}</td>
                      <td className="py-2 text-gray-400">
                        <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> needs {state.apps.join(" or ")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {lockedPreview ? <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-gray-500">Connecting adds</p> : null}

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

          {storeId && missingApps.length ? (
            <div className="mt-6 flex flex-wrap gap-2">
              {missingApps.map((app) => (
                <a
                  key={app}
                  href={`/stores/${storeId}/apps/${app}/install?from=${section}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy-surface"
                >
                  Install {SUITE_APPS[app].name}
                </a>
              ))}
            </div>
          ) : null}
          <p className="mt-4 text-xs text-gray-500">
            {lockedPreview ? `Figures are from the last ${lockedPreview.days} days. ` : ""}Install {state.apps.join(" or ")} on your Shopify store, then press
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
        <p className="rounded-2xl bg-white p-8 text-center text-sm text-gray-600">Nothing to show yet.</p>
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
