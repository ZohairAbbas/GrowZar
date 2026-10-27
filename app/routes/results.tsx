import { Link } from "react-router";
import { Activity, ArrowRight } from "lucide-react";

import type { Route } from "./+types/results";
import { hasPermission, listVisibleStores, requireSection } from "~/lib/authorize.server";
import { detectorLabel, type DetectorId } from "~/lib/insights/detectors";
import { resultCounts, type OutcomeLine } from "~/lib/outcomes/line";
import { outcomeLinesOf, viewerIsInternal } from "~/lib/outcomes/results.server";

export function meta() {
  return [{ title: "Results · Growzar" }];
}

/**
 * Results (G-GZR9-5): what happened after someone acted on a finding, per
 * store and for the organization. Count-only (pack §13): how many were
 * watched, measured and still measuring, and each outcome's numbers; no
 * improved/worse tally until a detector passes the placebo check. Money only
 * where measured and approved (I4), only for a viewer who may see Finance.
 * Internal accounts' watches never count (§10.1); "this wasn't us" ones are
 * listed apart (§10.8). Same permission as Home, where these findings start.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "home", "view");
  const [stores, canSeeMoney, internal] = await Promise.all([
    listVisibleStores(viewer),
    hasPermission(request, viewer.organizationId, "finance", "view"),
    viewerIsInternal(viewer.userId),
  ]);
  const lines = await outcomeLinesOf(
    stores.map((s) => s.id),
    { userId: viewer.userId, canSeeMoney, internal },
  );
  const name = new Map(stores.map((s) => [s.id, s.displayName ?? s.shopDomain]));
  const row = (l: (typeof lines)[number]) => ({ ...l, label: detectorLabel(l.detector as DetectorId), store: name.get(l.storeId) ?? "" });
  const perStore = stores.map((s) => {
    const mine = lines.filter((l) => l.storeId === s.id);
    return { id: s.id, name: name.get(s.id)!, counts: resultCounts(mine), money: moneyTotals(mine) };
  });
  return {
    counts: resultCounts(lines),
    money: moneyTotals(lines),
    stores: perStore,
    multi: stores.length > 1,
    rows: lines.filter((l) => l.status !== "hidden").map(row),
    hidden: lines.filter((l) => l.status === "hidden").map(row),
  };
}

/** Measured, approved money in counted outcomes, per currency (rule #4). */
function moneyTotals(lines: readonly OutcomeLine[]): Array<{ currency: string; amount: number }> {
  const by = new Map<string, number>();
  for (const l of lines) {
    if (l.internal || l.status === "hidden" || l.status === "closed" || !l.moneyValue) continue;
    by.set(l.moneyValue.currency, (by.get(l.moneyValue.currency) ?? 0) + l.moneyValue.amount);
  }
  return [...by.entries()].map(([currency, amount]) => ({ currency, amount: Math.round(amount) }));
}

const n = (x: number) => x.toLocaleString("en-GB");

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-white p-5">
      <p className="text-sm font-semibold text-gray-500">{label}</p>
      <p className="mt-1 font-display text-3xl font-bold tabular-nums text-gray-900">{value}</p>
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}

export default function Results({ loaderData }: Route.ComponentProps) {
  const { counts, money, stores, multi, rows, hidden } = loaderData;
  return (
    <div>
      <header className="mb-6">
        <h1 className="font-display text-3xl font-bold tracking-tight text-gray-900">Results</h1>
        <p className="mt-1 max-w-2xl text-gray-600">
          What happened after someone acted on a finding: followed its link or opened the app it points to. Growzar shows the numbers before and after;
          it does not yet say whether that went well, until enough findings nobody acted on show how much numbers move on their own.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Totals">
        <Tile label="Acted on" value={n(counts.watched)} hint="findings someone followed up" />
        <Tile label="Measured" value={n(counts.measured)} hint="numbers final" />
        <Tile label="Still measuring" value={n(counts.watching)} />
        <Tile label="With a change seen" value={n(counts.changed)} hint="the store's data shows the change" />
      </section>
      {money.length ? (
        <p className="mt-3 rounded-2xl bg-white px-5 py-3 text-sm text-gray-700">
          COD paid since findings about it were opened:{" "}
          <strong className="tabular-nums text-gray-900">{money.map((m) => `${m.currency} ${n(m.amount)}`).join(" · ")}</strong>. Measured from courier settlements, not estimated.
        </p>
      ) : null}

      {multi ? (
        <section className="mt-6" aria-labelledby="stores-heading">
          <h2 id="stores-heading" className="font-display text-xl font-bold text-gray-900">
            By store
          </h2>
          <div className="mt-3 overflow-x-auto rounded-2xl bg-white">
            <table className="pin-first w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Store</th>
                  <th className="px-4 py-3 text-right font-semibold">Acted on</th>
                  <th className="px-4 py-3 text-right font-semibold">Measured</th>
                  <th className="px-4 py-3 text-right font-semibold">Still measuring</th>
                  <th className="px-4 py-3 text-right font-semibold">Change seen</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => (
                  <tr key={s.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 font-medium text-gray-900">{s.name}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{n(s.counts.watched)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{n(s.counts.measured)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{n(s.counts.watching)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{n(s.counts.changed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="mt-6" aria-labelledby="list-heading">
        <h2 id="list-heading" className="font-display text-xl font-bold text-gray-900">
          Every outcome
        </h2>
        {rows.length ? (
          <ul className="mt-3 space-y-3">
            {rows.map((r) => (
              <li key={r.watchId} className="rounded-2xl bg-white p-5">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-500">
                  <Activity className="h-4 w-4 text-accent-600" aria-hidden="true" />
                  {r.label}
                  {multi ? <span>· {r.store}</span> : null}
                  {r.internal ? <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-bold text-gray-600">Internal, not counted</span> : null}
                  <span className="rounded-full bg-field px-2 py-0.5 text-xs text-gray-600">
                    {r.status === "watching" ? "Still measuring" : r.status === "measured" ? "Measured" : "Not measured"}
                  </span>
                </div>
                <p className="mt-2 text-gray-800">
                  {r.text}
                  {r.money ? <span className="font-semibold text-gray-900"> · {r.money}</span> : null}
                </p>
                <Link to={`/insights/${r.insightId}?from=results`} className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-accent-600 hover:underline">
                  History and how it is measured <ArrowRight className="h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-2xl bg-white px-5 py-4 text-sm text-gray-600">
            Nothing acted on yet. When someone follows a finding's link or opens the app it points to, what happens next shows here.
          </p>
        )}
      </section>

      {hidden.length ? (
        <section className="mt-6" aria-labelledby="hidden-heading">
          <h2 id="hidden-heading" className="font-display text-lg font-bold text-gray-900">
            Marked "this wasn't us" · {n(hidden.length)}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-gray-600">
            {hidden.map((r) => (
              <li key={r.watchId}>
                <Link to={`/insights/${r.insightId}?from=results`} className="hover:underline">
                  {r.label}, opened {r.since}
                  {multi ? ` · ${r.store}` : ""}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
