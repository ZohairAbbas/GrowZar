import { redirect, useNavigation } from "react-router";
import { Compass } from "lucide-react";

import type { Route } from "./+types/plan";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { Forbidden, hasPermission, listVisibleStores, requireSection } from "~/lib/authorize.server";
import { readStoreCookie, rememberLinkedStore } from "~/lib/store-cookie.server";
import { planVisible } from "~/lib/forecast/plan-access.server";
import { FORECAST_STATUS, parseSimRequest, withoutMoney } from "~/lib/forecast/plan-form";
import { formOptions, forecasts, parseWhatIf, runAndSave, savedPlan, savedPlans, whatIfOn } from "~/lib/forecast/plan.server";
import type { SimRequest } from "~/lib/forecast/simulator/types";
import { sectionState, SECTION_DEFINITIONS } from "~/lib/sections";
import { Notice } from "~/components/metrics/Metrics";
import { CashForecastCard, MonthEndCard, PlanForm, PlanResult, SavedPlans, WhatIfs } from "~/components/plan/PlanPanels";

export function meta() {
  return [{ title: "Plan · Growzar" }];
}

/**
 * Plan (G-GZR11-6, pack §5.6): the budget simulator, the cash forecast and the
 * month-end projection for the active store.
 *
 * Who: plan:view (owner, admin, manager by default; staff and custom roles
 * not), behind PLAN_ENABLED and, until the G-GZR11-8 approval, internal
 * accounts only (P11-13, P11-14). Money also needs finance:view; without it
 * the loader sends orders and dates only, so nothing reaches the page.
 */
async function context(request: Request, url?: URL) {
  const viewer = await requireSection(request, "plan", "view");
  if (!(await planVisible(viewer.userId))) throw new Response("Not found", { status: 404 });
  const stores = await listVisibleStores(viewer);
  // A link from Ask names its store (?store=): remember it, as the sections do.
  const linked = url ? rememberLinkedStore(url, stores) : null;
  if (linked) throw linked;
  const remembered = readStoreCookie(request);
  const active = stores.find((s) => s.id === remembered) ?? stores[0] ?? null;
  const canSeeMoney = await hasPermission(request, viewer.organizationId, "finance", "view");
  return { viewer, active, canSeeMoney };
}

export async function loader({ request, url }: Route.LoaderArgs) {
  const { active, canSeeMoney } = await context(request, url);
  if (!active) return { kind: "empty" as const };
  const connections = await prisma.appConnection.findMany({ where: { storeId: active.id }, select: { app: true, status: true, lastSyncedAt: true } });
  const state = sectionState(SECTION_DEFINITIONS.plan, connections);
  if (state.kind !== "open") return { kind: "locked" as const, storeName: active.displayName ?? active.shopDomain };

  const id = url.searchParams.get("id");
  const [{ cash, month }, options, list, plan] = await Promise.all([forecasts(active.id), formOptions(active.id), savedPlans(active.id), id ? savedPlan(active.id, id) : null]);
  const ask = plan ? parseWhatIf(url.searchParams) : null;
  const whatIf = plan && ask ? await whatIfOn(active.id, plan, ask) : null;
  return {
    kind: "open" as const,
    storeName: active.displayName ?? active.shopDomain,
    canSeeMoney,
    status: FORECAST_STATUS,
    // Plan is internal-only for now: everyone who reaches it sees where each forecast stands.
    internal: true,
    cash: canSeeMoney ? cash : null,
    month: canSeeMoney ? month : { current: { ...month.current, deliveredRevenue: null, profit: null, adSpend: null }, previous: { ...month.previous, deliveredRevenue: null, profit: null, adSpend: null } },
    options,
    plans: list.map((p) => ({ id: p.id, createdAt: p.createdAt.toISOString(), status: p.status, budget: canSeeMoney ? ((p.inputs as SimRequest | null)?.budget ?? null) : null })),
    plan: plan ? (canSeeMoney ? plan : { ...withoutMoney(plan), id: plan.id, createdAt: plan.createdAt, version: plan.version }) : null,
    whatIf: whatIf && !canSeeMoney && whatIf.status === "ok" ? { ...whatIf, profit: { low: 0, likely: 0, high: 0 } } : whatIf,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { viewer, active, canSeeMoney } = await context(request);
  // A budget is money: making a plan needs Finance access.
  if (!canSeeMoney) throw new Forbidden("Making a plan needs Finance access.");
  if (!active) return { error: "Pick a store first." };
  const form = await readFormData(request);
  if (String(form.get("intent")) !== "run") return { error: "Nothing to do." };
  const parsed = parseSimRequest(form);
  if ("error" in parsed) return { error: parsed.error };
  const id = await runAndSave(active.id, viewer.organizationId, viewer.userId, parsed.request);
  throw redirect(`/plan?id=${id}`);
}

export default function PlanPage({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state === "submitting";
  if (loaderData.kind === "empty") return <Notice>Connect a store to plan for it.</Notice>;
  if (loaderData.kind === "locked") return <Notice>Plan needs Courierify or Financify on {loaderData.storeName}.</Notice>;
  const d = loaderData;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 font-display text-2xl font-bold text-gray-900">
          <Compass className="h-6 w-6 text-accent-600" /> Plan
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          For {d.storeName}, from its own history only. Every figure is a range; the low end is the one to count on.
        </p>
      </header>

      <section className="space-y-4 rounded-2xl bg-white p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-lg font-bold text-gray-900">Where should the money go?</h2>
          <SavedPlans plans={d.plans} current={d.plan?.id ?? null} />
        </div>
        <p className={`rounded-xl px-3 py-2 text-xs ${d.status.simulator.passes ? "bg-mint-50 text-mint-700" : "bg-coral-50 text-coral-700"}`}>{d.status.simulator.note}</p>
        {d.canSeeMoney ? <PlanForm options={d.options} error={actionData && "error" in actionData ? (actionData.error ?? null) : null} busy={busy} /> : <Notice>Making a plan needs Finance access; you can see saved plans' orders and dates.</Notice>}
        {d.plan ? (
          <div className="space-y-4 border-t border-gray-100 pt-4">
            <p className="text-xs text-gray-500">Plan made {new Date(d.plan.createdAt).toLocaleString("en-GB")} from the data as it stood then (simulator {d.plan.version}).</p>
            <PlanResult plan={d.plan} canSeeMoney={d.canSeeMoney} />
            {d.plan.status === "plan" ? <WhatIfs planId={d.plan.id} options={d.options} result={d.whatIf} canSeeMoney={d.canSeeMoney} currency={d.options.currency} /> : null}
          </div>
        ) : null}
      </section>

      {d.cash ? <CashForecastCard cash={d.cash} status={d.status.cash} internal={d.internal} /> : <Notice>The cash forecast needs Finance access.</Notice>}
      <MonthEndCard month={d.month} canSeeMoney={d.canSeeMoney} status={d.status.monthEnd} internal={d.internal} />
    </div>
  );
}
