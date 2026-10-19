import { data, Form, Link, useNavigation } from "react-router";
import { Activity, ArrowRight } from "lucide-react";

import type { Route } from "./+types/insights.$insightId";
import { prisma } from "~/lib/db.server";
import { hasPermission, requireStore } from "~/lib/authorize.server";
import { clickSource, parseInsightAction } from "~/lib/insights/actions";
import { applyInsightAction } from "~/lib/insights/inbox.server";
import { detectorLabel, withoutMoney, type DetectorId, type Insight } from "~/lib/insights/detectors";
import { summaryOf } from "~/lib/insights/summary";
import { dayLabel } from "~/lib/outcomes/line";
import { localDayOf } from "~/lib/metrics/order-grain";
import { outcomeLinesOf, viewerIsInternal } from "~/lib/outcomes/results.server";
import { PLACEBO, type FindingSnapshot } from "~/lib/outcomes/watch";

export function meta() {
  return [{ title: "Insight history · Growzar" }];
}

/**
 * One insight's history (G-GZR9-5): the finding as the last evaluation saw
 * it, and what happened after each time someone acted on it, with how that
 * is measured. Count-only (pack §13): numbers and what the store changed,
 * no verdicts.
 */
export async function loader({ request, params, url }: Route.LoaderArgs) {
  const insight = await prisma.insight.findUnique({
    where: { id: params.insightId },
    select: { id: true, storeId: true, detector: true, subject: true, status: true, firstSeenAt: true, resolvedAt: true, lastFinding: true, store: { select: { timezone: true, displayName: true, shopDomain: true } } },
  });
  if (!insight) throw data("No such insight.", { status: 404 });
  const { viewer } = await requireStore(request, insight.storeId, "home", "view");
  const [canSeeMoney, canManage, internal] = await Promise.all([
    hasPermission(request, viewer.organizationId, "finance", "view"),
    hasPermission(request, viewer.organizationId, "home", "manage"),
    viewerIsInternal(viewer.userId),
  ]);
  const tz = insight.store.timezone ?? "UTC";
  const lines = await outcomeLinesOf([insight.storeId], { userId: viewer.userId, canSeeMoney, internal }, { insightIds: [insight.id] });
  const rows = await prisma.insightOutcome.findMany({
    where: { insightId: insight.id, trigger: { not: PLACEBO }, ...(internal ? {} : { internal: false }) },
    select: { id: true, trigger: true, effect: true, baseline: true, hiddenNote: true },
  });
  const snap = insight.lastFinding as FindingSnapshot | null;
  let finding: Insight | null = snap?.insight ?? null;
  if (finding && !canSeeMoney) finding = withoutMoney([finding])[0] ?? null;
  const s = finding ? summaryOf(finding.finding, "days=90") : null;
  const from = clickSource(url.searchParams.get("from"));
  return {
    id: insight.id,
    store: insight.store.displayName ?? insight.store.shopDomain,
    label: detectorLabel(insight.detector as DetectorId),
    headline: s?.headline ?? null,
    figure: s?.figure ?? null,
    link: s?.link ? { to: `/insights/${insight.id}/open?to=${encodeURIComponent(s.link.to)}${from ? `&from=${from}` : ""}`, label: s.link.label } : null,
    status: insight.resolvedAt ? `Not found since ${dayLabel(localDayOf(insight.resolvedAt, tz))}` : insight.status === "dismissed" ? "Dismissed" : "Still found",
    firstSeen: dayLabel(localDayOf(insight.firstSeenAt, tz)),
    canManage,
    watches: lines.map((l) => {
      const r = rows.find((x) => x.id === l.watchId);
      return { ...l, how: howMeasured(l.detector, r?.effect, r?.baseline), trigger: r?.trigger ?? "clicked", note: r?.hiddenNote ?? null };
    }),
  };
}

type Obj = Record<string, any>;
const o = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const span = (w: Obj | undefined) => (w?.from && w?.to ? `${dayLabel(w.from)}–${dayLabel(w.to)}` : null);

/** "How this is measured", in plain words, from what the engine recorded. */
function howMeasured(detector: string, effect: unknown, baseline: unknown): string[] {
  const e = o(effect);
  const items = o(baseline).items;
  if (["cash_held", "returns_not_received", "stuck_parcels"].includes(detector)) {
    return [
      `Growzar follows the ${Array.isArray(items) ? items.length.toLocaleString("en-GB") : ""} orders this finding was about when it was opened, by the dates the apps record (a payout's settlement, a return's receipt, a parcel's outcome), and checks them 7, 14 and 28 days later.`,
    ];
  }
  if (detector === "stockout") return ["Growzar counts the days the variant had no stock in Inventorify's daily snapshots over the 28 days after, against the shortfall the card expected."];
  if (detector === "courier_deductions") return ["Growzar reads the courier's statements dated after it was opened and compares how much of the COD they leave unexplained with what the card showed."];
  const w = o(e.windows);
  const out = [
    `Before: orders placed ${span(w.before) ?? "in the 90 days before"}. After: orders placed ${span(w.after) ?? "in the 28 days after"}.`,
    e.comparison ? `Compared with ${String(e.comparison).replace(/^.*?, against /, "")}, over the same days, so a change across the whole store does not count as this one's.` : "",
    "Orders still on their way are counted both ways (all delivered, all returned); the numbers are final once 95% of the orders after are decided, or 60 days after it was opened. Parcels with no news for 45 days, and orders unshipped after 14, are left out.",
    "Growzar does not yet say whether this went well or badly: that waits until enough findings nobody acted on show how much numbers move on their own.",
  ];
  return out.filter(Boolean);
}

/**
 * Dismiss (with a reason), snooze, or reopen an insight (G-GZR3-3), posted by
 * a fetcher from Home; and "this wasn't us" on one of its outcomes
 * (G-GZR9-5, pack §10.8): recorded, kept out of results.
 *
 * Acting on an insight is `home:manage`; the staff role can see Home but not
 * change what the organization's inbox shows. The store check is the same
 * one every store-scoped page uses, so an insight id from another
 * organization or outside the viewer's scope answers 403, like a store would.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const insight = await prisma.insight.findUnique({ where: { id: params.insightId }, select: { id: true, storeId: true } });
  if (!insight) throw data("No such insight.", { status: 404 });
  const { viewer } = await requireStore(request, insight.storeId, "home", "manage");

  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "hide_outcome" || intent === "unhide_outcome") {
    const outcomeId = String(form.get("outcomeId") ?? "");
    const note = form.get("note");
    const hide = intent === "hide_outcome";
    const r = await prisma.insightOutcome.updateMany({
      where: { id: outcomeId, insightId: insight.id, trigger: { not: PLACEBO } },
      data: hide
        ? { hiddenAt: new Date(), hiddenByUserId: viewer.userId, hiddenNote: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null }
        : { hiddenAt: null, hiddenByUserId: null, hiddenNote: null },
    });
    if (!r.count) throw data("No such outcome.", { status: 404 });
    return { ok: true };
  }
  const act = parseInsightAction(form);
  if (!act) throw data("Unknown action.", { status: 400 });
  await applyInsightAction(insight.id, insight.storeId, viewer.userId, act);
  return { ok: true };
}

export default function InsightHistory({ loaderData }: Route.ComponentProps) {
  const d = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/insights" className="text-sm font-semibold text-accent-600 hover:underline">
        ← Insights
      </Link>
      <header className="mt-3 rounded-2xl bg-white p-6">
        <p className="text-sm font-semibold text-gray-500">
          {d.label} · {d.store}
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold leading-tight text-gray-900">{d.headline ?? d.label}</h1>
        {d.figure ? <p className="mt-2 font-display text-3xl font-bold tabular-nums text-gray-900">{d.figure}</p> : null}
        <p className="mt-2 text-sm text-gray-600">
          First found {d.firstSeen} · {d.status}
        </p>
        {d.link ? (
          <Link to={d.link.to} className="mt-4 inline-flex items-center gap-2 rounded-full bg-navy px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-surface">
            {d.link.label} <ArrowRight className="h-4 w-4 text-mint" />
          </Link>
        ) : null}
      </header>

      <section className="mt-6" aria-labelledby="since-heading">
        <h2 id="since-heading" className="font-display text-xl font-bold text-gray-900">
          What happened since
        </h2>
        {d.watches.length ? (
          <ul className="mt-3 space-y-3">
            {d.watches.map((w) => (
              <li key={w.watchId} className="rounded-2xl bg-white p-5">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-500">
                  <Activity className="h-4 w-4 text-accent-600" aria-hidden="true" />
                  {w.trigger === "app_link" ? "Opened in the app" : "Opened"} {w.since}
                  {w.internal ? <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-bold text-gray-600">Internal</span> : null}
                  <span className="rounded-full bg-field px-2 py-0.5 text-xs text-gray-600">
                    {w.status === "watching" ? "Still measuring" : w.status === "measured" ? "Measured" : w.status === "hidden" ? "This wasn't us" : "Not measured"}
                  </span>
                </div>
                <p className="mt-2 text-gray-800">
                  {w.text}
                  {w.money ? <span className="font-semibold text-gray-900"> · {w.money}</span> : null}
                </p>
                {w.note ? <p className="mt-1 text-sm text-gray-500">Note: {w.note}</p> : null}
                {w.status !== "closed" ? (
                  <details className="mt-3 text-sm text-gray-600">
                    <summary className="cursor-pointer font-semibold text-gray-700">How this is measured</summary>
                    <div className="mt-2 space-y-1.5">
                      {w.how.map((h, i) => (
                        <p key={i}>{h}</p>
                      ))}
                    </div>
                  </details>
                ) : null}
                {d.canManage && w.status !== "closed" ? (
                  <Form method="post" className="mt-3 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="outcomeId" value={w.watchId} />
                    {w.status === "hidden" ? (
                      <button type="submit" name="intent" value="unhide_outcome" disabled={busy} className="rounded-full bg-field px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100">
                        Count it again
                      </button>
                    ) : (
                      <>
                        <input name="note" maxLength={500} placeholder="Why (optional)" className="min-w-0 flex-1 rounded-full border border-gray-200 px-3 py-1.5 text-sm" />
                        <button type="submit" name="intent" value="hide_outcome" disabled={busy} className="rounded-full bg-field px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100">
                          This wasn't us
                        </button>
                      </>
                    )}
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-2xl bg-white px-5 py-4 text-sm text-gray-600">
            Nobody has acted on this yet. When someone follows its link or opens the app it points to, Growzar starts measuring what happens next.
          </p>
        )}
      </section>
    </div>
  );
}
