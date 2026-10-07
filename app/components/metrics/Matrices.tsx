import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";

import type { CampaignOutcomes, CampaignSpend } from "~/lib/metrics/campaigns";
import { MIN_COSTED_LINE_SHARE, type ChannelCourierMatrix, type CityCourierMatrix, type ConfirmationFunnel, type MatrixCell, type PayoutAgeing, type ProductPoint } from "~/lib/metrics/matrices";
import { MIN_DECIDED_TO_RATE } from "~/lib/metrics/compare";
import type { DeliveryRate } from "~/lib/metrics/rollups";
import { Change, DeliveryRateText, formatAmount } from "./Metrics";
import { scopeLabel } from "./FilterBar";

/**
 * D4's matrices and funnel. Every cell or point states its sample; a cell
 * below the minimum keeps its counts and has no rate.
 */

// ── Product matrix ─────────────────────────────────────────────────────────

/**
 * Return rate against the store's own, as a diverging scale: mint returns
 * less, coral more, grey about the same. Text never wears these colours.
 */
const RETURN_CLASSES = [
  { max: -10, fill: "#0A7F6B", stroke: "#ffffff", label: "10+ pts fewer returns" },
  { max: -3, fill: "#9DF0DE", stroke: "#4F6A6E", label: "3–10 pts fewer" },
  { max: 3, fill: "#C3D3D1", stroke: "#4F6A6E", label: "About the store's rate" },
  { max: 10, fill: "#FFD3C5", stroke: "#4F6A6E", label: "3–10 pts more" },
  { max: Infinity, fill: "#C24A2C", stroke: "#ffffff", label: "10+ pts more returns" },
];
const classOf = (gap: number) => RETURN_CLASSES.find((c) => gap < c.max) ?? RETURN_CLASSES.at(-1)!;

const name = (p: ProductPoint) => p.title ?? `Variant ${p.variantId}`;
const looksProfitableIsNot = (p: ProductPoint) =>
  p.marginPct !== null && p.marginPct < 0 && p.marginIfAllDeliveredPct !== null && p.marginIfAllDeliveredPct > 0;

export function ProductMatrix({
  products,
  storeReturnRate,
  withAds,
  period,
  scope,
  catalog = {},
}: {
  /** Titles and images by variant (Financify's catalogue); display only. */
  catalog?: Record<string, { title: string | null; imageUrl: string | null }>;
  products: ProductPoint[];
  storeReturnRate: number | null;
  withAds: boolean;
  period: string;
  scope: string;
}) {
  const plotted = products.filter((p) => p.plotted);
  const base = storeReturnRate ?? 0;
  const w = 720;
  const h = 340;
  const pad = { l: 48, r: 20, t: 20, b: 40 };
  const maxX = Math.max(10, ...plotted.map((p) => p.delivered));
  const ys = plotted.map((p) => p.marginPct!);
  const lo = Math.min(-10, Math.floor(Math.min(0, ...ys) / 10) * 10);
  const hi = Math.max(10, Math.ceil(Math.max(0, ...ys) / 10) * 10);
  // Volumes span orders of magnitude, so the x axis is logarithmic.
  const x = (n: number) => pad.l + (Math.log10(Math.max(1, n)) / Math.log10(maxX)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * (h - pad.t - pad.b);
  const xTicks = [1, 10, 100, 1000, 10000].filter((t) => t <= maxX * 1.05);
  const tick = hi - lo > 80 ? 20 : 10;
  const yTicks = Array.from({ length: Math.floor((hi - lo) / tick) + 1 }, (_, i) => Math.ceil(lo / tick) * tick + i * tick).filter((t) => t <= hi);
  const flagged = plotted.filter(looksProfitableIsNot);
  // Direct labels for the flagged few. Each is a box (about 5.5px a
  // character at 10px); a box that would overlap one already placed steps
  // down until it is clear.
  const labels: Array<{ p: ProductPoint; x: number; y: number; left: boolean }> = [];
  const boxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  for (const p of flagged.slice(0, 4)) {
    const px = x(p.delivered);
    const left = px > w - 180;
    const width = Math.min(28, name(p).length) * 5.5;
    const x0 = left ? px - 10 - width : px + 10;
    let ly = y(p.marginPct!);
    const hits = (yy: number) => boxes.some((b) => x0 < b.x1 && x0 + width > b.x0 && yy - 9 < b.y1 && yy + 4 > b.y0);
    for (let i = 0; i < 6 && hits(ly); i++) ly += 14;
    boxes.push({ x0, x1: x0 + width, y0: ly - 9, y1: ly + 4 });
    labels.push({ p, x: px, y: ly, left });
  }
  const link = (p: ProductPoint) => `/orders?${period}&variant=${p.variantId}${scope ? `&${scope}` : ""}`;

  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Products: margin against delivered volume</h2>
      <p className="mt-1 text-sm text-gray-600">
        Each dot is a product. Up is margin on the orders that reached an outcome — delivered line value less product cost
        {withAds ? " and its share of ad spend" : ""} — across is delivered orders, colour is return rate against the
        store&apos;s {storeReturnRate !== null ? `${storeReturnRate.toFixed(1)}%` : ""}.
        {flagged.length
          ? ` ${flagged.length} ${flagged.length === 1 ? "product would be" : "products would be"} profitable if every order were delivered, and ${flagged.length === 1 ? "is" : "are"} not.`
          : ""}
      </p>
      {plotted.length ? (
        <svg viewBox={`0 0 ${w} ${h}`} className="mt-4 h-auto w-full" role="img" aria-label="Product matrix; the table below lists every product">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? "#8AA3A2" : "#E7EFEE"} strokeWidth={t === 0 ? 1.5 : 1} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="fill-gray-500 text-[10px]">
                {t}%
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={h - pad.b + 16} textAnchor="middle" className="fill-gray-500 text-[10px]">
              {t.toLocaleString()}
            </text>
          ))}
          <text x={(pad.l + w - pad.r) / 2} y={h - 6} textAnchor="middle" className="fill-gray-500 text-[11px]">
            Delivered orders (log scale)
          </text>
          {plotted.map((p) => {
            const c = classOf(p.returnRate - base);
            return (
              <Link key={p.variantId} to={link(p)}>
                <circle cx={x(p.delivered)} cy={y(p.marginPct!)} r="6" fill={c.fill} stroke={c.stroke} strokeWidth="2" />
                <circle cx={x(p.delivered)} cy={y(p.marginPct!)} r="12" fill="transparent">
                  <title>{`${name(p)}: ${p.marginPct}% margin on ${p.decided} decided orders (${p.marginIfAllDeliveredPct ?? "—"}% if all delivered), ${p.delivered} delivered, ${p.returnRate}% returned`}</title>
                </circle>
              </Link>
            );
          })}
          {labels.map(({ p, x: lx, y: ly, left }) => {
            return (
              <text key={`l-${p.variantId}`} x={left ? lx - 10 : lx + 10} y={ly + 4} textAnchor={left ? "end" : "start"} className="fill-gray-900 text-[10px] font-semibold">
                {name(p).slice(0, 28)}
              </text>
            );
          })}
        </svg>
      ) : (
        <p className="mt-4 text-sm text-gray-500">No product has {MIN_DECIDED_TO_RATE} decided orders with costs in this period yet.</p>
      )}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600" aria-label="Return rate against the store's">
        {RETURN_CLASSES.map((c) => (
          <li key={c.label} className="inline-flex items-center gap-1.5">
            <svg width="12" height="12" aria-hidden="true">
              <circle cx="6" cy="6" r="5" fill={c.fill} stroke={c.stroke === "#ffffff" ? c.fill : c.stroke} strokeWidth="1" />
            </svg>
            {c.label}
          </li>
        ))}
      </ul>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Product</th>
              <th className="py-2 pr-4 text-right">Delivered</th>
              <th className="py-2 pr-4 text-right">Decided</th>
              <th className="py-2 pr-4 text-right">Returned</th>
              <th className="py-2 pr-4 text-right">If all delivered</th>
              <th className="py-2 pr-4 text-right">Margin</th>
              <th className="py-2"><span className="sr-only">Orders</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {products.slice(0, 25).map((p) => (
              <tr key={p.variantId} className={looksProfitableIsNot(p) && p.plotted ? "bg-coral-50" : undefined}>
                <td className="max-w-xs py-2 pr-4">
                  <span className="flex items-center gap-2.5">
                    {catalog[p.variantId]?.imageUrl ? (
                      <img
                        src={`${catalog[p.variantId]!.imageUrl}${catalog[p.variantId]!.imageUrl!.includes("?") ? "&" : "?"}width=64`}
                        alt=""
                        width={32}
                        height={32}
                        loading="lazy"
                        className="h-8 w-8 flex-shrink-0 rounded-md bg-field object-cover"
                      />
                    ) : (
                      <span className="h-8 w-8 flex-shrink-0 rounded-md bg-field" aria-hidden="true" />
                    )}
                    <span className="truncate font-medium text-gray-900" title={catalog[p.variantId]?.title ?? name(p)}>
                      {catalog[p.variantId]?.title ?? name(p)}
                    </span>
                  </span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{p.delivered.toLocaleString()}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-500">{p.decided.toLocaleString()}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{p.decided >= MIN_DECIDED_TO_RATE ? `${p.returnRate.toFixed(1)}%` : ""}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-600">
                  {p.plotted && p.marginIfAllDeliveredPct !== null ? `${p.marginIfAllDeliveredPct.toFixed(1)}%` : ""}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums font-semibold text-gray-900">
                  {p.plotted ? (
                    <>
                      {p.marginPct!.toFixed(1)}% <span className="font-normal text-gray-500">({formatAmount(p.margin.amount).replace(/\.\d+$/, "")})</span>
                    </>
                  ) : (
                    ""
                  )}
                </td>
                <td className="py-2 text-right">
                  <Link to={link(p)} className="inline-flex items-center gap-1 text-xs font-semibold text-accent-600 hover:underline">
                    Orders <ArrowRight className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-gray-500">
          {products.length.toLocaleString()} products, most delivered first{products.length > 25 ? " (top 25 shown)" : ""}. Margins
          need {MIN_DECIDED_TO_RATE} decided orders and a cost on {Math.round(100 * MIN_COSTED_LINE_SHARE)}% of delivered lines; a returned order counts against every product in it.
          {withAds ? " Ad spend is Financify's allocation per product, charged to decided orders in proportion." : ""}
        </p>
      </div>
    </div>
  );
}

// ── City × courier ─────────────────────────────────────────────────────────

const RATE_STEPS = ["bg-coral-200", "bg-coral-100", "bg-gray-100", "bg-mint-100", "bg-mint-200"];

/** A city row of the shipping view, already named for display. */
export type CityRow = {
  key: string;
  name: string;
  other: boolean;
  orders: number;
  deliveryRate: DeliveryRate;
};

/**
 * Delivery rate by city: every courier together, or one column per courier.
 * Both views list the same rows, so switching never moves a city.
 */
export function CityDeliveryTable({
  rows,
  matrix,
  cityCount,
  min,
  courier,
  picked,
  link,
  initialView = "all",
}: {
  rows: CityRow[];
  matrix: CityCourierMatrix;
  cityCount: number;
  min: number;
  /** The courier the page is filtered to, if any. */
  courier: string | null;
  picked: (key: string) => boolean;
  link: (path: string, set: { courier?: string; city?: string }) => string;
  initialView?: "all" | "courier";
}) {
  const [view, setView] = useState(initialView);
  const byCourier = view === "courier" && matrix.couriers.length > 0;
  const rates = matrix.cities.flatMap((c) => Object.values(c.cells).map((x) => x.rate)).filter((r): r is number => r !== null);
  const mid = rates.length ? [...rates].sort((a, b) => a - b)[Math.floor(rates.length / 2)]! : 0;
  // Diverging around the median cell: coral below, mint above, grey near it.
  const step = (r: number) => RATE_STEPS[r - mid <= -10 ? 0 : r - mid <= -3 ? 1 : r - mid < 3 ? 2 : r - mid < 10 ? 3 : 4];
  const cells = new Map(matrix.cities.map((c) => [c.city, c.cells]));
  const decided = (r: CityRow) => r.deliveryRate.delivered + r.deliveryRate.returned;
  const rate = (r: CityRow) =>
    decided(r) >= min ? <DeliveryRateText rate={r.deliveryRate} /> : <span className="text-gray-500">{r.deliveryRate.stillOpen.toLocaleString()} still in transit</span>;

  return (
    <div className="rounded-2xl bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-bold text-gray-900">
          Delivery rate by city{courier ? ` for ${scopeLabel(courier)}` : ""}
        </h2>
        {matrix.couriers.length > 1 ? (
          <nav aria-label="Show couriers" className="inline-flex rounded-full bg-field p-1 text-sm font-semibold">
            {(
              [
                ["all", "All couriers"],
                ["courier", "By courier"],
              ] as const
            ).map(([key, label]) => (
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
        {byCourier
          ? `Each courier's delivery rate in each city. Coral cells deliver worse than the typical cell (${mid.toFixed(1)}%), mint better. Pick a cell for its orders.`
          : "Every courier together. Pick a city to see its couriers."}
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className={`min-w-full text-sm ${byCourier ? "border-separate border-spacing-[2px]" : ""}`}>
          <thead className={`text-left text-xs font-semibold text-gray-500 ${byCourier ? "" : "border-b border-gray-100"}`}>
            <tr>
              <th className="py-2 pr-4">City</th>
              <th className="py-2 pr-4 text-right">Orders</th>
              {byCourier ? (
                <>
                  <th className="py-2 pr-4">All couriers</th>
                  {matrix.couriers.map((c) => (
                    <th key={c} className="px-2 py-2 text-center">
                      {scopeLabel(c)}
                      {c.startsWith("financify:") ? <span className="block font-normal text-gray-400">named by Financify</span> : null}
                    </th>
                  ))}
                </>
              ) : (
                <>
                  <th className="py-2 pr-4 text-right">Decided</th>
                  <th className="py-2 pr-4">Delivery</th>
                  <th className="py-2"><span className="sr-only">Orders</span></th>
                </>
              )}
            </tr>
          </thead>
          <tbody className={byCourier ? undefined : "divide-y divide-gray-100"}>
            {rows.map((r) => (
              <tr key={r.key} className={picked(r.key) ? "bg-mint-50" : undefined}>
                <td className="whitespace-nowrap py-2 pr-4 font-medium text-gray-900">
                  {r.other || picked(r.key) ? (
                    <span className={r.other ? "font-normal text-gray-500" : undefined}>{r.name}</span>
                  ) : (
                    <Link to={link("/shipping", { city: r.key })} preventScrollReset className="hover:underline">
                      {r.name}
                    </Link>
                  )}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{r.orders.toLocaleString()}</td>
                {byCourier ? (
                  <>
                    <td className="whitespace-nowrap py-2 pr-4">{rate(r)}</td>
                    {matrix.couriers.map((c) => {
                      const cell = cells.get(r.key)?.[c];
                      if (r.other || !cell?.orders) return <td key={c} />;
                      const title = `${r.name} · ${scopeLabel(c)}: ${cell.delivered} delivered of ${cell.decided} decided, ${cell.orders} orders`;
                      return (
                        <td key={c} className={`rounded-md text-center ${cell.rate === null ? "bg-field" : step(cell.rate)}`}>
                          <Link to={link("/orders", { city: r.key, courier: c })} title={title} className="block px-2 py-2 hover:underline">
                            {cell.rate === null ? (
                              <span className="text-xs text-gray-500">{cell.decided} decided</span>
                            ) : (
                              <>
                                <span className="block font-semibold tabular-nums text-gray-900">{cell.rate.toFixed(1)}%</span>
                                <span className="block text-[11px] tabular-nums text-gray-600">{cell.decided} decided</span>
                              </>
                            )}
                          </Link>
                        </td>
                      );
                    })}
                  </>
                ) : (
                  <>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-500">{decided(r).toLocaleString()}</td>
                    <td className="py-2 pr-4">{rate(r)}</td>
                    <td className="py-2 text-right">
                      {r.other ? null : (
                        <Link to={link("/orders", { city: r.key })} className="inline-flex items-center gap-1 text-xs font-semibold text-accent-600 hover:underline">
                          Orders <ArrowRight className="h-3 w-3" />
                        </Link>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500">
        {cityCount.toLocaleString()} {cityCount === 1 ? "city" : "cities"}, by order date. Rates need {min} decided orders
        {byCourier ? ", in a cell as in a row" : ""}; smaller cities are added up in one row. Cities use Courierify&apos;s mapping.
      </p>
    </div>
  );
}

// ── Channel × courier ──────────────────────────────────────────────────────

const CHANNEL: Record<string, string> = {
  none: "No campaign",
  affiliate: "Affiliate",
  unknown: "Not known to Financify",
};
const channelName = (c: string) => CHANNEL[c] ?? platformName(c);

export function ChannelCourierTable({ matrix, min }: { matrix: ChannelCourierMatrix; min: number }) {
  const rates = matrix.channels.flatMap((c) => Object.values(c.cells).map((x) => x.rate)).filter((r): r is number => r !== null);
  // Nothing to compare without at least two rated cells.
  if (rates.length < 2 || !matrix.couriers.length) return null;
  const mid = [...rates].sort((a, b) => a - b)[Math.floor(rates.length / 2)]!;
  const step = (r: number) => RATE_STEPS[r - mid <= -10 ? 0 : r - mid <= -3 ? 1 : r - mid < 3 ? 2 : r - mid < 10 ? 3 : 4];
  const couriers = matrix.couriers.filter((c) => matrix.channels.some((ch) => ch.cells[c]!.orders > 0));
  const rate = (cell: MatrixCell) =>
    cell.rate === null ? (
      <span className="text-xs text-gray-500">{cell.decided} decided</span>
    ) : (
      <>
        <span className="block font-semibold tabular-nums text-gray-900">{cell.rate.toFixed(1)}%</span>
        <span className="block text-[11px] tabular-nums text-gray-600">{cell.decided} decided</span>
      </>
    );
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Delivery rate by channel and courier</h2>
      <p className="mt-1 text-sm text-gray-600">
        Where each order came from, as Financify ties it to an ad platform, against the courier that carried it. Coral
        cells deliver worse than the typical cell ({mid.toFixed(1)}%), mint better.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-[2px] text-sm">
          <thead className="text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Channel</th>
              <th className="py-2 pr-4 text-right">Orders</th>
              <th className="px-2 py-2 text-center">All couriers</th>
              {couriers.map((c) => (
                <th key={c} className="px-2 py-2 text-center">
                  {scopeLabel(c)}
                  {c.startsWith("financify:") ? <span className="block font-normal text-gray-400">named by Financify</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.channels.map((row) => (
              <tr key={row.channel}>
                <td className="whitespace-nowrap py-2 pr-4 font-medium text-gray-900">{channelName(row.channel)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{row.orders.toLocaleString()}</td>
                <td className="rounded-md bg-field px-2 py-2 text-center">{rate(row.all)}</td>
                {couriers.map((c) => {
                  const cell = row.cells[c]!;
                  if (!cell.orders) return <td key={c} />;
                  return (
                    <td
                      key={c}
                      title={`${channelName(row.channel)} · ${scopeLabel(c)}: ${cell.delivered} delivered of ${cell.decided} decided, ${cell.orders} orders`}
                      className={`rounded-md px-2 py-2 text-center ${cell.rate === null ? "bg-field" : step(cell.rate)}`}
                    >
                      {rate(cell)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        By order date. A cell needs {min} decided orders for a rate. No campaign means organic, direct or untagged; a
        channel that is worse with every courier is the channel, not the courier.
      </p>
    </div>
  );
}

// ── Payout ageing ──────────────────────────────────────────────────────────

export function PayoutAgeingTable({ ageing }: { ageing: PayoutAgeing }) {
  const amount = (a: string) => formatAmount(a).replace(/\.\d+$/, "");
  return (
    <div className="overflow-x-auto rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">COD delivered, not yet paid, by age</h2>
      <p className="mt-1 text-sm text-gray-600">
        {amount(ageing.total.amount)} {ageing.currency} across {ageing.orders.toLocaleString()} delivered orders with no courier
        payout recorded, from couriers whose payouts Courierify records, as of today, by days since delivery. Pick a cell
        for its orders.
      </p>
      {ageing.orders ? (
        <table className="mt-4 min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Courier</th>
              {ageing.buckets.map((b) => (
                <th key={b.key} className="px-2 py-2 text-right">{b.label}</th>
              ))}
              <th className="py-2 pl-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {ageing.couriers.map((c) => (
              <tr key={c.courier}>
                <td className="py-2 pr-4 font-medium text-gray-900">
                  {scopeLabel(c.courier)}
                  {c.paidBy ? <span className="block text-xs font-normal text-gray-500">paid by {c.paidBy === "orio" ? "Orio" : c.paidBy}</span> : null}
                </td>
                {ageing.buckets.map((b) => {
                  const cell = c.cells[b.key]!;
                  const old = b.key === "31-60" || b.key === "61+";
                  return (
                    <td key={b.key} className="px-2 py-2 text-right">
                      {cell.orders ? (
                        <Link
                          to={`/orders?unpaid=${encodeURIComponent(c.courier)}&age=${b.key}`}
                          title={`${cell.orders} orders`}
                          className={`tabular-nums hover:underline ${old ? "font-semibold text-coral-700" : "text-gray-900"}`}
                        >
                          {amount(cell.amount.amount)}
                          <span className="block text-[11px] font-normal text-gray-500">{cell.orders.toLocaleString()} orders</span>
                        </Link>
                      ) : null}
                    </td>
                  );
                })}
                <td className="py-2 pl-2 text-right font-semibold tabular-nums text-gray-900">
                  {amount(c.total.amount)}
                  <span className="block text-[11px] font-normal text-gray-500">{c.orders.toLocaleString()} orders</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {ageing.untracked.length ? (
        <div className="mt-4 rounded-xl bg-field p-4 text-sm text-gray-700">
          <p className="font-semibold text-gray-900">Couriers whose payouts Courierify has never recorded</p>
          <ul className="mt-2 space-y-1">
            {ageing.untracked.map((u) => (
              <li key={u.courier}>
                <Link to={`/orders?unpaid=${encodeURIComponent(u.courier)}`} className="hover:underline">
                  <span className="font-medium">{scopeLabel(u.courier)}</span>: {amount(u.total.amount)} {ageing.currency} across{" "}
                  {u.orders.toLocaleString()} delivered orders
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">
            Not counted as owed: with no settlement on record, an unpaid parcel and a paid one look the same.
          </p>
        </div>
      ) : null}
      {ageing.otherCurrencies.length ? (
        <p className="mt-3 text-xs text-gray-500">
          Also unpaid, not converted: {ageing.otherCurrencies.map((m) => `${formatAmount(m.amount)} ${m.currency}`).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

// ── Confirmation funnel ────────────────────────────────────────────────────

export function ConfirmationFunnelView({
  funnel,
  period,
  scope,
  active,
  min,
}: {
  funnel: ConfirmationFunnel;
  period: string;
  scope: string;
  active: string | null;
  min: number;
}) {
  const total = funnel.total;
  const top = Math.max(1, total.orders);
  const step = (key: string) => funnel.steps.find((s) => s.key === key)?.orders ?? 0;
  const base = `/orders?${period}${scope ? `&${scope}` : ""}`;
  return (
    <div className="overflow-x-auto rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">From order to outcome, by confirmation</h2>
      <p className="mt-1 text-sm text-gray-600">
        {total.orders.toLocaleString()} orders placed in this period; {step("attempted").toLocaleString()} sent for confirmation,{" "}
        {step("confirmed").toLocaleString()} confirmed. Pick a row for its orders.
      </p>
      <table className="mt-4 min-w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
          <tr>
            <th className="py-2 pr-4">Confirmation</th>
            <th className="py-2 pr-4">Orders</th>
            <th className="py-2 pr-4 text-right">Shipped</th>
            <th className="py-2 pr-4 text-right">Delivered</th>
            <th className="py-2 pr-4 text-right">Returned</th>
            <th className="py-2 text-right">Return rate</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {[total, ...funnel.states].map((s) => {
            const all = s.state === "all";
            const picked = all ? active === null : active === s.state;
            return (
              <tr key={s.state} className={`${picked && active !== null ? "bg-mint-50" : ""} ${all ? "font-semibold" : ""}`}>
                <td className="whitespace-nowrap py-2 pr-4 text-gray-900">
                  {picked ? (
                    s.label
                  ) : (
                    <Link to={all ? base : `${base}&confirmation=${s.state}`} preventScrollReset className={all ? "hover:underline" : "font-medium hover:underline"}>
                      {s.label}
                    </Link>
                  )}
                </td>
                <td className="py-2 pr-4">
                  <span className="grid grid-cols-[3.5rem_1fr] items-center gap-2">
                    <span className="text-right tabular-nums text-gray-900">{s.orders.toLocaleString()}</span>
                    <span className="h-2 min-w-16 rounded-sm bg-field">
                      <span className={`block h-2 rounded-sm ${all ? "bg-navy" : "bg-data-700"}`} style={{ width: `${(100 * s.orders) / top}%` }} />
                    </span>
                  </span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{s.shipped.toLocaleString()}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{s.delivered.toLocaleString()}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{s.returned.toLocaleString()}</td>
                <td className="py-2 text-right tabular-nums text-gray-900">
                  {s.returnRate === null ? (
                    <span className="font-normal text-gray-500">{s.decided ? `${s.decided} decided` : "—"}</span>
                  ) : (
                    <span className="font-semibold">{s.returnRate.toFixed(1)}%</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-gray-500">
        Shipped is every order handed to a courier, confirmed or not, including those still in transit. Delivered and returned
        leave out orders whose outcome can&apos;t be tracked (see coverage), so they can be lower than the outcome filters below.
        Return rate is returned ÷ (delivered + returned); under {min} of those it is left out.
      </p>
    </div>
  );
}

// ── Campaigns (D5) ─────────────────────────────────────────────────────────

const PLATFORM: Record<string, string> = { facebook: "Meta", tiktok: "TikTok", google: "Google", snapchat: "Snapchat" };
const platformName = (p: string) => PLATFORM[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

export function CampaignTable({ data, compared }: { data: CampaignSpend; compared: boolean }) {
  const amount = (a: string) => formatAmount(a).replace(/\.\d+$/, "");
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Where the ad money went</h2>
      <p className="mt-1 text-sm text-gray-600">
        {amount(data.total.amount)} {data.currency} across {data.campaigns.length.toLocaleString()} campaigns, plus{" "}
        {amount(data.fees.amount)} in platform fees, by ad-platform day as the platforms reported it.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {data.platforms.map((p) => (
          <span key={p.platform} className="rounded-full bg-field px-3 py-1.5 text-sm">
            <span className="font-semibold text-gray-900">{platformName(p.platform)}</span>{" "}
            <span className="tabular-nums text-gray-700">
              {amount(p.spend.amount)} · {p.share.toFixed(1)}% · {p.campaigns} {p.campaigns === 1 ? "campaign" : "campaigns"}
            </span>
          </span>
        ))}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Campaign</th>
              <th className="py-2 pr-4">Platform</th>
              <th className="py-2 pr-4 text-right">Spend</th>
              <th className="py-2 pr-4 text-right">Share</th>
              <th className="py-2 pr-4 text-right">Days running</th>
              <th className="py-2 text-right">{compared ? "Against previous period" : ""}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.campaigns.slice(0, 20).map((c) => (
              <tr key={c.key}>
                <td className="max-w-sm truncate py-2 pr-4 font-medium text-gray-900" title={c.name}>{c.name}</td>
                <td className="py-2 pr-4 text-gray-600">{platformName(c.platform)}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{amount(c.spend.amount)}</td>
                <td className="py-2 pr-4">
                  <span className="flex items-center justify-end gap-2">
                    <span className="h-2 w-16 rounded-sm bg-field">
                      <span className="block h-2 rounded-sm bg-data-700" style={{ width: `${Math.min(100, (100 * c.share) / Math.max(1, data.campaigns[0]!.share))}%` }} />
                    </span>
                    <span className="w-12 text-right tabular-nums text-gray-700">{c.share.toFixed(1)}%</span>
                  </span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{c.daysWithSpend}</td>
                <td className="py-2 text-right">
                  {compared ? c.change.previous === null ? <span className="text-xs text-gray-500">new</span> : <Change h={{ delta: c.change, trend: null, good: "neutral" }} kind="money" /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.campaigns.length > 20 ? (
          <p className="mt-2 text-xs text-gray-500">Top 20 of {data.campaigns.length.toLocaleString()} campaigns by spend.</p>
        ) : null}
      </div>
    </div>
  );
}

// ── Campaign outcomes (Phase 4c, step 3) ───────────────────────────────────

/**
 * Spend beside what each campaign's orders did. Return rate is the column no
 * other app in the suite can show: a campaign can read well on ROAS and send
 * back half its parcels. A rate is drawn only from 20 decided orders; a row
 * returning 10+ points above the store is marked.
 */
export function CampaignOutcomesTable({ data, spend }: { data: CampaignOutcomes; spend: CampaignSpend | null }) {
  const amount = (a: string) => formatAmount(a).replace(/\.\d+$/, "");
  const store = data.storeReturnRate;
  const high = (r: number | null) => r !== null && store !== null && r - store >= 10;
  const shown = data.campaigns.filter((c) => c.orders > 0 || c.spend);
  const flagged = shown.filter((c) => high(c.returnRate));
  const untied = data.unattributed.untracked + data.unattributed.affiliate + data.unattributed.noRecord;
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">What each campaign brought back</h2>
      <p className="mt-1 text-sm text-gray-600">
        {spend ? `${amount(spend.total.amount)} ${spend.currency} across ${spend.campaigns.length} campaigns, plus ${amount(spend.fees.amount)} in platform fees. ` : ""}
        Orders are tied to campaigns by Financify ({data.matched.toLocaleString()} of {data.of.toLocaleString()} this period); outcomes
        are Growzar&apos;s. ROAS is delivered revenue ÷ spend and fees.
        {flagged.length
          ? ` ${flagged.length} ${flagged.length === 1 ? "campaign returns" : "campaigns return"} 10+ points more than the store's ${store!.toFixed(1)}%.`
          : ""}
      </p>
      {spend ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {spend.platforms.map((p) => (
            <span key={p.platform} className="rounded-full bg-field px-3 py-1.5 text-sm">
              <span className="font-semibold text-gray-900">{platformName(p.platform)}</span>{" "}
              <span className="tabular-nums text-gray-700">
                {amount(p.spend.amount)} · {p.share.toFixed(1)}%
              </span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Campaign</th>
              <th className="py-2 pr-4 text-right">Spend</th>
              <th className="py-2 pr-4 text-right">Orders</th>
              <th className="py-2 pr-4 text-right">Delivered</th>
              <th className="py-2 pr-4 text-right">Returned</th>
              <th className="py-2 pr-4 text-right">Delivered revenue</th>
              <th className="py-2 pr-4 text-right">ROAS</th>
              <th className="py-2 text-right">Cost per delivered</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {shown.slice(0, 25).map((c) => (
              <tr key={c.key} className={high(c.returnRate) ? "bg-coral-50" : undefined}>
                <td className="max-w-xs py-2 pr-4">
                  <span className="block truncate font-medium text-gray-900" title={c.name}>{c.name}</span>
                  <span className="text-xs text-gray-500">
                    {platformName(c.platform)}
                    {c.byName && !c.byId ? " · tied by name" : ""}
                  </span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{c.spend ? amount(c.spend.amount) : <span className="text-xs text-gray-500">none this period</span>}</td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {c.orders || ""}
                  {c.stillOpen ? <span className="block text-xs text-gray-500">{c.stillOpen} open</span> : null}
                  {c.notTrackable ? <span className="block text-xs text-gray-500">{c.notTrackable} not trackable</span> : null}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{c.delivered || ""}</td>
                <td className={`py-2 pr-4 text-right tabular-nums ${high(c.returnRate) ? "font-semibold text-coral-700" : ""}`}>
                  {c.returnRate !== null ? `${c.returnRate.toFixed(1)}%` : c.returned ? c.returned : ""}
                  {c.decided ? <span className="block text-xs font-normal text-gray-500">{c.returned} of {c.decided}</span> : null}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{c.delivered ? amount(c.deliveredRevenue.amount) : ""}</td>
                <td className="py-2 pr-4 text-right font-semibold tabular-nums">
                  {c.roas !== null ? c.roas.toFixed(2) : c.spend && c.notTrackable ? <span className="text-xs font-normal text-gray-500">can&apos;t tell</span> : ""}
                </td>
                <td className="py-2 text-right tabular-nums">{c.costPerDelivered ? amount(c.costPerDelivered.amount) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-gray-500">
          {shown.length > 25 ? `Top 25 of ${shown.length} campaigns by spend. ` : ""}
          {untied
            ? `${untied.toLocaleString()} orders this period are tied to no campaign (${[
                data.unattributed.untracked ? `${data.unattributed.untracked} organic, direct or untagged` : "",
                data.unattributed.affiliate ? `${data.unattributed.affiliate} affiliate` : "",
                data.unattributed.noRecord ? `${data.unattributed.noRecord} with no record yet` : "",
              ]
                .filter(Boolean)
                .join(", ")}). `
            : ""}
          Return rates need 20 decided orders; recent campaigns read low on ROAS until their orders deliver. &ldquo;Can&apos;t
          tell&rdquo;: over 20% of the campaign&apos;s orders went with a courier no app tracks, so its deliveries are never counted.
        </p>
      </div>
    </div>
  );
}
