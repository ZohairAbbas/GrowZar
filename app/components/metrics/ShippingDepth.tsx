import { useState } from "react";

import type { ShippingDepth } from "~/lib/metrics/screens.server";
import { MIN_ATTEMPT_REPORTING } from "~/lib/metrics/returns";
import { STUCK_DAYS } from "~/lib/metrics/cash";
import { formatAmount } from "./Metrics";
import { scopeLabel } from "./FilterBar";

/**
 * Shipping depth (Phase 4c, A5–A8). Outcome colours are the same as the
 * order list's dots: delivered mint, returned coral, still open cyan, the
 * rest grey. Every bar's numbers are in its hover text and in the tables.
 */

const whole = (amount: string) => formatAmount(amount).replace(/\.\d+$/, "");
const SEG = [
  { key: "delivered", label: "Delivered", fill: "#0A7F6B" },
  { key: "returned", label: "Returned", fill: "#FF8A6B" },
  { key: "open", label: "Still open", fill: "#5AD7FF" },
  { key: "other", label: "Cancelled or not known", fill: "#C3D3D1" },
] as const;

export function OutcomesChart({ days }: { days: ShippingDepth["outcomes"] }) {
  const w = 720;
  const h = 180;
  const pad = { l: 36, r: 8, t: 8, b: 26 };
  const bw = (w - pad.l - pad.r) / Math.max(1, days.length);
  const weekly = days.length && days[0]!.from !== days[0]!.to;
  const label = (d: (typeof days)[number]) => {
    const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.to.slice(5, 7)) - 1];
    return `${Number(d.to.slice(8, 10))} ${m}`;
  };
  const every = Math.ceil(days.length / 8);
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">What happened to each {weekly ? "week's" : "day's"} orders</h2>
      <p className="mt-1 text-sm text-gray-600">
        Orders by the {weekly ? "week" : "day"} they were placed, split by outcome. Recent {weekly ? "weeks" : "days"} are mostly still
        open, not failing.
      </p>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-auto w-full" role="img" aria-label="Share of orders delivered, returned and still open, by order date">
        {[0, 50, 100].map((t) => {
          const y = pad.t + ((100 - t) / 100) * (h - pad.t - pad.b);
          return (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke="#E7EFEE" />
              <text x={pad.l - 6} y={y + 3} textAnchor="end" className="fill-gray-500 text-[10px]">
                {t}%
              </text>
            </g>
          );
        })}
        {days.map((d, i) => {
          const total = d.delivered + d.returned + d.open + d.other;
          let y = h - pad.b;
          const x = pad.l + i * bw + 1;
          return (
            <g key={d.label}>
              <title>{`${d.label}: ${total} orders · ${d.delivered} delivered · ${d.returned} returned · ${d.open} still open · ${d.other} cancelled or not known`}</title>
              {total
                ? SEG.map((sg) => {
                    const n = d[sg.key];
                    const hh = (n / total) * (h - pad.t - pad.b);
                    y -= hh;
                    return n ? <rect key={sg.key} x={x} y={y} width={Math.max(1, bw - 2)} height={Math.max(0, hh - (hh > 2 ? 1 : 0))} fill={sg.fill} rx="1" /> : null;
                  })
                : null}
              {i % every === 0 || (i === days.length - 1 && i % every >= every / 2) ? (
                <text x={x + bw / 2} y={h - 8} textAnchor="middle" className="fill-gray-500 text-[10px]">
                  {label(d)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
        {SEG.map((sg) => (
          <li key={sg.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: sg.fill }} aria-hidden="true" />
            {sg.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CourierPerformanceTable({ rows }: { rows: ShippingDepth["performance"] }) {
  if (!rows.length) return null;
  const val = (v: number | null, suffix = "") => (v === null ? "" : `${v.toFixed(1)}${suffix}`);
  return (
    <div className="overflow-x-auto rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">How each courier performs</h2>
      <p className="mt-1 text-sm text-gray-600">Parcels booked through Courierify, by the courier that carried them.</p>
      <table className="mt-4 min-w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
          <tr>
            <th className="py-2 pr-4">Courier</th>
            <th className="py-2 pr-4 text-right">Orders</th>
            <th className="py-2 pr-4 text-right">Delivery rate</th>
            <th className="py-2 pr-4 text-right">Days to deliver</th>
            <th className="py-2 pr-4 text-right">Slowest 10% over</th>
            <th className="py-2 pr-4 text-right">First attempt</th>
            <th className="py-2 pr-4 text-right">Returns after a failed attempt</th>
            <th className="py-2 text-right">Stuck now</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.courier}>
              <td className="py-2 pr-4 font-medium text-gray-900">{scopeLabel(r.courier)}</td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {r.orders.toLocaleString()}
                <span className="block text-xs text-gray-500">{r.decided.toLocaleString()} decided</span>
              </td>
              <td className="py-2 pr-4 text-right font-semibold tabular-nums">{val(r.deliveryRate, "%")}</td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {val(r.medianDays)}
                {r.medianDays !== null ? <span className="block text-xs text-gray-500">median, {r.timed} timed</span> : null}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{r.p90Days === null ? "" : `${r.p90Days.toFixed(1)} days`}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{val(r.firstAttempt, "%")}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{val(r.returnedAfterAttempt, "%")}</td>
              <td className={`py-2 text-right tabular-nums ${r.stuck ? "font-semibold text-coral-700" : "text-gray-500"}`}>{r.stuck || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-gray-500">
        Rates need 20 decided orders; days only count deliveries the courier timed. First attempt is shown for couriers
        that report failed attempts on at least {Math.round(MIN_ATTEMPT_REPORTING * 100)}% of parcels. Stuck: booked{" "}
        {STUCK_DAYS.booked}+ days or in transit {STUCK_DAYS.in_transit}+ days with no status change.
      </p>
    </div>
  );
}

type Bar = { key: string; label: string; hint?: string; value: number; note: string };

/** One list of bars, a label, its count and what the count is out of. */
function Bars({ rows, footnote }: { rows: Bar[]; footnote: string }) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <>
      <ul className="mt-3 max-w-3xl space-y-2">
        {rows.slice(0, 8).map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_4rem_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,14rem)_1fr_11rem] sm:gap-4">
            <span className="truncate text-gray-800" title={r.hint}>
              {r.label}
            </span>
            <span className="h-2.5 rounded-sm bg-field">
              <span className="block h-2.5 rounded-sm bg-coral" style={{ width: `${(100 * r.value) / top}%` }} />
            </span>
            <span className="text-right tabular-nums">
              <span className="font-semibold text-gray-900">{r.value.toLocaleString()}</span>{" "}
              {r.note ? <span className="text-gray-500">· {r.note}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-500">{footnote}</p>
    </>
  );
}

const share = (n: number, total: number) => (total ? `${((100 * n) / total).toFixed(0)}%` : "");

/** Why parcels came back, why attempts failed, and where: one at a time. */
function WhyReturns({ returns: r, cities, withReason }: { returns: NonNullable<ShippingDepth["returns"]>; cities: ShippingDepth["returnCities"]; withReason: number }) {
  const attempts = r.attemptReasons.reduce((n, x) => n + x.orders, 0);
  const tabs = [
    {
      key: "returned",
      label: "Why they came back",
      rows: r.returnReasons.map((x) => ({ key: x.reason, label: x.reason, hint: x.couriers.map(scopeLabel).join(", "), value: x.orders, note: share(x.orders, withReason) })),
      footnote: `In the courier's words, on ${withReason.toLocaleString()} returned orders that gave a reason.`,
    },
    {
      key: "attempts",
      label: "Why deliveries failed",
      rows: r.attemptReasons.map((x) => ({ key: x.reason, label: x.reason, hint: x.couriers.map(scopeLabel).join(", "), value: x.orders, note: share(x.orders, attempts) })),
      footnote: "Reasons couriers gave for failed delivery attempts, whether the order was delivered in the end or not.",
    },
    {
      key: "cities",
      label: "Cities with the most returns",
      rows: cities.map((x) => ({ key: x.city, label: scopeLabel(x.city), value: x.returned, note: `${x.rate.toFixed(1)}% of ${x.decided} decided` })),
      footnote: "Returned orders per city, and the share of the city's decided orders that came back.",
    },
  ].filter((t) => t.rows.length);
  const [tab, setTab] = useState(tabs[0]?.key);
  const shown = tabs.find((t) => t.key === tab) ?? tabs[0];
  if (!shown) return null;
  return (
    <div className="mt-6 border-t border-gray-100 pt-5">
      {tabs.length === 1 ? (
        <h3 className="text-sm font-semibold text-gray-900">{shown.label}</h3>
      ) : (
        <nav aria-label="Returns by" className="inline-flex rounded-full bg-field p-1 text-sm font-semibold">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={shown.key === t.key}
              className={`rounded-full px-3 py-1 ${shown.key === t.key ? "bg-navy text-white" : "text-gray-600 hover:text-gray-900"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
      <Bars rows={shown.rows} footnote={shown.footnote} />
    </div>
  );
}

export function ReturnsCard({ returns, cities }: { returns: NonNullable<ShippingDepth["returns"]>; cities: ShippingDepth["returnCities"] }) {
  const r = returns;
  const c = r.currency;
  const withReason = r.byCourier.reduce((n, x) => n + x.withReason, 0);
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">What returns cost</h2>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-semibold text-gray-600">Returned orders</dt>
          <dd className="mt-0.5 font-display text-2xl font-bold tabular-nums">{r.returned.toLocaleString()}</dd>
          <dd className="text-xs text-gray-500">{whole(r.value.amount)} {c} of orders that earned nothing</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-gray-600">Courier fees on returns</dt>
          <dd className="mt-0.5 font-display text-2xl font-bold tabular-nums">
            {whole(r.fees.amount)} <span className="text-sm font-semibold text-gray-500">{c}</span>
          </dd>
          <dd className="text-xs text-gray-500">recorded on {r.withFee.toLocaleString()} of {r.returned.toLocaleString()} returns</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-gray-600">Product sent out and returned</dt>
          <dd className="mt-0.5 font-display text-2xl font-bold tabular-nums">
            {whole(r.productCost.amount)} <span className="text-sm font-semibold text-gray-500">{c}</span>
          </dd>
          <dd className="text-xs text-gray-500">at cost, until it is back on the shelf</dd>
        </div>
        <div className={r.notReceived.orders ? "rounded-xl bg-coral-50 p-3 -m-3" : undefined}>
          <dt className="text-xs font-semibold text-coral-700">Returned, not confirmed back</dt>
          <dd className="mt-0.5 font-display text-2xl font-bold tabular-nums text-coral-700">{r.notReceived.orders.toLocaleString()}</dd>
          <dd className="text-xs text-coral-700">
            {whole(r.notReceived.productCost.amount)} {c} of product
            {r.notReceived.olderThan14Days ? `, ${r.notReceived.olderThan14Days} returned over 14 days ago` : ""}
          </dd>
        </div>
      </dl>

      <div className="mt-5 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Courier</th>
              <th className="py-2 pr-4 text-right">Returned</th>
              <th className="py-2 pr-4 text-right">Order value</th>
              <th className="py-2 pr-4 text-right">Fees recorded</th>
              <th className="py-2 pr-4 text-right">Confirmed back</th>
              <th className="py-2 pr-4 text-right">Not confirmed back</th>
              <th className="py-2 text-right">Reason given</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {r.byCourier.map((x) => (
              <tr key={x.courier}>
                <td className="py-2 pr-4 font-medium text-gray-900">
                  {scopeLabel(x.courier)}
                  {x.courier.startsWith("financify:") ? <span className="ml-1 text-xs font-normal text-gray-400">(Financify)</span> : null}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{x.returned}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{whole(x.value.amount)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{x.withFee ? `${whole(x.fees.amount)} on ${x.withFee}` : ""}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{x.received || ""}</td>
                <td className={`py-2 pr-4 text-right tabular-nums ${x.notReceived ? "font-semibold text-coral-700" : ""}`}>{x.notReceived || ""}</td>
                <td className="py-2 text-right tabular-nums">{x.withReason ? `${x.withReason} of ${x.returned}` : "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-gray-500">
          Confirmed back is the merchant&apos;s own mark in Courierify that the returned goods arrived. Only Courierify-booked
          returns can be confirmed.
        </p>
      </div>

      <WhyReturns returns={r} cities={cities} withReason={withReason} />
    </div>
  );
}
