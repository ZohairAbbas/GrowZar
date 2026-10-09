import { MoneyList } from "./Metrics";

/** Preventify's offers in Marketing (G-GZR5-10). Computed in `metrics/offers.ts`. */

type Money = { amount: string; currency: string };
type Group = {
  key: string;
  type: string;
  label: string;
  offerId: string | null;
  orders: number;
  delivered: number;
  returned: number;
  returnRate: number | null;
  avgPlaced: Money | null;
};
export type OffersPanelView = {
  currency: string | null;
  formOrders: number;
  byType: Group[];
  byOffer: Group[];
  events: Array<{ offerId: string; shown: number; accepted: number }>;
};

const n = (x: number) => x.toLocaleString("en-GB");
const TYPE: Record<string, string> = { bundle: "Bundle", one_tick: "One-tick", upsell: "Upsell", downsell: "Downsell", none: "—" };

function Rows({ groups, events, canSeeMoney }: { groups: Group[]; events?: Map<string, { shown: number; accepted: number }>; canSeeMoney: boolean }) {
  return (
    <tbody className="divide-y divide-gray-100">
      {groups.map((g) => {
        const e = g.offerId ? events?.get(g.offerId) : undefined;
        return (
          <tr key={g.key}>
            <td className="max-w-xs truncate py-2 pr-4 font-medium text-gray-900" title={g.label}>{g.label}</td>
            <td className="py-2 pr-4 text-gray-600">{TYPE[g.type] ?? g.type}</td>
            <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{n(g.orders)}</td>
            <td className="py-2 pr-4 text-right tabular-nums text-gray-900">
              {canSeeMoney && g.avgPlaced ? <MoneyList values={[g.avgPlaced]} /> : <span className="text-gray-400">—</span>}
            </td>
            <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{n(g.delivered + g.returned)}</td>
            <td className="py-2 pr-4 text-right tabular-nums text-gray-900">
              {g.returnRate === null ? <span className="text-gray-400">too few</span> : `${g.returnRate.toFixed(1)}%`}
            </td>
            <td className="py-2 text-right tabular-nums text-gray-600">{e ? `${n(e.shown)} / ${n(e.accepted)}` : ""}</td>
          </tr>
        );
      })}
    </tbody>
  );
}

export function OffersPanel({ view, canSeeMoney }: { view: OffersPanelView; canSeeMoney: boolean }) {
  const events = new Map(view.events.map((e) => [e.offerId, e]));
  const head = (
    <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
      <tr>
        <th className="py-2 pr-4">Offer</th>
        <th className="py-2 pr-4">Kind</th>
        <th className="py-2 pr-4 text-right">Orders</th>
        <th className="py-2 pr-4 text-right">Average order</th>
        <th className="py-2 pr-4 text-right">Delivered or returned</th>
        <th className="py-2 pr-4 text-right">Returned</th>
        <th className="py-2 text-right">Shown / clicked</th>
      </tr>
    </thead>
  );
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Offers on your COD form</h2>
      <p className="mt-1 text-sm text-gray-600">
        {n(view.formOrders)} COD-form orders in this period (Preventify), compared with each other by what they went on to do.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          {head}
          <Rows groups={view.byType} canSeeMoney={canSeeMoney} />
        </table>
      </div>
      {view.byOffer.length ? (
        <div className="mt-5 overflow-x-auto">
          <h3 className="text-sm font-semibold text-gray-700">By offer</h3>
          <table className="mt-2 min-w-full text-sm">
            {head}
            <Rows groups={view.byOffer.slice(0, 15)} events={events} canSeeMoney={canSeeMoney} />
          </table>
        </div>
      ) : null}
      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-gray-500">
        <li>An order with several offers counts under each. Average order is Financify's order total, not Preventify's.</li>
        <li>“By offer” lists only offers Preventify recorded by name: upsells and most bundles on older orders were stored without which offer, so they count only in the totals above.</li>
        <li>Returned is a share of orders already delivered or returned; under 10 is too few to show.</li>
        <li>Shown / clicked counts start on 9 October 2026 and anyone can trigger them, so treat them as a rough guide.</li>
      </ul>
    </div>
  );
}
