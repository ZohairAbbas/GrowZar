import { useState } from "react";

import { MIN_COSTED_REVENUE_SHARE, type Retention } from "~/lib/metrics/cohorts";

/**
 * D3's two views of repeat behaviour: the cohort grid (rows are the month of
 * a buyer's first delivered order, columns the months since) and the repeat
 * curve (how soon a second delivered order follows the first).
 *
 * The grid is a single-hue sequential scale, light to dark. Every cell states
 * its buyer count; a thin cohort's cells are left blank rather than given a
 * share of a handful of buyers.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** Five steps of one hue; the darkest carries white text. */
const STEPS = [
  "bg-mint-50 text-gray-900",
  "bg-mint-100 text-gray-900",
  "bg-mint-200 text-gray-900",
  "bg-mint text-gray-900",
  "bg-mint-600 text-white",
];

type CohortView = "share" | "revenue" | "profit";

/** 12,345 · 845k · 1.23M: short enough for a grid cell; the full figure is in the hover text. */
function compact(amount: string): string {
  const n = Number(amount);
  const a = Math.abs(n);
  const text = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${Math.round(a / 1e3)}k` : Math.round(a).toLocaleString();
  return `${n < 0 && Math.round(a) !== 0 ? "−" : ""}${text}`;
}
const full = (amount: string) => Math.round(Number(amount)).toLocaleString();

export function CohortGrid({
  data,
  minBuyers,
  canSeeMoney = false,
  initialView = "share",
}: {
  data: Retention;
  minBuyers: number;
  canSeeMoney?: boolean;
  initialView?: CohortView;
}) {
  const hasMoney = data.currency !== null && data.cohorts.some((c) => c.money);
  const views: Array<[CohortView, string]> = [
    ["share", "Came back"],
    ...(hasMoney ? ([["revenue", "Revenue"]] as Array<[CohortView, string]>) : []),
    ...(hasMoney && canSeeMoney ? ([["profit", "Gross profit"]] as Array<[CohortView, string]>) : []),
  ];
  const [view, setView] = useState<CohortView>(initialView);
  const shares = data.cohorts.flatMap((c) => c.cells.map((x) => x.share ?? 0));
  const top = Math.max(1, ...shares);
  const step = (share: number) => STEPS[Math.min(STEPS.length - 1, Math.floor((share / top) * STEPS.length))]!;
  const columns = Array.from({ length: data.maxOffset }, (_, i) => i + 1);
  const months = (m: number) => `+${m} ${m === 1 ? "month" : "months"}`;

  return (
    <div className="overflow-x-auto rounded-2xl bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-bold text-gray-900">Who came back</h2>
        {views.length > 1 ? (
          <nav aria-label="Show" className="inline-flex rounded-full bg-field p-1 text-sm font-semibold">
            {views.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                aria-pressed={view === key}
                className={`rounded-full px-3 py-1 ${view === key ? "bg-navy text-white" : "text-gray-600 hover:text-gray-900"}`}
              >
                {label}
              </button>
            ))}
          </nav>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-gray-600">
        {view === "share"
          ? "Buyers grouped by the month of their first delivered order; each cell is the share who had another delivered order that many months later."
          : view === "revenue"
            ? `Buyers grouped by the month of their first delivered order; each cell is what they paid for delivered orders that month, in ${data.currency}. The first month includes the first order.`
            : `Buyers grouped by the month of their first delivered order; each cell is delivered revenue less product cost that month, in ${data.currency}. Courier fees and ads are not taken off.`}
        {data.historyFrom ? ` First order means first since ${dayLabel(data.historyFrom)}, when this store's history starts.` : ""}
      </p>
      {data.cohorts.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No delivered orders with a buyer yet.</p>
      ) : view === "share" ? (
        <table className="mt-4 min-w-full border-separate border-spacing-[2px] text-sm">
          <thead className="text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">First order</th>
              <th className="py-2 pr-4 text-right">Buyers</th>
              {columns.map((m) => (
                <th key={m} className="px-2 py-2 text-center">
                  {months(m)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.cohorts.map((c) => (
              <tr key={c.month}>
                <CohortName month={c.month} partial={c.partialFirstMonth} historyFrom={data.historyFrom} />
                <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{c.buyers.toLocaleString()}</td>
                {columns.map((m) => {
                  const cell = c.cells.find((x) => x.offset === m);
                  if (!cell) return <td key={m} />;
                  const title = `${monthLabel(c.month)} buyers, ${m} month${m === 1 ? "" : "s"} later: ${cell.buyers} of ${c.buyers} came back${cell.partial ? " (month still running)" : ""}`;
                  if (cell.share === null) {
                    return (
                      <td key={m} title={title} className="rounded-md bg-field px-2 py-2 text-center text-xs text-gray-500">
                        {cell.buyers}
                      </td>
                    );
                  }
                  return (
                    <td
                      key={m}
                      title={title}
                      className={`rounded-md px-2 py-2 text-center ${step(cell.share)} ${cell.partial ? "outline-dashed outline-1 -outline-offset-2 outline-gray-500" : ""}`}
                    >
                      <span className="block font-semibold tabular-nums">{cell.share.toFixed(1)}%</span>
                      <span className="block text-[11px] tabular-nums opacity-80">{cell.buyers.toLocaleString()} {cell.buyers === 1 ? "buyer" : "buyers"}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <MoneyGrid data={data} view={view} months={months} />
      )}
      <p className="mt-3 text-xs text-gray-500">
        {view === "share"
          ? `Delivered orders only. A cohort under ${minBuyers} buyers shows its count without a share. A dashed cell is the current month, still filling.`
          : view === "revenue"
            ? "Delivered orders only. A dashed cell is the current month, still filling."
            : `Delivered orders with a product cost. A cell where under ${Math.round(100 * MIN_COSTED_REVENUE_SHARE)}% of revenue has a cost says so instead of showing a profit. A dashed cell is the current month, still filling.${
                data.costedRevenueShare !== null && data.costedRevenueShare < 100 * MIN_COSTED_REVENUE_SHARE
                  ? ` Only ${data.costedRevenueShare.toFixed(1)}% of this store's delivered revenue has a product cost; costs are entered in Financify.`
                  : ""
              }`}
        {view !== "share" && data.otherCurrencyOrders
          ? ` ${data.otherCurrencyOrders.toLocaleString()} delivered orders in another currency are left out.`
          : ""}
      </p>
    </div>
  );
}

function CohortName({ month, partial, historyFrom }: { month: string; partial: boolean; historyFrom: string | null }) {
  return (
    <td className="whitespace-nowrap py-2 pr-4 font-medium text-gray-900">
      {monthLabel(month)}
      {partial && historyFrom ? <span className="ml-1 text-xs font-normal text-gray-500">(from {dayLabel(historyFrom).replace(/ \d{4}$/, "")})</span> : null}
    </td>
  );
}

/** Revenue or gross profit per cohort and month, the first month included, then the cohort's total and per buyer. */
function MoneyGrid({ data, view, months }: { data: Retention; view: "revenue" | "profit"; months: (m: number) => string }) {
  const columns = Array.from({ length: data.maxOffset + 1 }, (_, i) => i);
  const valueOf = (x: { revenue: string; profit: string | null }) => (view === "revenue" ? x.revenue : x.profit);
  const top = Math.max(1, ...data.cohorts.flatMap((c) => (c.money?.cells ?? []).map((x) => Number(valueOf(x) ?? 0))));
  const step = (v: number) => STEPS[Math.min(STEPS.length - 1, Math.floor((v / top) * STEPS.length))]!;
  return (
    <table className="mt-4 min-w-full border-separate border-spacing-[2px] text-sm">
      <thead className="text-left text-xs font-semibold text-gray-500">
        <tr>
          <th className="py-2 pr-4">First order</th>
          <th className="py-2 pr-4 text-right">Buyers</th>
          {columns.map((m) => (
            <th key={m} className="px-2 py-2 text-center">
              {m === 0 ? "First month" : months(m)}
            </th>
          ))}
          <th className="px-2 py-2 text-right">Total</th>
          {view === "revenue" ? <th className="px-2 py-2 text-right">Per buyer</th> : null}
        </tr>
      </thead>
      <tbody>
        {data.cohorts.map((c) => (
          <tr key={c.month}>
            <CohortName month={c.month} partial={c.partialFirstMonth} historyFrom={data.historyFrom} />
            <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{c.buyers.toLocaleString()}</td>
            {columns.map((m) => {
              const cell = c.money?.cells.find((x) => x.offset === m);
              if (!cell) return <td key={m} />;
              const v = valueOf(cell);
              const dashed = cell.partial ? "outline-dashed outline-1 -outline-offset-2 outline-gray-500" : "";
              if (v === null) {
                return (
                  <td key={m} title={`${monthLabel(c.month)} buyers, ${m === 0 ? "first month" : months(m)}: revenue ${full(cell.revenue)}, too little of it has a product cost`} className={`rounded-md bg-field px-2 py-2 text-center text-xs text-gray-500 ${dashed}`}>
                    costs missing
                  </td>
                );
              }
              const n = Number(v);
              return (
                <td
                  key={m}
                  title={`${monthLabel(c.month)} buyers, ${m === 0 ? "first month" : months(m)}: ${full(v)} ${data.currency}`}
                  className={`rounded-md px-2 py-2 text-center font-semibold tabular-nums ${n < 0 ? "bg-coral-100 text-coral-700" : n === 0 ? "bg-field text-gray-500" : step(n)} ${dashed}`}
                >
                  {compact(v)}
                </td>
              );
            })}
            <td className="px-2 py-2 text-right font-semibold tabular-nums text-gray-900">
              {c.money ? (valueOf(c.money) === null ? <span className="text-xs font-normal text-gray-500">costs missing</span> : full(valueOf(c.money)!)) : ""}
            </td>
            {view === "revenue" ? <td className="px-2 py-2 text-right tabular-nums text-gray-700">{c.money ? full(c.money.perBuyer) : ""}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RepeatCurve({ data, minBuyers }: { data: Retention; minBuyers: number }) {
  const drawn = data.repeat.filter((p) => p.share !== null);
  const w = 560;
  const h = 180;
  const pad = { l: 40, r: 16, t: 16, b: 28 };
  const maxDays = data.repeat.at(-1)!.days;
  const top = Math.max(5, Math.ceil(Math.max(0, ...drawn.map((p) => p.share!)) / 5) * 5);
  const x = (d: number) => pad.l + (d / maxDays) * (w - pad.l - pad.r);
  const y = (s: number) => pad.t + (1 - s / top) * (h - pad.t - pad.b);
  const ticks = [0, top / 2, top];

  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">How soon buyers order again</h2>
      <p className="mt-1 text-sm text-gray-600">
        Share of buyers with a second delivered order, on a later day, within each number of days of their first.
        {data.medianDaysToSecond !== null
          ? ` Of the ${data.secondOrders.toLocaleString()} who came back, half did so within ${data.medianDaysToSecond} days.`
          : ""}
      </p>
      {drawn.length >= 2 ? (
        <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-auto w-full max-w-2xl" role="img" aria-label="Repeat purchase curve; the table below has the values">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="stroke-gray-100" strokeWidth="1" />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="fill-gray-500 text-[10px]">
                {t}%
              </text>
            </g>
          ))}
          {data.repeat.map((p) => (
            <text key={p.days} x={x(p.days)} y={h - 8} textAnchor="middle" className="fill-gray-500 text-[10px]">
              {p.days}d
            </text>
          ))}
          <polyline
            points={drawn.map((p) => `${x(p.days)},${y(p.share!)}`).join(" ")}
            fill="none"
            className="stroke-data-700"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          {drawn.map((p) => (
            <g key={p.days}>
              <circle cx={x(p.days)} cy={y(p.share!)} r="4" className="fill-data-700 stroke-white" strokeWidth="2" />
              {/* A wider invisible target than the mark, for hover. */}
              <circle cx={x(p.days)} cy={y(p.share!)} r="12" fill="transparent">
                <title>{`Within ${p.days} days: ${p.share}% (${p.repeated} of ${p.eligible} buyers)`}</title>
              </circle>
            </g>
          ))}
          {drawn.length ? (
            <text x={x(drawn.at(-1)!.days)} y={y(drawn.at(-1)!.share!) - 10} textAnchor="end" className="fill-gray-900 text-[11px] font-semibold">
              {drawn.at(-1)!.share}% within {drawn.at(-1)!.days} days
            </text>
          ) : null}
        </svg>
      ) : null}
      <table className="mt-3 min-w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
          <tr>
            <th className="py-2 pr-4">Within</th>
            <th className="py-2 pr-4 text-right">Buyers old enough</th>
            <th className="py-2 pr-4 text-right">Ordered again</th>
            <th className="py-2 text-right">Share</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.repeat.map((p) => (
            <tr key={p.days}>
              <td className="py-2 pr-4 text-gray-900">{p.days} days</td>
              <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{p.eligible.toLocaleString()}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{p.repeated.toLocaleString()}</td>
              <td className="py-2 text-right font-semibold tabular-nums text-gray-900">{p.share === null ? "" : `${p.share.toFixed(1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-gray-500">
        A buyer counts toward a window once their first order is that old. Windows under {minBuyers} such buyers are left
        blank.
      </p>
    </div>
  );
}
