import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import type {
  CustomersView,
  FinanceView,
  FinanceDepth,
  ShippingDepth,
  HomeView,
  MarketingView,
  Owed,
  OrdersView,
  ShippingView,
} from "~/lib/metrics/screens.server";
import {
  Change,
  Sparkline,
  DeliveryRateText,
  formatAmount,
  MoneyList,
  baseFirst,
  FxNotice,
  OutcomeText,
  outcomeLabel,
  Stat,
} from "./Metrics";
import { InboxCards } from "./FindingCards";
import { scopeLabel } from "./FilterBar";
import { CohortGrid, RepeatCurve } from "./Retention";
import { CashTimelineCard, CourierDeductions, MoneyBreakdown } from "./FinanceDepth";
import { ProfitTables } from "./ProfitTables";
import { CourierPerformanceTable, OutcomesChart, ReturnsCard } from "./ShippingDepth";
import { CampaignOutcomesTable, CampaignTable, ChannelCourierTable, CityDeliveryTable, ConfirmationFunnelView, PayoutAgeingTable, ProductMatrix } from "./Matrices";
import type { ConfirmationFunnel, PayoutAgeing } from "~/lib/metrics/matrices";
import { MIN_DECIDED_TO_RATE } from "~/lib/metrics/compare";
import { MIN_COHORT_BUYERS, MIN_ELIGIBLE_BUYERS } from "~/lib/metrics/cohorts";
import type { InboxView } from "~/lib/insights/inbox.server";

/**
 * The open state of each section (G-GZR2-5): read-only, from the metric
 * layer. Locked and reconnect states stay in section.tsx, unchanged from
 * Phase 1 (D-16, D-43).
 */

// ── Home ────────────────────────────────────────────────────────────────────

export function HomePanel({
  view,
  owed,
  inbox,
  period,
}: {
  view: HomeView;
  owed: Owed | null;
  inbox: InboxView;
  period: { from: string; to: string };
}) {
  return (
    <section className="space-y-6">
      <HomeMetrics view={view} owed={owed} />
      <FxNotice fx={view.fx} />
      <InboxCards inbox={inbox} from={period.from} to={period.to} />
    </section>
  );
}

/** One amount large, any other currencies under it, never added (rule #4). */
function BigMoney({ values, base, empty = "—" }: { values: { amount: string; currency: string }[]; base: string | null; empty?: string }) {
  // The store's currency leads; anything left in another is unconverted (rule #4).
  const [first, ...rest] = baseFirst(values, base);
  if (!first) return <span>{empty}</span>;
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">
        <span className="mr-1.5 text-[0.55em] font-semibold opacity-80">{first.currency}</span>
        {formatAmount(first.amount).replace(/\.\d+$/, "")}
      </span>
      {rest.map((m) => (
        <span key={m.currency} className="mt-1 font-sans text-sm font-semibold tabular-nums opacity-80">
          + {formatAmount(m.amount)} {m.currency}, not converted
        </span>
      ))}
    </span>
  );
}

/**
 * The headline row: one big figure, two beside it, and what is owed to the
 * merchant in coral. Without Finance permission the same places hold counts.
 */
function HomeMetrics({ view, owed }: { view: HomeView; owed: Owed | null }) {
  const rate = view.deliveryRate;
  const peak = Math.max(1, ...view.daily.map((d) => d.delivered));
  const money = view.money;
  const delivered = view.funnel.find((f) => f.label === "Delivered")?.count ?? rate.delivered;
  return (
    <div className="grid gap-3.5 lg:grid-cols-[1.35fr_1fr_1fr]">
      <div className="flex flex-col gap-2.5 rounded-2xl bg-navy p-6 text-white">
        <span className="text-sm font-semibold text-navy-muted">{money ? "Delivered revenue" : "Delivered orders"}</span>
        <span className="font-display text-4xl font-bold leading-none tracking-tight">
          {money ? <BigMoney values={money.deliveredRevenue} base={view.base} /> : delivered.toLocaleString()}
        </span>
        <Change h={view.compare.delivered} kind={money ? "money" : "count"} dark />
        <div className="mt-3 flex min-h-[3rem] flex-1 items-end gap-[3px]" aria-hidden="true">
          {view.daily.map((d, i) => (
            <span
              key={d.day}
              title={`${d.day}: ${d.delivered} delivered`}
              className={`flex-1 rounded-sm ${i === view.daily.length - 1 ? "bg-mint" : "bg-navy-line"}`}
              style={{ height: `${Math.max(4, (100 * d.delivered) / peak)}%` }}
            />
          ))}
        </div>
        <span className="text-xs text-navy-muted">
          {delivered.toLocaleString()} delivered orders, by the day each was placed
        </span>
      </div>

      <div className="flex flex-col gap-3.5">
        <div className="flex flex-1 flex-col gap-1.5 rounded-2xl bg-white p-5">
          <span className="text-sm font-semibold text-gray-700">Delivery rate</span>
          <span className="font-display text-3xl font-bold tabular-nums">
            {rate.rate === null ? "—" : `${(100 * rate.rate).toFixed(1)}%`}
          </span>
          <Change h={view.compare.deliveryRate} kind="rate" />
          <Sparkline trend={view.compare.deliveryRate.trend} />
          <span className="self-start rounded-full bg-field px-2.5 py-0.5 text-xs font-semibold text-gray-700">
            {rate.stillOpen.toLocaleString()} still in transit · {(rate.delivered + rate.returned).toLocaleString()} decided
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 rounded-2xl bg-white p-5">
          <span className="text-sm font-semibold text-gray-700">{money ? "Profit after returns" : "Returned"}</span>
          <span className="font-display text-3xl font-bold">
            {money ? (
              money.profit ? <BigMoney values={[money.profit]} base={view.base} /> : "—"
            ) : (
              rate.returned.toLocaleString()
            )}
          </span>
          {view.compare.profit ? <Change h={view.compare.profit} kind="money" /> : null}
          {money?.profit ? (
            <span className="text-xs text-gray-500">Delivered revenue less product cost, courier fees and ads</span>
          ) : null}
        </div>
      </div>

      {owed ? (
        <div className="flex flex-col gap-2.5 rounded-2xl bg-coral p-6 text-navy">
          <span className="text-sm font-bold">COD not yet paid, as of today</span>
          <span className="font-display text-4xl font-bold leading-none tracking-tight">
            <BigMoney values={owed.amounts} base={view.base} empty="Nothing owed" />
          </span>
          <span className="font-medium leading-snug">
            {owed.orders
              ? `${owed.orders.toLocaleString()} delivered order${owed.orders === 1 ? "" : "s"}, any order date, from couriers whose payouts Courierify records.`
              : "Every delivered Courierify order has a courier payout recorded."}
          </span>
          {owed.untracked.length === 1 ? (
            <Link to={`/orders?unpaid=${encodeURIComponent(owed.untracked[0]!.courier)}`} className="text-sm font-medium leading-snug underline-offset-2 hover:underline">
              Apart: {owed.untracked[0]!.amounts.map((m) => `${formatAmount(m.amount).replace(/\.\d+$/, "")} ${m.currency}`).join(" + ")} delivered by{" "}
              {owed.untracked[0]!.courier} ({owed.untracked[0]!.orders.toLocaleString()} orders), whose payouts Courierify has never recorded.
            </Link>
          ) : owed.untracked.length > 1 ? (
            <Link to="/finance" className="text-sm font-medium leading-snug underline-offset-2 hover:underline">
              Apart: {owed.untracked.reduce((n, u) => n + u.orders, 0).toLocaleString()} delivered orders from {owed.untracked.length} couriers
              whose payouts Courierify has never recorded.
            </Link>
          ) : null}
          <Link
            to="/finance"
            className="mt-auto inline-flex items-center gap-2 self-start rounded-full bg-navy px-5 py-3 text-sm font-bold text-white hover:bg-navy-surface"
          >
            See Finance <ArrowRight className="h-4 w-4 text-mint" />
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 rounded-2xl bg-white p-6">
          <span className="text-sm font-semibold text-gray-700">Still in transit</span>
          <span className="font-display text-4xl font-bold">{rate.stillOpen.toLocaleString()}</span>
          <span className="text-sm text-gray-500">Orders with no final outcome yet.</span>
        </div>
      )}
    </div>
  );
}

// ── Finance ─────────────────────────────────────────────────────────────────

export function FinancePanel({
  view,
  ageing,
  depth,
  days,
  scope,
}: {
  view: FinanceView;
  ageing: PayoutAgeing | null;
  depth: FinanceDepth | null;
  days: number;
  scope: string;
}) {
  const p = view.profit;
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Placed revenue" note="Orders as placed (Financify)" change={<Change h={view.compare.placed} kind="money" />} trend={<Sparkline trend={view.compare.placed.trend} />}>
          <MoneyList values={baseFirst(view.placed, view.base)} />
        </Stat>
        <Stat label="Delivered revenue" note="Orders the courier delivered" change={<Change h={view.compare.deliveredRevenue} kind="money" />} trend={<Sparkline trend={view.compare.deliveredRevenue.trend} />}>
          <MoneyList values={baseFirst(view.deliveredRevenue, view.base)} />
        </Stat>
        <Stat label="Paid by courier" note="COD in courier settlements (Courierify)" change={<Change h={view.compare.paidByCourier} kind="money" />} trend={<Sparkline trend={view.compare.paidByCourier.trend} />}>
          <MoneyList values={baseFirst(view.paidByCourier, view.base)} />
        </Stat>
      </div>
      <FxNotice fx={view.fx} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Product cost, delivered orders"
          note="At the cost when each order was placed"
          change={<Change h={view.compare.cogsDelivered} kind="money" />}
        >
          <MoneyList values={view.cogsDelivered} />
        </Stat>
        <Stat
          label="Courier fees"
          note="Charged by the courier on shipped orders (Courierify)"
          change={<Change h={view.compare.courierFees} kind="money" />}
        >
          <MoneyList values={view.courierFees} />
        </Stat>
        <Stat
          label="Ad spend"
          note={
            view.adSpend
              ? `Fees ${view.adSpend.fees.map((f) => formatAmount(f.amount)).join(" + ") || "0"} on top · by ad-platform day`
              : view.scoped
                ? "Store-wide, so not shown for one courier or city"
                : "Needs Financify"
          }
          change={view.adSpend ? <Change h={view.compare.adSpend} kind="money" /> : null}
        >
          {view.adSpend ? <MoneyList values={view.adSpend.spend} /> : <span className="text-gray-400">—</span>}
        </Stat>
      </div>

      <div className="rounded-2xl bg-navy p-6 text-white">
        <p className="text-sm font-semibold text-navy-muted">Profit after returns</p>
        {p ? (
          <>
            <p className="mt-2 font-display text-4xl font-bold tabular-nums">
              <MoneyList values={[{ amount: p.amount, currency: p.currency }]} />
            </p>
            <div className="mt-1">
              <Change h={view.compare.profit} kind="money" dark />
            </div>
            <p className="mt-2 text-sm text-navy-muted">
              Delivered revenue {formatAmount(p.parts.deliveredRevenue)} − product cost {formatAmount(p.parts.cogsDelivered)} −
              courier fees {formatAmount(p.parts.courierFees)} − ads{" "}
              {p.parts.adSpend !== null ? formatAmount(p.parts.adSpend) : "not subtracted"}
              {p.parts.otherCosts ? ` − other costs ${formatAmount(p.parts.otherCosts.total)}` : ""}
              {view.roas !== null ? ` · ROAS ${view.roas.toFixed(2)} (delivered revenue ÷ ad spend)` : ""}
            </p>
            {depth?.expected && depth.expected.withCourier.orders ? (
              <div className="mt-4 rounded-xl bg-navy-surface p-4">
                <p className="text-sm font-semibold text-navy-muted">Expected once parcels with couriers settle</p>
                <p className="mt-1 font-display text-2xl font-bold tabular-nums">
                  <MoneyList values={[depth.expected.amount]} />
                </p>
                <p className="mt-1 text-sm text-navy-muted">
                  {depth.expected.withCourier.orders.toLocaleString()} parcels with couriers (
                  {formatAmount(depth.expected.withCourier.placed.amount).replace(/\.\d+$/, "")} {depth.expected.withCourier.placed.currency}),
                  each counted at its own route&apos;s delivery rate over the last 90 days
                  {depth.expected.levels.courier || depth.expected.levels.store
                    ? ` (${depth.expected.levels.route} by city and courier, ${depth.expected.levels.courier} by courier, ${depth.expected.levels.store} by the store's rate where a route had too few)`
                    : ""}
                  {depth.expected.unpriced ? `; ${depth.expected.unpriced} with no settled history are left out` : ""}.
                  {depth.expected.notDispatched ? ` ${depth.expected.notDispatched.toLocaleString()} orders not dispatched yet are not counted.` : ""}
                </p>
              </div>
            ) : view.stillOpen ? (
              <p className="mt-1 text-sm text-navy-muted">
                {view.stillOpen.toLocaleString()} orders from this period are still with the courier; their revenue counts
                when they deliver.
              </p>
            ) : null}
            <p className="mt-3 text-xs text-navy-muted">
              Growzar's own definition, the same for every store. Financify's net profit follows this store's settings —
              see Settings → Profit.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-navy-muted">This store has not reported its currency yet.</p>
        )}
      </div>
      {depth ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <MoneyBreakdown lines={depth.breakdown} days={days} scope={scope} />
          <CashTimelineCard cash={depth.cash} days={days} scope={scope} payment={depth.payment} />
        </div>
      ) : null}
      {depth?.profitBy ? <ProfitTables data={depth.profitBy} labels={depth.labels} images={depth.images} days={days} scope={scope} /> : null}
      {depth ? <CourierDeductions rows={depth.deductions} sources={depth.statementSources} /> : null}
      {ageing ? <PayoutAgeingTable ageing={ageing} /> : null}
    </section>
  );
}

// ── Orders ──────────────────────────────────────────────────────────────────

const FILTER_LABEL = (f: NonNullable<OrdersView["filter"]>) =>
  f.kind === "variant"
    ? `orders containing variant ${f.variantId} (international orders left out)`
    : f.kind === "disagree"
      ? "orders where Courierify and Financify disagree on the outcome"
      : f.kind === "fee_missing"
        ? "orders shipped through Courierify with no courier fee recorded"
        : f.kind === "city"
          ? `orders delivered to ${f.city}`
          : f.kind === "city_route"
          ? `orders shipped to ${f.city} with ${f.courier}${f.via === "direct" ? ", booked directly" : ` through ${f.via}`}`
          : f.kind === "unanswered_waiting"
          ? "orders the buyer never answered on WhatsApp, not yet with the courier"
          : f.kind === "stuck"
          ? "parcels with no courier status change for days: booked and not picked up, or in transit with no update"
          : f.kind === "unpaid"
          ? f.age === "any"
            ? `delivered ${f.courier} orders with no payout recorded in Courierify (any order date, as of today)`
            : `delivered orders with no ${f.courier} payout recorded, delivered ${f.age === "unknown" ? "on no recorded date" : f.age === "61+" ? "over 60 days ago" : `${f.age.replace("-", "–")} days ago`} (any order date, as of today)`
          : f.kind === "awaiting_payout"
          ? `delivered orders with no ${f.payer} payout recorded, past its usual gap (any order date, as of today)`
        : f.app === "financify"
          ? "orders with no Courierify parcel, decided by Financify"
          : "orders decided by Courierify";

/** Delivered mint, returned coral, moving cyan, everything else grey. */
const OUTCOME_DOT: Record<string, string> = {
  delivered: "bg-mint-600",
  partially_delivered: "bg-mint",
  returned: "bg-coral",
  in_transit: "bg-data",
  booked: "bg-data",
};

function OutcomeDot({ outcome, className = "" }: { outcome: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full align-middle ${OUTCOME_DOT[outcome] ?? "bg-gray-300"} ${className}`}
    />
  );
}

function ConfirmationPill({ value }: { value: string }) {
  const tone =
    value === "confirmed"
      ? "bg-mint-100 text-mint-700"
      : value === "declined" || value === "timed_out" || value === "cancelled"
        ? "bg-coral-100 text-coral-700"
        : "bg-field text-gray-600";
  const label = value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{label}</span>
  );
}

export function OrdersPanel({
  view,
  days,
  scope = "",
  funnel,
  confirmation,
}: {
  view: OrdersView;
  days: number;
  scope?: string;
  funnel: ConfirmationFunnel;
  confirmation: string | null;
}) {
  const disagree = view.filter?.kind === "disagree";
  return (
    <section className="space-y-3">
      {view.filter ? null : (
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <Stat label="Orders placed" change={<Change h={view.compare} />}>
            <span className="tabular-nums">{view.allTotal.toLocaleString()}</span>
          </Stat>
          <div className="flex flex-col justify-end rounded-2xl bg-white p-5">
            <p className="text-sm font-semibold text-gray-700">Orders per day</p>
            <div className="mt-auto pt-2">
              <Sparkline trend={view.compare.trend} />
            </div>
          </div>
        </div>
      )}
      {view.filter ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-navy px-5 py-4 text-white">
          <p className="flex-1">
            <span className="font-display text-lg font-bold">Showing {view.total.toLocaleString()}</span>{" "}
            <span className="text-navy-muted">{FILTER_LABEL(view.filter)}.</span>
          </p>
          <Link
            to={`/orders?days=${days}${scope ? `&${scope}` : ""}`}
            className="rounded-full bg-mint px-4 py-2 text-sm font-bold text-navy hover:bg-mint-200"
          >
            Show all orders
          </Link>
        </div>
      ) : null}
      {view.filter ? null : (
        <ConfirmationFunnelView funnel={funnel} days={days} scope={scope} active={confirmation} min={MIN_DECIDED_TO_RATE} />
      )}
      <nav aria-label="Filter by outcome" className="flex flex-wrap gap-2 text-sm font-semibold">
        {[{ outcome: null, count: view.allTotal }, ...view.byOutcome].map((o) => {
          const active = o.outcome === view.outcome;
          // Set, not append: a finding filter and the filter bar can both carry a city.
          const q = new URLSearchParams(`days=${days}`);
          for (const part of [view.filterQuery, scope, confirmation ? `confirmation=${confirmation}` : "", o.outcome ? `outcome=${o.outcome}` : ""]) {
            for (const [k, v] of new URLSearchParams(part)) q.set(k, v);
          }
          const query = q.toString();
          return (
            <Link
              key={o.outcome ?? "all"}
              to={`/orders?${query}`}
              preventScrollReset
              aria-current={active ? "true" : undefined}
              className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 transition ${
                active ? "bg-navy text-white" : "bg-white text-gray-700 hover:bg-gray-100"
              }`}
            >
              {o.outcome ? <OutcomeDot outcome={o.outcome} /> : null}
              {o.outcome ? outcomeLabel(o.outcome) : "All orders"}{" "}
              <span className={`tabular-nums ${active ? "text-navy-muted" : "text-gray-500"}`}>{o.count.toLocaleString()}</span>
            </Link>
          );
        })}
      </nav>
      <div className="overflow-x-auto rounded-2xl bg-white">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="px-5 py-3">Order</th>
              <th className="px-5 py-3">Day</th>
              <th className="px-5 py-3 text-right">Placed</th>
              <th className="px-5 py-3">Outcome</th>
              {disagree ? <th className="px-5 py-3">Financify says</th> : null}
              <th className="px-5 py-3">Confirmation</th>
              <th className="px-5 py-3">Courier · city</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {view.rows.map((r) => (
              <tr key={r.orderId}>
                <td className="px-5 py-3 font-medium text-gray-900">{r.orderName ?? r.orderId}</td>
                <td className="whitespace-nowrap px-5 py-3 text-gray-600">{r.localDay ?? "—"}</td>
                <td className="px-5 py-3 text-right">
                  {r.placed ? <MoneyList values={[r.placed]} /> : <span className="text-gray-400">no total</span>}
                </td>
                <td className="px-5 py-3 text-gray-700">
                  <OutcomeDot outcome={r.outcome} className="mr-2" />
                  <OutcomeText outcome={r.outcome} timing={r.timing} authority={r.authority} />
                  {r.refunded && Number(r.refunded.amount) > 0 ? (
                    <span className="ml-2 rounded-full bg-coral-100 px-2 py-0.5 text-xs font-semibold text-coral-700">refunded {r.refunded.amount}</span>
                  ) : null}
                </td>
                {disagree ? (
                  <td className="px-5 py-3 text-gray-600">
                    {view.financifySays[r.orderId] ? outcomeLabel(view.financifySays[r.orderId]!) : "—"}
                  </td>
                ) : null}
                <td className="px-5 py-3">
                  {r.confirmation ? <ConfirmationPill value={r.confirmation} /> : <span className="text-gray-400">—</span>}
                </td>
                <td className="px-5 py-3 text-gray-600">
                  {r.courier?.replace(/^financify:/, "") ?? "—"} · {r.city ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.total > view.shown ? (
          <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">
            Latest {view.shown} of {view.total.toLocaleString()} {view.filter ? "matching " : ""}orders in this period.
          </p>
        ) : null}
      </div>
    </section>
  );
}

// ── Shipping ────────────────────────────────────────────────────────────────

export function ShippingPanel({
  view,
  depth,
  days,
  scope,
}: {
  view: ShippingView;
  depth: ShippingDepth;
  days: number;
  scope: { courier: string | null; city: string | null };
}) {
  // Every link keeps the period and whichever filter is already set (D2):
  // city → its couriers → the orders behind them.
  const link = (path: string, set: { courier?: string; city?: string }) => {
    const q = new URLSearchParams({ days: String(days) });
    const courier = set.courier ?? scope.courier;
    const city = set.city ?? scope.city;
    if (courier) q.set("courier", courier);
    if (city) q.set("city", city);
    return `${path}?${q.toString()}`;
  };
  const decided = (r: { deliveryRate: { delivered: number; returned: number } }) => r.deliveryRate.delivered + r.deliveryRate.returned;
  const rows = (list: ShippingView["cities"], kind: "courier" | "city") =>
    list.map((r) => {
      const other = r.key === "other";
      const name = other
        ? `${r.folded} more ${kind === "city" ? "cities" : "couriers"}, under ${view.minDecided} decided orders each`
        : scopeLabel(r.key);
      return { ...r, other, name };
    });
  const couriers = rows(view.couriers, "courier");
  const timing = new Map(view.couriers.map((c) => [c.key, c.timing]));
  const picked = (kind: "courier" | "city", key: string) => (kind === "courier" ? scope.courier === key : scope.city === key);

  const table = (kind: "courier" | "city", list: ReturnType<typeof rows>) => (
    <div className="overflow-x-auto rounded-2xl bg-white">
      <table className="min-w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
          <tr>
            <th className="px-5 py-3">
              {kind === "courier" ? "Courier" : "City"}
              {kind === "courier" && scope.city ? ` in ${scopeLabel(scope.city)}` : ""}
              {kind === "city" && scope.courier ? ` for ${scopeLabel(scope.courier)}` : ""}
            </th>
            <th className="px-5 py-3 text-right">Orders</th>
            <th className="px-5 py-3 text-right">Decided</th>
            <th className="px-5 py-3">Delivery</th>
            {kind === "courier" ? <th className="px-5 py-3">Time to deliver</th> : null}
            <th className="px-5 py-3"><span className="sr-only">Orders</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {list.map((r) => (
            <tr key={r.key} className={picked(kind, r.key) ? "bg-mint-50" : undefined}>
              <td className="px-5 py-3 font-medium text-gray-900">
                {r.other || picked(kind, r.key) ? (
                  <span className={r.other ? "font-normal text-gray-500" : undefined}>{r.name}</span>
                ) : (
                  <Link to={link("/shipping", kind === "courier" ? { courier: r.key } : { city: r.key })} preventScrollReset className="hover:underline">
                    {r.name}
                  </Link>
                )}
                {r.key.startsWith("financify:") ? <span className="ml-1 text-xs text-gray-400">(Financify)</span> : null}
              </td>
              <td className="px-5 py-3 text-right tabular-nums">{r.orders.toLocaleString()}</td>
              <td className="px-5 py-3 text-right tabular-nums text-gray-500">{decided(r).toLocaleString()}</td>
              <td className="px-5 py-3">
                {decided(r) >= view.minDecided ? (
                  <DeliveryRateText rate={r.deliveryRate} />
                ) : (
                  <span className="text-gray-500">{r.deliveryRate.stillOpen.toLocaleString()} still in transit</span>
                )}
              </td>
              {kind === "courier" ? <td className="px-5 py-3 text-gray-600">{r.other ? "" : timing.get(r.key)}</td> : null}
              <td className="px-5 py-3 text-right">
                {r.other ? null : (
                  <Link
                    to={link("/orders", kind === "courier" ? { courier: r.key } : { city: r.key })}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-accent-600 hover:underline"
                  >
                    Orders <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {kind === "city" ? (
        <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">
          {view.cityCount.toLocaleString()} {view.cityCount === 1 ? "city" : "cities"}. Pick one to see its couriers. Rates need {view.minDecided} decided orders;
          smaller cities are added up in one row. Cities use Courierify&apos;s mapping.
        </p>
      ) : (
        <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">Pick a courier to see its cities.</p>
      )}
    </div>
  );

  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Delivery rate"
          note="By order, grouped by the day the order was placed"
          change={<Change h={view.compare.deliveryRate} kind="rate" />}
          trend={<Sparkline trend={view.compare.deliveryRate.trend} />}
        >
          <DeliveryRateText rate={view.deliveryRate} />
        </Stat>
        <Stat
          label="Returned orders"
          note="Returned to origin, confirmed by the courier — not cancellations"
          change={<Change h={view.compare.returned} />}
          trend={<Sparkline trend={view.compare.returned.trend} className="text-coral-600" />}
        >
          <span className="tabular-nums">{view.deliveryRate.returned.toLocaleString()}</span>
        </Stat>
        <Stat label="Value of returned orders" change={<Change h={view.compare.returnedValue} kind="money" />}>
          <MoneyList values={view.returnedValue} />
        </Stat>
      </div>
      <OutcomesChart days={depth.outcomes} />
      <CourierPerformanceTable rows={depth.performance} />
      {depth.returns && depth.returns.returned ? <ReturnsCard returns={depth.returns} cities={depth.returnCities} /> : null}
      {table("courier", couriers)}
      <CityDeliveryTable
        rows={rows(view.cities, "city")}
        matrix={view.matrix}
        cityCount={view.cityCount}
        min={view.minDecided}
        courier={scope.courier}
        picked={(key) => picked("city", key)}
        link={link}
      />
      {depth.channels ? <ChannelCourierTable matrix={depth.channels} min={view.minDecided} /> : null}
    </section>
  );
}

// ── Customers ───────────────────────────────────────────────────────────────

export function CustomersPanel({ view, canSeeMoney = false }: { view: CustomersView; canSeeMoney?: boolean }) {
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Buyers, all time" note="Counted once each, however they write their number">
          <span className="font-semibold tabular-nums">{view.customers.toLocaleString()}</span>
        </Stat>
        <Stat label="Buyers this period" change={<Change h={view.compare.buyers} />} trend={<Sparkline trend={view.compare.buyers.trend} />}>
          <span className="font-semibold tabular-nums">{view.buyersInPeriod.toLocaleString()}</span>
        </Stat>
        <Stat label="Repeat buyers" note="Of this period's buyers, those with two or more orders ever" change={<Change h={view.compare.repeatShare} kind="rate" />}>
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
      <div className="overflow-x-auto rounded-2xl bg-white">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="px-5 py-3">Buyer</th>
              <th className="px-5 py-3 text-right">Orders</th>
              <th className="px-5 py-3">Delivery</th>
              <th className="px-5 py-3 text-right">Delivered revenue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {view.top.map((c) => (
              <tr key={c.customerId}>
                <td className="px-5 py-3 font-medium text-gray-900">{c.name ?? (c.phoneTail ? `Buyer ···${c.phoneTail}` : "Buyer")}</td>
                <td className="px-5 py-3 text-right tabular-nums">{c.orders}</td>
                <td className="px-5 py-3 text-gray-700">
                  {/* Counts, not a rate: two orders make a noisy percentage. */}
                  {c.deliveryRate.delivered} delivered · {c.deliveryRate.returned} returned
                  {c.deliveryRate.stillOpen ? ` · ${c.deliveryRate.stillOpen} in transit` : ""}
                </td>
                <td className="px-5 py-3 text-right"><MoneyList values={c.deliveredRevenue} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">Top buyers this period, by delivered orders.</p>
      </div>
      <CohortGrid data={view.retention} minBuyers={MIN_COHORT_BUYERS} canSeeMoney={canSeeMoney} />
      <RepeatCurve data={view.retention} minBuyers={MIN_ELIGIBLE_BUYERS} />
    </section>
  );
}

// ── Marketing ───────────────────────────────────────────────────────────────

export function MarketingPanel({ view, days, scope }: { view: MarketingView; days: number; scope: string }) {
  return (
    <section className="space-y-4">
      {view.outcomes ? (
        <CampaignOutcomesTable data={view.outcomes} spend={view.campaigns} />
      ) : view.campaigns ? (
        <CampaignTable data={view.campaigns} compared={view.campaignsCompared} />
      ) : null}
      <ProductMatrix catalog={view.catalog} products={view.products} storeReturnRate={view.storeReturnRate} withAds={view.withAds} days={days} scope={scope} />
    </section>
  );
}
