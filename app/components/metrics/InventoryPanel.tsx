import { Link } from "react-router";
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
  stuck: { value: Money | null; variants: number; uncosted: number };
  hasOutcomes: boolean;
  hasProfit: boolean;
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
    deliveryRate: number | null;
    rateSource: "variant" | "store" | null;
    netPerDay: number | null;
    netDaysOfCover: number | null;
    reorderUnits: number | null;
    profit: Money | null;
    topProfit: boolean;
  }>;
  hiddenRows: number;
  state: StockState | null;
  byState: Array<{ state: StockState; count: number }>;
  receivedOrders: number;
  reordersInInventorify: boolean;
  openOrders: Array<{ id: string; poNumber: string; status: string; supplierName: string | null; expected: string | null; daysLate: number | null; units: number; variants: number }>;
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

/** Days a reorder should last once it arrives (`COVER_AFTER_ARRIVAL` in metrics/inventory.ts). */
const COVER_AFTER_ARRIVAL = 30;

export function InventoryPanel({
  view,
  periodDays,
  period,
  canSeeMoney,
}: {
  view: InventoryPanelView;
  periodDays: number;
  period: string;
  canSeeMoney: boolean;
}) {
  if (view.variants === 0) {
    return (
      <section className="rounded-2xl bg-white p-8 text-sm text-gray-600">
        Inventorify has not sent any products for this store yet.
      </section>
    );
  }
  const rate = `${shortDay(view.rateWindow.from)}–${shortDay(view.rateWindow.to)}`;
  const showProfit = canSeeMoney && view.hasProfit;
  const late = view.openOrders.filter((po) => po.daysLate);
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
        <Stat
          label="Stock that is not selling"
          note={
            <>
              At cost, {view.stuck.variants.toLocaleString()} {view.stuck.variants === 1 ? "variant" : "variants"} in stock with no sale in 30 days
              {view.stuck.uncosted ? `, ${view.stuck.uncosted.toLocaleString()} without a cost not counted` : ""}.{" "}
              <Link to={`/inventory?${period}&stock=slow`} preventScrollReset className="font-semibold text-navy hover:underline">
                See them
              </Link>
            </>
          }
        >
          {view.stuck.value ? <MoneyList values={[view.stuck.value]} /> : <span className="text-gray-400">currency not reported yet</span>}
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
          {view.hasOutcomes ? (
            <>
              {" "}Delivered is the share of decided orders with the variant delivered, over the last 90 days (the store's own rate until the variant has 20);
              cover net of returns assumes returned parcels go back on the shelf.
            </>
          ) : null}{" "}
          Order now covers the lead time plus {COVER_AFTER_ARRIVAL} days, at the net rate where there is one, less what is on hand and on order.
          {showProfit ? ` Profit is the period's, as Finance's product table has it; “Top” marks the variants that make 80% of it, listed first in their state.` : ""}
        </p>
        <nav aria-label="Filter by state" className="mt-4 flex flex-wrap gap-2 text-sm font-semibold">
          {[{ state: null, count: view.variants }, ...view.byState].map((s) => {
            const active = s.state === view.state;
            return (
              <Link
                key={s.state ?? "all"}
                to={`/inventory?${period}${s.state ? `&stock=${s.state}` : ""}`}
                preventScrollReset
                aria-current={active ? "true" : undefined}
                className={`tap inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 transition ${
                  active ? "bg-navy text-white" : "bg-gray-50 text-gray-700 hover:bg-gray-100"
                }`}
              >
                {s.state ? STATE[s.state].text : "All variants"}{" "}
                <span className={`tabular-nums ${active ? "text-navy-muted" : "text-gray-500"}`}>{s.count.toLocaleString()}</span>
              </Link>
            );
          })}
        </nav>
        <div className="mt-4 overflow-x-auto">
          <table className="pin-first min-w-full text-sm">
            <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
              <tr>
                <th className="py-2 pr-4">Variant</th>
                <th className="py-2 pr-4">State</th>
                <th className="py-2 pr-4 text-right">On hand</th>
                <th className="py-2 pr-4 text-right">Sold, {periodDays} days</th>
                <th className="py-2 pr-4 text-right">A day</th>
                <th className="py-2 pr-4 text-right">Days of cover</th>
                {view.hasOutcomes ? <th className="py-2 pr-4 text-right">Delivered</th> : null}
                <th className="py-2 pr-4 text-right">Lead time</th>
                <th className="py-2 pr-4 text-right">On order</th>
                <th className="py-2 pr-4 text-right">Order now</th>
                {showProfit ? <th className="py-2 pr-4 text-right">Profit, {periodDays} days</th> : null}
                <th className="py-2 text-right">Days out of stock</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {view.rows.map((r) => (
                <tr key={r.variantId}>
                  <td className="max-w-xs py-2 pr-4">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-gray-900" title={r.title}>{r.title}</span>
                      {showProfit && r.topProfit ? (
                        <span className="shrink-0 rounded-full bg-mint px-2 py-0.5 text-[10px] font-bold text-navy" title="Among the variants that make 80% of the period's profit">
                          Top
                        </span>
                      ) : null}
                    </span>
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
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-900">
                    {r.daysOfCover === null ? "—" : r.daysOfCover.toLocaleString()}
                    {r.netDaysOfCover !== null && r.netDaysOfCover !== r.daysOfCover ? (
                      <span className="block text-xs text-gray-500">{r.netDaysOfCover.toLocaleString()} net of returns</span>
                    ) : null}
                  </td>
                  {view.hasOutcomes ? (
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-700">
                      {r.deliveryRate === null ? "—" : `${r.deliveryRate}%`}
                      {r.rateSource === "store" ? <span className="block text-xs text-gray-500">store</span> : null}
                    </td>
                  ) : null}
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{r.leadTimeDays === null ? "—" : `${r.leadTimeDays}d${r.leadSource === "measured" ? " (measured)" : ""}`}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{r.onOrder ? r.onOrder.toLocaleString() : "—"}</td>
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-gray-900">{r.reorderUnits ? r.reorderUnits.toLocaleString() : "—"}</td>
                  {showProfit ? (
                    <td className={`py-2 pr-4 text-right tabular-nums ${r.profit?.amount.startsWith("-") ? "text-red-700" : "text-gray-700"}`}>
                      {r.profit ? <MoneyList values={[r.profit]} /> : "—"}
                    </td>
                  ) : null}
                  <td className="py-2 text-right tabular-nums text-gray-700">
                    {r.daysSnapshotted ? `${r.daysOut} of ${r.daysSnapshotted}` : <span className="text-gray-400">no record</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {view.state && !view.rows.length ? <p className="mt-3 text-sm text-gray-600">No variants are in this state now.</p> : null}
        {view.hiddenRows ? (
          <p className="mt-3 text-xs text-gray-500">
            {view.hiddenRows.toLocaleString()} more {view.state ? `“${STATE[view.state].text}” variants` : "variants with enough stock or no recent sales"} are not listed.
          </p>
        ) : null}
      </div>

      <div className="rounded-2xl bg-white p-5">
        <h2 className="font-display text-lg font-bold text-gray-900">Stock on the way</h2>
        {late.length ? (
          <p className="mt-1 text-sm text-red-700">
            {late.length.toLocaleString()} {late.length === 1 ? "order is" : "orders are"} past {late.length === 1 ? "its" : "their"} expected date and not received.
          </p>
        ) : null}
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
                  {po.daysLate ? (
                    <span className="ml-2 whitespace-nowrap rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700">
                      {po.daysLate} {po.daysLate === 1 ? "day" : "days"} late
                    </span>
                  ) : null}
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
