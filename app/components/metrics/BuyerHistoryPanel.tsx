/** Buyers by their own history with the store (G-GZR5-11, I5). Computed in `metrics/buyer-history.ts`. */

type Band = "returned_before" | "delivered_before" | "first";
export type BuyerHistoryPanelView = {
  bands: Array<{ band: Band; orders: number; delivered: number; returned: number; rate: number | null }>;
  returnsFromReturners: number | null;
  otpEnabled: boolean | null;
  formShare: number | null;
};

const LABEL: Record<Band, string> = {
  returned_before: "Returned a parcel before",
  delivered_before: "Accepted every parcel before",
  first: "First order, or nothing decided yet",
};
const n = (x: number) => x.toLocaleString("en-GB");

export function BuyerHistoryPanel({ view }: { view: BuyerHistoryPanelView }) {
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Buyers by their history with you</h2>
      <p className="mt-1 text-sm text-gray-600">
        Each order in this period, by what the same buyer's earlier orders with this store had come to when it was placed.
        {view.returnsFromReturners !== null ? ` Buyers who had returned before made ${view.returnsFromReturners.toFixed(1)}% of this period's returns.` : ""}
      </p>
      <table className="mt-4 min-w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
          <tr>
            <th className="py-2 pr-4">Buyer</th>
            <th className="py-2 pr-4 text-right">Orders</th>
            <th className="py-2 pr-4 text-right">Delivered</th>
            <th className="py-2 pr-4 text-right">Returned</th>
            <th className="py-2 text-right">Came back</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {view.bands.map((b) => (
            <tr key={b.band}>
              <td className="py-2 pr-4 font-medium text-gray-900">{LABEL[b.band]}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{n(b.orders)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{n(b.delivered)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{n(b.returned)}</td>
              <td className="py-2 text-right tabular-nums text-gray-900">{b.rate === null ? "—" : `${b.rate.toFixed(1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-gray-500">
        <li>Only this store's own orders count; outcomes known only after an order was placed do not band it.</li>
        <li>
          {view.otpEnabled === null
            ? "Preventify is not connected, so Growzar cannot see any verification on this store."
            : `Preventify's OTP verification is ${view.otpEnabled ? "on" : "off"} for this store${view.formShare !== null ? `; its form took ${view.formShare.toFixed(1)}% of this period's orders` : ""}.`}
        </li>
      </ul>
    </div>
  );
}
