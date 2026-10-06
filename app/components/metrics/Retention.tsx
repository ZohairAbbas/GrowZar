import type { Retention } from "~/lib/metrics/cohorts";

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

export function CohortGrid({ data, minBuyers }: { data: Retention; minBuyers: number }) {
  const shares = data.cohorts.flatMap((c) => c.cells.map((x) => x.share ?? 0));
  const top = Math.max(1, ...shares);
  const step = (share: number) => STEPS[Math.min(STEPS.length - 1, Math.floor((share / top) * STEPS.length))]!;
  const columns = Array.from({ length: data.maxOffset }, (_, i) => i + 1);

  return (
    <div className="overflow-x-auto rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Who came back</h2>
      <p className="mt-1 text-sm text-gray-600">
        Buyers grouped by the month of their first delivered order; each cell is the share who had another delivered
        order that many months later.
        {data.historyFrom ? ` First order means first since ${dayLabel(data.historyFrom)}, when this store's history starts.` : ""}
      </p>
      {data.cohorts.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No delivered orders with a buyer yet.</p>
      ) : (
        <table className="mt-4 min-w-full border-separate border-spacing-[2px] text-sm">
          <thead className="text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">First order</th>
              <th className="py-2 pr-4 text-right">Buyers</th>
              {columns.map((m) => (
                <th key={m} className="px-2 py-2 text-center">
                  +{m} {m === 1 ? "month" : "months"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.cohorts.map((c) => (
              <tr key={c.month}>
                <td className="whitespace-nowrap py-2 pr-4 font-medium text-gray-900">
                  {monthLabel(c.month)}
                  {c.partialFirstMonth ? <span className="ml-1 text-xs font-normal text-gray-500">(from {dayLabel(data.historyFrom!).replace(/ \d{4}$/, "")})</span> : null}
                </td>
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
      )}
      <p className="mt-3 text-xs text-gray-500">
        Delivered orders only. A cohort under {minBuyers} buyers shows its count without a share. A dashed cell is the
        current month, still filling.
      </p>
    </div>
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
