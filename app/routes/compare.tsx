import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/compare";
import { prisma } from "~/lib/db.server";
import { hasPermission, listVisibleStores, requireSection } from "~/lib/authorize.server";
import { PERIODS, storeComparison } from "~/lib/metrics/screens.server";
import { Change, PeriodPicker, formatAmount } from "~/components/metrics/Metrics";

export function meta() {
  return [{ title: "Compare stores · Growzar" }];
}

/**
 * Store versus store (Phase 4b, D5): the same metrics side by side for every
 * store the viewer may see, each over its own local days, money in the
 * organization's base currency at each order day's rate, rates shown.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "home", "view");
  const visible = await listVisibleStores(viewer);
  const [org, stores, canSeeMoney] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: viewer.organizationId }, select: { name: true, baseCurrency: true } }),
    prisma.store.findMany({
      where: { id: { in: visible.map((s) => s.id) } },
      select: { id: true, displayName: true, shopDomain: true, timezone: true },
      orderBy: { shopDomain: "asc" },
    }),
    hasPermission(request, viewer.organizationId, "finance", "view"),
  ]);
  const comparison = await storeComparison(stores, org.baseCurrency, url);
  return { organization: org.name, canSeeMoney, periods: PERIODS, ...comparison };
}

const pct = (v: number | null) => (v === null ? "" : `${v.toFixed(1)}%`);
const whole = (m: { amount: string; currency: string } | null | undefined) =>
  m ? `${formatAmount(m.amount).replace(/\.\d+$/, "")} ${m.currency}` : "";

export default function Compare({ loaderData }: Route.ComponentProps) {
  const { organization, canSeeMoney, periods, base, period, columns } = loaderData;
  const rows: Array<{ label: string; note?: string; cell: (c: (typeof columns)[number]) => ReactNode; money?: boolean }> = [
    {
      label: "Orders placed",
      cell: (c) => (
        <>
          <span className="block font-semibold">{c.orders.toLocaleString()}</span>
          <Change h={{ delta: c.ordersChange, trend: null, good: "up" }} />
        </>
      ),
    },
    { label: "Delivered orders", cell: (c) => c.delivered.toLocaleString() },
    { label: "Decided orders", note: "delivered + returned", cell: (c) => c.decided.toLocaleString() },
    { label: "Still in transit", cell: (c) => c.stillOpen.toLocaleString() },
    { label: "Delivery rate", note: "needs 20 decided orders", cell: (c) => pct(c.deliveryRate) },
    { label: "Return rate", cell: (c) => pct(c.returnRate) },
    { label: "Shipped through Courierify", cell: (c) => pct(c.courierifyShare) },
    { label: `Placed revenue, ${base}`, money: true, cell: (c) => whole(c.placed?.total) },
    { label: `Delivered revenue, ${base}`, money: true, cell: (c) => whole(c.deliveredRevenue?.total) },
    { label: "Ad spend", note: "store currency, ad-platform days", money: true, cell: (c) => (c.adSpend ? c.adSpend.map(whole).join(" + ") : "") },
    {
      label: "Profit after returns",
      note: "store currency",
      money: true,
      cell: (c) => (c.profit ? whole({ amount: c.profit.amount, currency: c.profit.currency }) : ""),
    },
    { label: "ROAS", note: "delivered revenue ÷ ad spend", money: true, cell: (c) => (c.roas === null ? "" : c.roas.toFixed(2)) },
  ];
  const rates = columns.flatMap((c) => [...(c.placed?.ratesUsed ?? []), ...(c.deliveredRevenue?.ratesUsed ?? [])]);
  const unconverted = columns.flatMap((c) =>
    [...(c.placed?.unconverted ?? [])].map((u) => `${c.name}: ${formatAmount(u.money.amount)} ${u.money.currency}`),
  );
  const foreign = columns.filter((c) => c.currency && c.currency !== base).map((c) => `${c.name} (${c.currency})`);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-gray-900">Compare stores</h1>
          <p className="mt-1 text-gray-600">
            {organization}: the same numbers for each store,{" "}
            {period.custom ? `from ${period.from} to ${period.to}, in each store's own days.` : `over each store's own last ${period.days} days.`}
          </p>
        </div>
        <PeriodPicker period={period} options={periods} />
      </header>

      {columns.length < 2 ? (
        <p className="rounded-2xl bg-white p-6 text-sm text-gray-600">
          Comparison needs two stores; you can see {columns.length}. <Link to="/home" className="font-semibold text-accent-600">Back to Home</Link>
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
              <tr>
                <th className="px-5 py-3">Metric</th>
                {columns.map((c) => (
                  <th key={c.storeId} className="px-5 py-3 text-right">
                    <span className="block text-gray-900">{c.name}</span>
                    <span className="font-normal">{c.period.from} to {c.period.to}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows
                .filter((r) => canSeeMoney || !r.money)
                .map((r) => (
                  <tr key={r.label}>
                    <td className="px-5 py-3 font-medium text-gray-900">
                      {r.label}
                      {r.note ? <span className="block text-xs font-normal text-gray-500">{r.note}</span> : null}
                    </td>
                    {columns.map((c) => (
                      <td key={c.storeId} className="px-5 py-3 text-right tabular-nums text-gray-900">
                        {r.cell(c)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
          {canSeeMoney ? (
            <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">
              Revenue in {base}, the organization&apos;s currency
              {rates.length
                ? `, converted at each order day's rate from Financify (${rates.length} daily rates, e.g. 1 ${rates[0]!.from} = ${rates[0]!.rate} ${base} on ${rates[0]!.day})`
                : foreign.length
                  ? ""
                  : `; every store already sells in ${base}, so nothing is converted`}
              .{foreign.length ? ` Profit and ad spend stay in each store's own currency: ${foreign.join(", ")}.` : ""}
              {unconverted.length ? ` Not converted (no rate for the day): ${unconverted.join("; ")}.` : ""}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
