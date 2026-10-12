import type { Route } from "./+types/insights._index";
import { prisma } from "~/lib/db.server";
import { hasPermission, listVisibleStores, requireSection } from "~/lib/authorize.server";
import { inboxView } from "~/lib/insights/inbox.server";
import { readStoreCookie } from "~/lib/store-cookie.server";
import { storeSummary } from "~/lib/metrics/summaries.server";
import { PERIODS, periodFrom } from "~/lib/metrics/screens.server";
import { previousPeriod } from "~/lib/metrics/compare";
import { NO_SCOPE } from "~/lib/metrics/scope";
import { FilterBar } from "~/components/metrics/FilterBar";
import { InsightsBoard, parseInsightsTab } from "~/components/metrics/FindingCards";

export function meta() {
  return [{ title: "Insights · Growzar" }];
}

/**
 * Every finding for the active store and period, in four tabs: needs
 * action, good to know, dismissed and snoozed, also checked. Home shows the
 * first three that need action and links here.
 *
 * Same permission as Home (its insights were Home's), the same detectors and
 * the same money rule: a role without Finance sees no money.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "home", "view");
  const stores = await listVisibleStores(viewer);
  const remembered = readStoreCookie(request);
  const active = stores.find((s) => s.id === remembered) ?? stores[0] ?? null;
  const tab = parseInsightsTab(url.searchParams.get("tab"));
  if (!active) return { store: null, periods: PERIODS, tab, stores: [], period: null, inbox: null, firstDay: null, previous: null, historyFrom: null };

  const period = periodFrom(url, active.timezone);
  const before = previousPeriod(period.from, period.to);
  const [summary, first, canSeeMoney, canManage] = await Promise.all([
    storeSummary(active.id, period.from, period.to, NO_SCOPE),
    prisma.orderGrain.aggregate({ where: { storeId: active.id }, _min: { localDay: true } }),
    hasPermission(request, viewer.organizationId, "finance", "view"),
    hasPermission(request, viewer.organizationId, "home", "manage"),
  ]);
  const historyFrom = first._min.localDay;
  return {
    store: active.displayName ?? active.shopDomain,
    periods: PERIODS,
    tab,
    stores: stores.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain })),
    period,
    inbox: await inboxView(summary, period.days, { userId: viewer.userId, canSeeMoney, canManage }),
    firstDay: historyFrom,
    previous: before,
    historyFrom: historyFrom !== null && historyFrom <= before.from ? null : historyFrom,
  };
}

export default function Insights({ loaderData }: Route.ComponentProps) {
  const { store, periods, tab, stores, period, inbox, firstDay, previous, historyFrom } = loaderData;
  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-gray-900">Insights</h1>
          <p className="mt-1 text-gray-600">
            {store ? `What Growzar found for ${store}, from your connected apps.` : "Connect a store to see what Growzar finds."}
          </p>
        </div>
        {period && previous ? (
          <FilterBar
            section="home"
            stores={{ activeId: null, list: stores, returnTo: "/insights" }}
            period={period}
            firstDay={firstDay}
            periods={periods}
            previous={previous}
            historyFrom={historyFrom}
            scope={NO_SCOPE}
            options={null}
            keep={tab === "action" ? "" : `tab=${tab}`}
            compact
          />
        ) : null}
      </header>
      {inbox && period ? <InsightsBoard inbox={inbox} period={period.query} tab={tab} /> : null}
    </div>
  );
}
