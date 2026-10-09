import { MoneyList, Stat } from "./Metrics";

/**
 * The Inventory section (G-GZR5-3). Plain types only: the view is computed on
 * the server in `metrics/inventory.ts` and arrives as JSON.
 */

type Money = { amount: string; currency: string };
type StockState = "out" | "reorder" | "on_order" | "ok" | "slow" | "untracked" | "not_selling";

export type InventoryPanelView = {
  currency: string | null;
  rateWindow: { from: string; to: string };
  variants: number;
  selling: number;
  outNow: number;
  reorderNow: number;
  untracked: number;
  stockValue: Money | null;
  uncosted: number;
  rows: Array<{
    variantId: string;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    stock: number;
    soldInPeriod: number;
    perDay: number;
    daysOfCover: number | null;
    leadTimeDays: number | null;
    leadSource: "measured" | "setting" | null;
    onOrder: number;
    daysOut: number;
    daysSnapshotted: number;
    soldAtZeroDays: number;
    state: StockState;
  }>;
  hiddenRows: number;
  receivedOrders: number;
  reordersInInventorify: boolean;
  openOrders: Array<{ id: string; poNumber: string; status: string; supplierName: string | null; expected: string | null; units: number; variants: number }>;
};

const STATE: Record<StockState, { text: string; className: string }> = {
  out: { text: "Out of stock", className: "bg-red-50 text-red-700" },
  reorder: { text: "Reorder now", className: "bg-amber-50 text-amber-800" },
  on_order: { text: "Low, on order", className: "bg-blue-50 text-blue-700" },
  ok: { text: "Enough", className: "bg-green-50 text-green-700" },
  slow: { text: "No sale in 30 days", className: "bg-gray-100 text-gray-600" },
  untracked: { text: "Count not kept up", className: "bg-gray-100 text-gray-700" },
  not_selling: { text: "Not selling", className: "bg-gray-100 text-gray-600" },
};

const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function InventoryPanel({ view, periodDays }: { view: InventoryPanelView; periodDays: number }) {
  if (view.variants === 0) {
    return (
      <section className="rounded-2xl bg-white p-8 text-sm text-gray-600">
        Inventorify has not sent any products for this store yet.
      </section>
    );
  }
  const rate = `${shortDay(view.rateWindow.from)}–${shortDay(view.rateWindow.to)}`;
  return (
    <section className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Out of stock now" note={`Of ${view.selling.toLocaleString()} variants that sold in the last 90 days`}>
          {view.outNow.toLocaleString()}
        </Stat>
        <Stat label="Reorder now" note="Runs out within its lead time at the last 30 days' rate, and nothing is on order">
          {view.reorderNow.toLocaleString()}
        </Stat>
        <Stat
          label="Stock at cost"
          note={view.uncosted ? `${view.uncosted.toLocaleString()} variants in stock have no cost in Inventorify and are not counted` : "On hand × Inventorify's unit cost"}
        >
          {view.stockValue ? <MoneyList values={[view.stockValue]} /> : <span className="text-gray-400">currency not reported yet</span>}
        </Stat>
        <Stat label="Variants" note={`${view.selling.toLocaleString()} selling, ${(view.variants - view.selling).toLocaleString()} with no sale in 90 days`}>
          {view.variants.toLocaleString()}
        </Stat>
      </div>

      {view.untracked ? (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {view.untracked.toLocaleString()} selling {view.untracked === 1 ? "variant" : "variants"} sold on 3 or more of the last 30 days that opened
          with no stock, so {view.untracked === 1 ? "its" : "their"} count in Inventorify is not the real shelf: the store sells past zero, or the
          count is not kept up. {view.untracked === 1 ? "It is" : "They are"} left out of “out of stock” and “reorder now”.
        </p>
      ) : null}

      <div className="rounded-2xl bg-white p-5">
        <h2 className="font-display text-lg font-bold text-gray-900">What runs out first</h2>
        <p className="mt-1 text-sm text-gray-600">
          Days of cover = on hand ÷ units a day, sold {rate}. Lead time is the supplier's measured time from order to delivery once it has 3 received purchase orders, otherwise the variant's setting in Inventorify. Days out of stock count
          the days in this period that opened with an empty shelf.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
              <tr>
                <th className="py-2 pr-4">Variant</th>
                <th className="py-2 pr-4">State</th>
                <th className="py-2 pr-4 text-right">On hand</th>
                <th className="py-2 pr-4 text-right">Sold, {periodDays} days</th>
                <th className="py-2 pr-4 text-right">A day</th>
                <th className="py-2 pr-4 text-right">Days of cover</th>
                <th className="py-2 pr-4 text-right">Lead time</th>
                <th className="py-2 pr-4 text-right">On order</th>
                <th className="py-2 text-right">Days out of stock</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {view.rows.map((r) => (
                <tr key={r.variantId}>
                  <td className="max-w-xs py-2 pr-4">
                    <span className="block truncate font-medium text-gray-900" title={r.title}>{r.title}</span>
                    <span className="block truncate text-xs text-gray-500">{[r.variantTitle, r.sku].filter(Boolean).join(" · ") || " "}</span>
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE[r.state].className}`}
                      title={r.state === "untracked" ? `Sold on ${r.soldAtZeroDays} of the last 30 days that opened with no stock` : undefined}
                    >
                      {STATE[r.state].text}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{r.stock.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{r.soldInPeriod.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{r.perDay ? r.perDay.toFixed(1) : r.daysOfCover !== null && r.stock > 0 ? "<0.1" : "—"}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{r.daysOfCover === null ? "—" : r.daysOfCover.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{r.leadTimeDays === null ? "—" : `${r.leadTimeDays}d${r.leadSource === "measured" ? " (measured)" : ""}`}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{r.onOrder ? r.onOrder.toLocaleString() : "—"}</td>
                  <td className="py-2 text-right tabular-nums text-gray-700">
                    {r.daysSnapshotted ? `${r.daysOut} of ${r.daysSnapshotted}` : <span className="text-gray-400">no record</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {view.hiddenRows ? (
          <p className="mt-3 text-xs text-gray-500">{view.hiddenRows.toLocaleString()} more variants with enough stock or no recent sales are not listed.</p>
        ) : null}
      </div>

      <div className="rounded-2xl bg-white p-5">
        <h2 className="font-display text-lg font-bold text-gray-900">Stock on the way</h2>
        {view.openOrders.length ? (
          <ul className="mt-3 divide-y divide-gray-100 text-sm">
            {view.openOrders.map((po) => (
              <li key={po.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="font-medium text-gray-900">
                  {po.poNumber}
                  {po.supplierName ? <span className="font-normal text-gray-500"> · {po.supplierName}</span> : null}
                </span>
                <span className="tabular-nums text-gray-700">
                  {po.units.toLocaleString()} units, {po.variants} {po.variants === 1 ? "variant" : "variants"} · {po.status.replace(/_/g, " ")}
                  {po.expected ? ` · expected ${shortDay(po.expected)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-gray-600">
            No open purchase orders in Inventorify. If you reorder outside it, “Reorder now” cannot know.
          </p>
        )}
      </div>
    </section>
  );
}
