import { Link } from "react-router";

import { RISK_LEVELS, figuresText, riskLabel, type BuyerNetworkView } from "~/lib/metrics/buyer-network";
import { outcomeLabel } from "./Metrics";

/** Courierify's buyer network for this store's buyers (G-GZR5-16). Computed in `metrics/buyer-network.ts`. */

const n = (x: number) => x.toLocaleString("en-GB");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function BuyerNetworkPanel({ view, period }: { view: BuyerNetworkView; period: string }) {
  const notYet = view.openOrders - view.openAnswered - view.openNotShippedHere;
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Buyers across Courierify's network</h2>
      <p className="mt-1 text-sm text-gray-600">
        Courierify has figures for {n(view.answered)} of this period's {n(view.buyers)} buyers. For {n(view.withNetwork)} of them it also has orders
        from 2 or more other stores. It never says which stores.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2 text-sm">
        {RISK_LEVELS.map((l) => (
          <li key={l} className="rounded-full bg-gray-100 px-3 py-1 text-gray-700">
            {riskLabel(l)}: <span className="font-semibold tabular-nums text-gray-900">{n(view.levels[l])}</span>
          </li>
        ))}
      </ul>

      <h3 className="mt-5 text-sm font-semibold text-gray-900">
        {view.openHighTotal
          ? `${n(view.openHighTotal)} open order${view.openHighTotal === 1 ? "" : "s"} from buyers Courierify rated high when they ordered`
          : "No open order is from a buyer Courierify rates high"}
      </h3>
      {view.openHigh.length ? (
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
              <tr>
                <th className="py-2 pr-4">Order</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">With you</th>
                <th className="py-2 pr-4">At other stores</th>
                <th className="py-2">Courierify's reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {view.openHigh.map((o) => (
                <tr key={o.orderId}>
                  <td className="py-2 pr-4 font-medium text-gray-900">
                    {o.orderName ?? o.orderId}
                    {o.phoneTail ? <span className="ml-1 font-normal text-gray-500">···{o.phoneTail}</span> : null}
                  </td>
                  <td className="py-2 pr-4 text-gray-700">{outcomeLabel(o.outcome)}</td>
                  <td className="py-2 pr-4 text-gray-700">{o.line?.store ? figuresText(o.line.store) : "—"}</td>
                  <td className="py-2 pr-4 text-gray-700">
                    {!o.line ? "—" : o.line.network ? `${figuresText(o.line.network)} (${n(o.line.network.otherStores)} stores)` : "Fewer than 2 other stores"}
                  </td>
                  <td className="py-2 text-xs text-gray-600">{o.line?.riskBasis ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {view.openHighTotal ? (
        <p className="mt-2 text-sm">
          <Link to={`/orders?${period}&network=high`} className="text-primary-600 hover:underline">
            See {view.openHighTotal > view.openHigh.length ? `all ${n(view.openHighTotal)}` : "them"} in Orders
          </Link>
          <span className="text-gray-600"> · Call these buyers to confirm before the parcels go out.</span>
        </p>
      ) : null}

      <ul className="mt-4 list-disc space-y-0.5 pl-5 text-xs text-gray-500">
        <li>
          Risk is Courierify's own label, from the returns across every store it serves, yours included. Growzar shows it and does not rescore it. An
          open order is listed by the label its buyer had when ordering; the figures beside it are today's.
        </li>
        <li>
          Open orders: placed in the last 30 days and not yet delivered, returned or cancelled.
          {view.openNotShippedHere > 0
            ? ` ${n(view.openNotShippedHere)} of the ${n(view.openOrders)} are from buyers Courierify has not yet seen on any of this store's orders or parcels; they are asked again daily.`
            : ""}
          {notYet > 0 ? ` ${n(notYet)} are from buyers not asked about yet; they are asked within the day.` : ""}
        </li>
        <li>
          These are today's totals. They are not used to judge orders already decided, because they include parcels from after those orders.
          {view.oldestFetchedAt ? ` Oldest figures shown: ${day(view.oldestFetchedAt)}.` : ""}
        </li>
      </ul>
    </div>
  );
}
