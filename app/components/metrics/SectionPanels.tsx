import { Link } from "react-router";
import type {
  CustomersView,
  FinanceView,
  HomeView,
  OrdersView,
  ShippingView,
} from "~/lib/metrics/screens.server";
import {
  CoverageNotice,
  DeliveryRateText,
  formatAmount,
  MoneyList,
  Notice,
  OutcomeText,
  outcomeLabel,
  Stat,
} from "./Metrics";
import { InboxCards } from "./FindingCards";
import type { InboxView } from "~/lib/insights/inbox.server";

/**
 * The open state of each section (G-GZR2-5): read-only, from the metric
 * layer. Locked and reconnect states stay in section.tsx, unchanged from
 * Phase 1 (D-16, D-43).
 */

// ── Home ────────────────────────────────────────────────────────────────────

export function HomePanel({
  view,
  inbox,
  period,
}: {
  view: HomeView;
  inbox: InboxView;
  period: { from: string; to: string };
}) {
  // The Courierify card says what the coverage notice says, with a link.
  const stopped = inbox.items.some((i) => i.insight.finding.kind === "courierify_stopped");
  return (
    <section className="space-y-6">
      <InboxCards inbox={inbox} from={period.from} to={period.to} />
      <div className="space-y-3">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {view.funnel.map((step, i) => (
            <li key={step.label} className="rounded-xl bg-gray-50 p-3">
              <p className="text-xs font-medium text-gray-500">
                {i + 1}. {step.label}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900">
                {step.count === null ? "—" : step.count.toLocaleString()}
              </p>
              {step.note ? <p className="mt-0.5 text-xs text-gray-500">{step.note}</p> : null}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm">
          <DeliveryRateText rate={view.deliveryRate} />
          <span className="text-gray-500"> — delivered ÷ (delivered + returned), by order, grouped by order date</span>
        </p>
      </div>
      {stopped ? null : <CoverageNotice coverage={view.coverage} />}
      </div>
    </section>
  );
}

// ── Finance ─────────────────────────────────────────────────────────────────

export function FinancePanel({ view }: { view: FinanceView }) {
  const p = view.profit;
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Placed revenue" note="Orders as placed (Financify)">
          <MoneyList values={view.placed} />
        </Stat>
        <Stat label="Delivered revenue" note="Orders the courier delivered">
          <MoneyList values={view.deliveredRevenue} />
        </Stat>
        <Stat label="Paid by courier" note="COD in courier settlements (Courierify)">
          <MoneyList values={view.paidByCourier} />
        </Stat>
      </div>
      {/* Rule #17's second stage does not exist for any merchant yet (PLAN §10). */}
      <Notice>
        Received in bank: not yet available. Bank reconciliation needs Financify's cash ledger, which has not held a
        settlement yet — so this shows what couriers paid, not what reached your account.
      </Notice>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Product cost, delivered orders"
          note={view.cogsIncompleteOrders ? `${view.cogsIncompleteOrders} delivered order(s) have a line with no cost` : "At the cost when each order was placed"}
        >
          <MoneyList values={view.cogsDelivered} />
        </Stat>
        <Stat
          label="Courier fees"
          note={
            view.shippedOrdersWithoutFee
              ? `Known for ${(view.shippedOrders - view.shippedOrdersWithoutFee).toLocaleString()} of ${view.shippedOrders.toLocaleString()} shipped orders`
              : "Known for every shipped order"
          }
        >
          <MoneyList values={view.courierFees} />
        </Stat>
        <Stat
          label="Ad spend"
          note={
            view.adSpend
              ? `Fees ${view.adSpend.fees.map((f) => formatAmount(f.amount)).join(" + ") || "0"} on top · ad-platform days, ${view.adSpend.daysFetched} of ${view.adSpend.daysInPeriod} fetched`
              : "Needs Financify"
          }
        >
          {view.adSpend ? <MoneyList values={view.adSpend.spend} /> : <span className="text-gray-400">—</span>}
        </Stat>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Profit after returns</p>
        {p ? (
          <>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-gray-900">
              <MoneyList values={[{ amount: p.amount, currency: p.currency }]} />
              {!p.complete ? <span className="ml-2 align-middle text-sm font-medium text-amber-700">at most</span> : null}
            </p>
            <p className="mt-1 text-sm text-gray-600">
              Delivered revenue {formatAmount(p.parts.deliveredRevenue)} − product cost {formatAmount(p.parts.cogsDelivered)} −
              courier fees {formatAmount(p.parts.courierFees)} − ads{" "}
              {p.parts.adSpend !== null ? formatAmount(p.parts.adSpend) : "not subtracted"}
              {view.roas !== null ? ` · ROAS ${view.roas.toFixed(2)} (delivered revenue ÷ ad spend)` : ""}
            </p>
            {p.missing.length ? (
              <div className="mt-3">
                <Notice tone="warn">
                  Not a final figure — missing: {p.missing.join("; ")}.
                </Notice>
              </div>
            ) : null}
            <p className="mt-3 text-xs text-gray-500">
              Growzar's own definition, the same for every store. Financify's net profit follows this store's settings
              {view.settings.settingsHash ? "" : " (not known: Financify is not connected)"} — see Settings → Profit.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-gray-500">This store has not reported its currency yet.</p>
        )}
      </div>
    </section>
  );
}

// ── Orders ──────────────────────────────────────────────────────────────────

const FILTER_LABEL = (f: NonNullable<OrdersView["filter"]>) =>
  f.kind === "variant"
    ? `orders containing variant ${f.variantId} (international orders left out)`
    : f.kind === "disagree"
      ? "orders where Courierify and Financify disagree on the outcome"
      : f.app === "financify"
        ? "orders with no Courierify parcel, decided by Financify"
        : "orders decided by Courierify";

export function OrdersPanel({ view, days }: { view: OrdersView; days: number }) {
  const disagree = view.filter?.kind === "disagree";
  return (
    <section className="space-y-3">
      {view.filter ? (
        <Notice>
          Showing {view.total.toLocaleString()} {FILTER_LABEL(view.filter)}.{" "}
          <Link to={`/orders?days=${days}`} className="font-medium text-primary-600 hover:underline">
            Show all orders
          </Link>
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="rounded-full bg-gray-900 px-3 py-1 text-white">{view.total.toLocaleString()} orders</span>
        {view.byOutcome.map((o) => (
          <span key={o.outcome} className="rounded-full bg-gray-100 px-3 py-1 text-gray-700">
            {o.outcome.replace(/_/g, " ")} {o.count.toLocaleString()}
          </span>
        ))}
      </div>
      <Notice>
        Buyer risk is not shown yet: it needs Courierify's network band or Preventify, neither of which Growzar reads in
        this release.
      </Notice>
      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2.5">Order</th>
              <th className="px-4 py-2.5">Day</th>
              <th className="px-4 py-2.5 text-right">Placed</th>
              <th className="px-4 py-2.5">Outcome</th>
              {disagree ? <th className="px-4 py-2.5">Financify says</th> : null}
              <th className="px-4 py-2.5">Confirmation</th>
              <th className="px-4 py-2.5">Courier · city</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {view.rows.map((r) => (
              <tr key={r.orderId}>
                <td className="px-4 py-2.5 font-medium text-gray-900">{r.orderName ?? r.orderId}</td>
                <td className="px-4 py-2.5 text-gray-600">{r.localDay ?? "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  {r.placed ? <MoneyList values={[r.placed]} /> : <span className="text-gray-400">no total</span>}
                </td>
                <td className="px-4 py-2.5 text-gray-700">
                  <OutcomeText outcome={r.outcome} timing={r.timing} authority={r.authority} />
                  {r.refunded && Number(r.refunded.amount) > 0 ? (
                    <span className="ml-2 rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">refunded {r.refunded.amount}</span>
                  ) : null}
                </td>
                {disagree ? (
                  <td className="px-4 py-2.5 text-gray-600">
                    {view.financifySays[r.orderId] ? outcomeLabel(view.financifySays[r.orderId]!) : "—"}
                  </td>
                ) : null}
                <td className="px-4 py-2.5 text-gray-600">{r.confirmation?.replace(/_/g, " ") ?? "—"}</td>
                <td className="px-4 py-2.5 text-gray-600">
                  {r.courier?.replace(/^financify:/, "") ?? "—"} · {r.city ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.total > view.shown ? (
          <p className="border-t border-gray-100 px-4 py-2.5 text-xs text-gray-500">
            Latest {view.shown} of {view.total.toLocaleString()} {view.filter ? "matching " : ""}orders in this period.
          </p>
        ) : null}
      </div>
    </section>
  );
}

// ── Shipping ────────────────────────────────────────────────────────────────

export function ShippingPanel({ view }: { view: ShippingView }) {
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Delivery rate" note="By order, grouped by the day the order was placed">
          <DeliveryRateText rate={view.deliveryRate} />
        </Stat>
        <Stat label="Value of returned orders" note="Returned to origin, confirmed by the courier — not cancellations">
          <MoneyList values={view.returnedValue} />
        </Stat>
      </div>
      <CoverageNotice coverage={view.coverage} />

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2.5">Courier</th>
              <th className="px-4 py-2.5 text-right">Orders</th>
              <th className="px-4 py-2.5">Delivery</th>
              <th className="px-4 py-2.5">Time to deliver</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {view.couriers.map((c) => (
              <tr key={c.courier}>
                <td className="px-4 py-2.5 font-medium text-gray-900">
                  {c.courier.replace(/^financify:/, "")}
                  {c.courier.startsWith("financify:") ? <span className="ml-1 text-xs text-gray-400">(Financify)</span> : null}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{c.orders.toLocaleString()}</td>
                <td className="px-4 py-2.5"><DeliveryRateText rate={c.deliveryRate} /></td>
                <td className="px-4 py-2.5 text-gray-600">{c.timing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2.5">City</th>
              <th className="px-4 py-2.5 text-right">Orders</th>
              <th className="px-4 py-2.5">Delivery</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {view.cities.map((c) => (
              <tr key={c.city}>
                <td className="px-4 py-2.5 font-medium text-gray-900">{c.city}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{c.orders.toLocaleString()}</td>
                <td className="px-4 py-2.5"><DeliveryRateText rate={c.deliveryRate} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-gray-100 px-4 py-2.5 text-xs text-gray-500">
          Cities use Courierify's mapping; spellings it cannot place are grouped as “unmapped”, not listed as cities.
        </p>
      </div>
    </section>
  );
}

// ── Customers ───────────────────────────────────────────────────────────────

export function CustomersPanel({ view }: { view: CustomersView }) {
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Buyers, all time" note="Counted once each, however they write their number">
          <span className="font-semibold tabular-nums">{view.customers.toLocaleString()}</span>
        </Stat>
        <Stat label="Buyers this period">
          <span className="font-semibold tabular-nums">{view.buyersInPeriod.toLocaleString()}</span>
        </Stat>
        <Stat label="Repeat buyers" note="Of this period's buyers, those with two or more orders ever">
          <span className="font-semibold tabular-nums">
            {view.repeatBuyers.toLocaleString()}
            {view.buyersInPeriod ? (
              <span className="ml-1 text-sm font-normal text-gray-500">
                ({((100 * view.repeatBuyers) / view.buyersInPeriod).toFixed(1)}%)
              </span>
            ) : null}
          </span>
        </Stat>
      </div>
      <Notice>
        Consent and opt-outs are not shown yet: they live in Retainify and WhatKaBot, which Growzar reads from the next
        release.
      </Notice>
      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2.5">Buyer</th>
              <th className="px-4 py-2.5 text-right">Orders</th>
              <th className="px-4 py-2.5">Delivery</th>
              <th className="px-4 py-2.5 text-right">Delivered revenue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {view.top.map((c) => (
              <tr key={c.customerId}>
                <td className="px-4 py-2.5 font-medium text-gray-900">{c.name ?? "Unnamed buyer"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{c.orders}</td>
                <td className="px-4 py-2.5"><DeliveryRateText rate={c.deliveryRate} /></td>
                <td className="px-4 py-2.5 text-right"><MoneyList values={c.deliveredRevenue} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-gray-100 px-4 py-2.5 text-xs text-gray-500">Top buyers this period, by delivered orders.</p>
      </div>
    </section>
  );
}
