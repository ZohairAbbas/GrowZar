import { CheckCircle2, CircleDashed, CircleSlash } from "lucide-react";

import type { Route } from "./+types/settings.coverage";
import { prisma } from "~/lib/db.server";
import { listVisibleStores, requireSection } from "~/lib/authorize.server";
import { readStoreCookie } from "~/lib/store-cookie.server";
import { storeSummary } from "~/lib/metrics/summaries.server";
import { storeCoverage } from "~/lib/metrics/coverage.server";
import { PERIODS, periodFrom } from "~/lib/metrics/screens.server";
import { PeriodPicker } from "~/components/metrics/Metrics";
import { APP_LABELS } from "~/lib/sections";
import { SECTION_LABELS } from "~/lib/permissions";

export function meta() {
  return [{ title: "Data coverage · Growzar" }];
}

/**
 * The coverage panel (Phase 4b, D1): per store, what each connected app
 * contributes, how complete it is over the period, and what is missing.
 * Every section's one-line coverage summary links here; nothing else on a
 * screen hedges.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "home", "view");
  const stores = await listVisibleStores(viewer);
  const remembered = readStoreCookie(request);
  const active = stores.find((s) => s.id === remembered) ?? stores[0] ?? null;
  if (!active) return { store: null, period: null, periods: PERIODS, report: null };

  const store = await prisma.store.findUniqueOrThrow({ where: { id: active.id }, select: { timezone: true } });
  const period = periodFrom(url, store.timezone);
  const report = await storeCoverage(await storeSummary(active.id, period.from, period.to));
  return {
    store: { name: active.displayName ?? active.shopDomain },
    period,
    periods: PERIODS,
    report: {
      ...report,
      apps: report.apps.map((a) => ({ ...a, label: APP_LABELS[a.app] })),
      items: report.items.map((i) => ({
        ...i,
        appLabel: APP_LABELS[i.app],
        sectionLabels: i.sections.map((s) => SECTION_LABELS[s]),
      })),
    },
  };
}

const STATUS = {
  complete: { icon: CheckCircle2, tone: "text-mint-700", label: "Complete" },
  partial: { icon: CircleDashed, tone: "text-amber-600", label: "Partial" },
  missing: { icon: CircleSlash, tone: "text-coral-700", label: "Not available" },
} as const;

const pct = (have: number, of: number) => `${Math.floor((100 * have) / of)}%`;

export default function Coverage({ loaderData }: Route.ComponentProps) {
  const { store, period, periods, report } = loaderData;
  if (!store || !period || !report) {
    return (
      <section className="rounded-2xl bg-white p-6">
        <h1 className="font-display text-lg font-bold text-gray-900">Data coverage</h1>
        <p className="mt-1 text-sm text-gray-600">No store yet.</p>
      </section>
    );
  }
  const shown = report.apps.filter((a) => a.state !== "not_connected");
  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-lg font-bold text-gray-900">Data coverage</h1>
            <p className="text-sm text-gray-600">
              {store.name} · {period.from} to {period.to} · {report.orders.toLocaleString()} orders. What each app
              sends, how complete it is, and what that does to the numbers.
            </p>
          </div>
          <PeriodPicker days={period.days} options={periods} />
        </div>
      </section>

      {shown.map((app) => {
        const items = report.items.filter((i) => i.app === app.app);
        return (
          <section key={app.app} className="rounded-2xl bg-white p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-base font-bold text-gray-900">{app.label}</h2>
              <span className="text-xs font-semibold text-gray-500">
                {app.state === "connected" ? "Connected" : "Connected · read from the next release"}
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-600">{app.gives}.</p>
            {items.length ? (
              <ul className="mt-4 divide-y divide-gray-100">
                {items.map((i) => {
                  const st = STATUS[i.status];
                  const Icon = st.icon;
                  return (
                    <li key={i.key} className="grid gap-1 py-3 sm:grid-cols-[14rem_1fr]">
                      <div className="flex items-start gap-2">
                        <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${st.tone}`} />
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{i.label}</p>
                          <p className="text-xs text-gray-500">
                            {i.have !== null && i.of !== null
                              ? `${i.have.toLocaleString()} of ${i.of.toLocaleString()} ${i.unit} · ${pct(i.have, i.of)}`
                              : st.label}
                          </p>
                        </div>
                      </div>
                      <div className="text-sm text-gray-700">
                        {i.gap ? <p>{i.gap.charAt(0).toUpperCase() + i.gap.slice(1)}.</p> : <p className="text-gray-500">Nothing missing.</p>}
                        {i.status !== "complete" ? (
                          <p className="mt-0.5 text-xs text-gray-500">
                            Effect: {i.effect}. Changes {i.sectionLabels.join(", ")}.
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        );
      })}

      {report.items.some((i) => !shown.some((a) => a.app === i.app)) ? (
        <section className="rounded-2xl bg-white p-6">
          <h2 className="font-display text-base font-bold text-gray-900">Not connected</h2>
          <ul className="mt-3 space-y-2">
            {report.items
              .filter((i) => !shown.some((a) => a.app === i.app))
              .map((i) => (
                <li key={i.key} className="text-sm text-gray-700">
                  <span className="font-semibold text-gray-900">{i.label}</span> ({i.appLabel}): {i.gap}. Effect:{" "}
                  {i.effect}.
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
