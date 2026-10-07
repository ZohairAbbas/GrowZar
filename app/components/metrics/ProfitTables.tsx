import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";

import type { FinanceDepth } from "~/lib/metrics/screens.server";
import { formatAmount } from "./Metrics";
import { scopeLabel } from "./FilterBar";

/**
 * Profit by product, city, courier and campaign (Phase 4c). Each tab adds up
 * to the headline profit after returns; ad spend no row could take is a row
 * of its own, never dropped.
 */
const TABS = [
  { key: "product", label: "Products", one: "Product" },
  { key: "city", label: "Cities", one: "City" },
  { key: "courier", label: "Couriers", one: "Courier" },
  { key: "campaign", label: "Campaigns", one: "Campaign" },
] as const;

const BASIS: Record<string, string> = {
  allocated: "Ad spend is Financify's allocation per product, with platform fees; what it could not tie to a product is its own row.",
  campaign: "Ad spend is each campaign's own spend and fees; spend the platforms did not split by campaign is its own row.",
  delivered_share: "Ad platforms do not report by city or courier, so ad spend is shared by each row's share of delivered revenue.",
  none: "Ad spend is not subtracted for this period (not every day is fetched, or a courier or city is picked).",
};

const signed = (amount: string) => {
  const n = Number(amount);
  // Anything that rounds to a whole zero reads "0", never "−0".
  if (Math.abs(n) < 0.5) return "0";
  const whole = formatAmount(amount.replace(/^-/, "")).replace(/\.\d+$/, "");
  return n < 0 ? `−${whole}` : whole;
};

export function ProfitTables({
  data,
  labels,
  images,
  days,
  scope,
  initialTab = "product",
}: {
  initialTab?: (typeof TABS)[number]["key"];
  data: NonNullable<FinanceDepth["profitBy"]>;
  labels: Record<string, string>;
  images: Record<string, string>;
  days: number;
  scope: string;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>(initialTab);
  const table = data[tab];
  const name = (key: string) => (tab === "city" || tab === "courier" ? scopeLabel(key) : (labels[key] ?? key));
  const link = (key: string) => {
    const base = `/orders?days=${days}${scope ? `&${scope}` : ""}`;
    if (tab === "city") return `${base}&city=${encodeURIComponent(key)}`;
    if (tab === "courier") return `${base}&courier=${encodeURIComponent(key)}`;
    if (tab === "product" && /^\d+$/.test(key)) return `${base}&variant=${key}`;
    return null;
  };
  const losing = table.rows.filter((r) => r.kind === "row" && Number(r.profit.amount) < 0).length;
  return (
    <div className="rounded-2xl bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-bold text-gray-900">Profit by {TABS.find((t) => t.key === tab)!.label.toLowerCase()}</h2>
        <nav aria-label="Profit by" className="inline-flex rounded-full bg-field p-1 text-sm font-semibold">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className={`rounded-full px-3 py-1 ${tab === t.key ? "bg-navy text-white" : "text-gray-600 hover:text-gray-900"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      <p className="mt-1 text-sm text-gray-600">
        Each row&apos;s own delivered revenue and costs, and its share of ad spend; the rows add up to the profit above.
        {losing ? ` ${losing} of the rows shown lose money.` : ""}
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">{TABS.find((t) => t.key === tab)!.one}</th>
              <th className="py-2 pr-4 text-right">Orders</th>
              <th className="py-2 pr-4 text-right">Delivered sales</th>
              <th className="py-2 pr-4 text-right">Product cost</th>
              <th className="py-2 pr-4 text-right">Courier fees</th>
              <th className="py-2 pr-4 text-right">Other costs</th>
              <th className="py-2 pr-4 text-right">Ads</th>
              <th className="py-2 pr-4 text-right">Profit</th>
              <th className="py-2 pr-4 text-right">Margin</th>
              <th className="py-2 pr-4 text-right">Returned</th>
              <th className="py-2"><span className="sr-only">Orders</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {table.rows.map((r) => {
              const loss = Number(r.profit.amount) < 0;
              const to = r.kind === "row" ? link(r.key) : null;
              return (
                <tr key={`${r.kind}-${r.key}`} className={r.kind !== "row" ? "text-gray-500" : undefined}>
                  <td className="max-w-xs py-2 pr-4">
                    <span className="flex items-center gap-2.5">
                      {tab === "product" && r.kind === "row" ? (
                        images[r.key] ? (
                          <img src={`${images[r.key]}${images[r.key]!.includes("?") ? "&" : "?"}width=64`} alt="" width={28} height={28} loading="lazy" className="h-7 w-7 flex-shrink-0 rounded-md bg-field object-cover" />
                        ) : (
                          <span className="h-7 w-7 flex-shrink-0 rounded-md bg-field" aria-hidden="true" />
                        )
                      ) : null}
                      <span className={`truncate ${r.kind === "row" ? "font-medium text-gray-900" : ""}`} title={r.kind === "row" ? name(r.key) : undefined}>
                        {r.kind === "rest" ? `${r.folded} more` : r.kind === "ads" ? r.key : name(r.key)}
                      </span>
                      {r.kind === "row" && r.key.startsWith("financify:") ? <span className="text-xs text-gray-400">(Financify)</span> : null}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{r.orders || ""}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{signed(r.revenue.amount)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{signed(`-${r.productCost.amount}`)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{signed(`-${r.courierFees.amount}`)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{signed(`-${r.otherCosts.amount}`)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{signed(`-${r.ads.amount}`)}</td>
                  <td className={`py-2 pr-4 text-right font-semibold tabular-nums ${loss ? "text-coral-700" : "text-gray-900"}`}>{signed(r.profit.amount)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{r.margin === null ? "" : `${r.margin.toFixed(1)}%`}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {r.returnRate === null ? (r.returned ? r.returned : "") : `${r.returnRate.toFixed(1)}%`}
                  </td>
                  <td className="py-2 text-right">
                    {to ? (
                      <Link to={to} className="inline-flex items-center gap-1 text-xs font-semibold text-accent-600 hover:underline">
                        Orders <ArrowRight className="h-3 w-3" />
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-gray-200">
            <tr>
              <td className="py-2 pr-4 font-semibold text-gray-900" colSpan={7}>
                Total, the same as profit after returns
              </td>
              <td className={`py-2 pr-4 text-right font-bold tabular-nums ${Number(table.total.amount) < 0 ? "text-coral-700" : "text-gray-900"}`}>
                {signed(table.total.amount)}
              </td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        {BASIS[table.adBasis]} An order with several products is split by line value (product cost by line cost). Margin and
        return rate need 20 decided orders. {table.dimension === "campaign" ? "Orders are tied to campaigns by Financify." : ""}
      </p>
    </div>
  );
}
